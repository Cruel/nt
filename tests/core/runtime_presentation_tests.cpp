#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/room_presentation.hpp>
#include <noveltea/core/runtime_presentation.hpp>
#include <noveltea/core/session_state.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <fstream>
#include <iterator>
#include <string>
#include <tuple>
#include <type_traits>

using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;

namespace {
template<class Id> Id id(const char* value) { return std::move(Id::create(value)).value(); }

CompiledProject fixture()
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/scene-program.json");
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)), {});
    auto decoded = decode_compiled_project(nlohmann::json::parse(source), "scene-program.json");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

ResolvedRoomPresentation resolve_room(const CompiledProject& project, const SessionState& state)
{
    REQUIRE(state.room_visit());
    RoomPresentationResolver resolver;
    auto resolved = resolver.resolve(
        project, state, *state.room_visit(),
        [](const Condition&) { return Result<bool, Diagnostics>::success(true); },
        [](const TextSource& source) {
            return Result<std::string, Diagnostics>::success(std::visit(
                [](const auto& value) -> std::string {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, LuaTextExpression>)
                        return value.source;
                    else
                        return value.value;
                },
                source));
        });
    REQUIRE(resolved);
    return std::move(resolved).value().presentation;
}

SessionState representative_state(const CompiledProject& project)
{
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
    REQUIRE(state.move_character(
        project, id<CharacterId>("hero"),
        compiled::RoomPlacementRef{id<RoomId>("start"), id<RoomPlacementId>("key-placement")}));
    const auto& scene_frame = std::get<SceneFrame>(state.flow_stack().back());
    const ScenePresentationOwner scene_owner{scene_frame.frame_id, scene_frame.scene};
    REQUIRE(state.set_background(
        project, compiled::BackgroundPresentation{id<AssetId>("image-main"), "#112233",
                                                  compiled::BackgroundFit::Cover,
                                                  id<MaterialId>("sprite-material")}));
    REQUIRE(state.set_actor(
        project, DesiredActorPresentation{SceneActorKey{scene_owner, id<ActorSlotId>("hero-slot")},
                                          scene_owner,
                                          id<CharacterId>("hero"),
                                          id<CharacterPoseId>("default"),
                                          id<CharacterExpressionId>("neutral"),
                                          std::nullopt,
                                          {},
                                          true,
                                          false}));
    REQUIRE(
        state.set_overlay(project, id<RoomId>("start"), id<RoomOverlayId>("start-overlay"), true));
    REQUIRE(state.set_layout(project, compiled::LayoutSlot::Hud, id<LayoutId>("hud-inline")));
    REQUIRE(state.upsert_presentation_prop(
        project, DesiredPresentationProp{id<PresentationPropInstanceId>("weather-vignette"),
                                         state.session_presentation_owner(),
                                         id<AssetId>("image-main"),
                                         id<MaterialId>("sprite-material"),
                                         std::nullopt,
                                         {0.0, 0.0, 1.0, 1.0},
                                         PresentationPlane::WorldOverlay,
                                         7,
                                         true}));
    REQUIRE(state.upsert_presentation_environment(
        project, DesiredPresentationEnvironment{id<PresentationEnvironmentInstanceId>("rain"),
                                                state.session_presentation_owner(),
                                                id<PresentationEnvironmentStopKey>("weather"),
                                                id<AssetId>("image-main"),
                                                id<MaterialId>("sprite-material"),
                                                {0.0, 0.0, 1.0, 1.0},
                                                PresentationPlane::WorldOverlay,
                                                8,
                                                LayoutClockDomain::Gameplay,
                                                {0.0, 0.25},
                                                0.75,
                                                true}));
    REQUIRE(state.present_text(
        project, PresentedTextState{id<CharacterId>("hero"), "Hello", TextMarkup::Plain}));
    REQUIRE(
        state.set_map_presentation(project, {id<MapId>("house"), compiled::InitialMapMode::FullMap,
                                             true, id<MapLocationId>("start-location")}));
    REQUIRE(state.set_audio_channel(
        project, {compiled::AudioChannel::Music, id<AssetId>("audio-voice"), 0.75, true, true}));
    return state;
}

const PresentationMountedLayout* find_layout(const RuntimePresentationSnapshot& snapshot,
                                             const MountedLayoutPresentationKey& key)
{
    const auto found = std::find_if(snapshot.layouts.begin(), snapshot.layouts.end(),
                                    [&key](const auto& value) { return value.key == key; });
    return found == snapshot.layouts.end() ? nullptr : &*found;
}
} // namespace

TEST_CASE("presentation projector assembles the complete effective target")
{
    const auto project = fixture();
    const auto state = representative_state(project);
    const auto room = resolve_room(project, state);
    auto projected = PresentationProjector::project(project, state, &room);
    REQUIRE(projected);
    const auto& snapshot = projected.value();
    CHECK(snapshot.revision.number() == 0);
    CHECK(snapshot.current_room == id<RoomId>("start"));
    REQUIRE(snapshot.background);
    CHECK(snapshot.background->asset == id<AssetId>("image-main"));
    CHECK(snapshot.background->color == "#112233");

    REQUIRE(snapshot.actors.size() == 2);
    const auto world_actor =
        std::find_if(snapshot.actors.begin(), snapshot.actors.end(), [](const auto& actor) {
            return std::holds_alternative<CharacterActorKey>(actor.key);
        });
    REQUIRE(world_actor != snapshot.actors.end());
    REQUIRE(world_actor->room_placement);
    REQUIRE(world_actor->room_bounds);
    CHECK(world_actor->room_placement->placement_id == id<RoomPlacementId>("key-placement"));
    CHECK(world_actor->pose_sprite == id<AssetId>("image-main"));
    const auto scene_actor =
        std::find_if(snapshot.actors.begin(), snapshot.actors.end(), [](const auto& actor) {
            return std::holds_alternative<SceneActorKey>(actor.key);
        });
    REQUIRE(scene_actor != snapshot.actors.end());
    CHECK(scene_actor->order == 1);

    REQUIRE(snapshot.interactables.size() == 1);
    CHECK(snapshot.interactables.front().interactable == id<InteractableId>("key"));
    CHECK(snapshot.interactables.front().placement.placement_id ==
          id<RoomPlacementId>("key-placement"));
    CHECK(snapshot.interactables.front().sprite == id<AssetId>("image-main"));
    CHECK(snapshot.props.size() == 1);
    CHECK(snapshot.environments.size() == 1);
    CHECK(snapshot.environments.front().stop_key == id<PresentationEnvironmentStopKey>("weather"));
    CHECK(snapshot.environments.front().scroll_per_second.y == 0.25);
    CHECK(snapshot.environments.front().opacity == 0.75);

    REQUIRE(snapshot.layouts.size() == 2);
    const auto* overlay =
        find_layout(snapshot, RoomOverlayLayoutMountKey{id<RoomId>("start"),
                                                        id<RoomOverlayId>("start-overlay")});
    REQUIRE(overlay);
    CHECK(overlay->layout == id<LayoutId>("hud-assets"));
    CHECK(overlay->policy.plane == PresentationPlane::WorldOverlay);
    CHECK(overlay->composition_group == PresentationCompositionGroup::World);
    const auto* hud = find_layout(snapshot, ReservedLayoutMountKey{compiled::LayoutSlot::Hud});
    REQUIRE(hud);
    CHECK(hud->layout == id<LayoutId>("hud-inline"));
    CHECK(hud->policy.plane == PresentationPlane::GameUi);

    REQUIRE(snapshot.text_and_choice.text);
    REQUIRE(snapshot.map);
    CHECK(snapshot.map->focused_location == id<MapLocationId>("start-location"));
    REQUIRE(snapshot.audio_channels.size() == 1);
}

TEST_CASE("presentation projector represents absent optional families explicitly")
{
    const auto project = fixture();
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto projected = PresentationProjector::project(project, created.value());
    REQUIRE(projected);
    CHECK_FALSE(projected.value().background);
    CHECK(projected.value().actors.empty());
    CHECK(projected.value().interactables.empty());
    CHECK(projected.value().props.empty());
    CHECK(projected.value().environments.empty());
    CHECK(projected.value().layouts.empty());
    CHECK_FALSE(projected.value().text_and_choice.text);
    CHECK_FALSE(projected.value().text_and_choice.choice);
    CHECK_FALSE(projected.value().map);
}

TEST_CASE("active Room projection requires its complete resolved presentation")
{
    const auto project = fixture();
    auto state = representative_state(project);
    auto projected = PresentationProjector::project(project, state);
    REQUIRE_FALSE(projected);
    CHECK(projected.error().front().code == "presentation.room_resolution_unavailable");
}

TEST_CASE("background precedence is Scene current Room named Room session then baseline")
{
    const auto project = fixture();
    auto state = representative_state(project);
    const auto room = resolve_room(project, state);
    REQUIRE(state.current_room_presentation_owner());
    const auto scene = std::get<SceneFrame>(state.flow_stack().back());
    const ScenePresentationOwner scene_owner{scene.frame_id, scene.scene};
    const RoomPresentationOwner room_owner{id<RoomId>("start")};
    const auto make_background = [](const char* color) {
        return compiled::BackgroundPresentation{std::nullopt, std::string{color},
                                                compiled::BackgroundFit::Cover, std::nullopt};
    };
    REQUIRE(state.set_background(project, room_owner, make_background("#220000")));
    REQUIRE(state.set_background(project, *state.current_room_presentation_owner(),
                                 make_background("#003300")));
    REQUIRE(state.set_background(project, scene_owner, make_background("#000044")));

    auto projected = PresentationProjector::project(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#000044");
    REQUIRE(state.remove_background_override(scene_owner));
    projected = PresentationProjector::project(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#003300");
    REQUIRE(state.remove_background_override(*state.current_room_presentation_owner()));
    projected = PresentationProjector::project(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#220000");
    REQUIRE(state.remove_background_override(room_owner));
    projected = PresentationProjector::project(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#112233");
    REQUIRE(state.remove_background_override(state.session_presentation_owner()));
    projected = PresentationProjector::project(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#101820");
}

TEST_CASE("presentation projector canonicalizes every multi-instance family")
{
    const auto project = fixture();
    auto state = representative_state(project);
    REQUIRE(state.set_layout(project, compiled::LayoutSlot::Custom, id<LayoutId>("hud-inline")));
    REQUIRE(state.set_audio_channel(
        project, {compiled::AudioChannel::Ambient, id<AssetId>("audio-voice"), 0.5, true, true}));
    const auto room = resolve_room(project, state);
    auto first = PresentationProjector::project(project, state, &room);
    auto second = PresentationProjector::project(project, state, &room);
    REQUIRE(first);
    REQUIRE(second);
    CHECK(first.value() == second.value());
    CHECK(std::is_sorted(
        first.value().actors.begin(), first.value().actors.end(), [](const auto& a, const auto& b) {
            return std::tie(a.plane, a.order, a.key) < std::tie(b.plane, b.order, b.key);
        }));
    CHECK(std::is_sorted(first.value().layouts.begin(), first.value().layouts.end(),
                         [](const auto& a, const auto& b) {
                             return std::tie(a.policy.plane, a.policy.local_order, a.key) <
                                    std::tie(b.policy.plane, b.policy.local_order, b.key);
                         }));
    REQUIRE(first.value().audio_channels.size() == 2);
    CHECK(first.value().audio_channels[0].channel == compiled::AudioChannel::Music);
    CHECK(first.value().audio_channels[1].channel == compiled::AudioChannel::Ambient);
}

TEST_CASE("snapshot publisher revisions only complete target changes and is failure atomic")
{
    const auto project = fixture();
    auto state = representative_state(project);
    const auto room = resolve_room(project, state);
    RuntimePresentationSnapshotPublisher publisher;
    REQUIRE(publisher.reproject(project, state, &room).value());
    REQUIRE(publisher.published());
    CHECK(publisher.published()->revision.number() == 1);
    CHECK_FALSE(publisher.reproject(project, state, &room).value());
    CHECK(publisher.published()->revision.number() == 1);

    state.clear_presented_text();
    REQUIRE(publisher.reproject(project, state, &room).value());
    CHECK(publisher.published()->revision.number() == 2);
    const auto before = *publisher.published();

    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/minimal.json");
    const std::string json((std::istreambuf_iterator<char>(input)), {});
    auto minimal = decode_compiled_project(nlohmann::json::parse(json), "minimal.json");
    REQUIRE(minimal);
    auto failed = publisher.reproject(minimal.value(), state, &room);
    REQUIRE_FALSE(failed);
    REQUIRE(failed.error().size() > 1);
    CHECK(failed.error().front().code == "presentation.unresolved_reference");
    CHECK(*publisher.published() == before);
}
