#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/layout_policies.hpp>
#include <noveltea/core/property_resolver.hpp>
#include <noveltea/presentation/presentation_operation_requests.hpp>
#include <noveltea/presentation/room_presentation.hpp>
#include <noveltea/presentation/runtime_presentation.hpp>
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
using noveltea::runtime::RuntimeWorld;

namespace {
template<class Id> Id id(const char* value) { return std::move(Id::create(value)).value(); }

CompiledProject fixture()
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/scene-program.json");
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)), {});
    auto document = nlohmann::json::parse(source);
    auto& rooms = document["definitions"]["rooms"];
    auto start = std::find_if(rooms.begin(), rooms.end(),
                              [](const nlohmann::json& value) { return value["id"] == "start"; });
    REQUIRE(start != rooms.end());
    (*start)["cast"] =
        nlohmann::json::array({{{"id", "hero-cast"},
                                {"character", {{"kind", "character"}, {"id", "hero"}}},
                                {"condition", {{"kind", "always"}}},
                                {"placementId", "key-placement"},
                                {"poseId", nullptr},
                                {"expressionId", nullptr},
                                {"idleId", nullptr},
                                {"visible", true},
                                {"order", 0}}});
    auto decoded = decode_compiled_project(document, "scene-program.json");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

CompiledProject focus_fixture()
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/scene-program.json");
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)), {});
    auto document = nlohmann::json::parse(source);
    auto& rooms = document["definitions"]["rooms"];
    auto start = std::find_if(rooms.begin(), rooms.end(),
                              [](const nlohmann::json& value) { return value["id"] == "start"; });
    REQUIRE(start != rooms.end());
    (*start)["anchors"] = nlohmann::json::array(
        {{{"id", "desk"}, {"bounds", {{"x", 0.5}, {"y", 0.1}, {"width", 0.2}, {"height", 0.3}}}}});
    auto decoded = decode_compiled_project(document, "scene-program-focus.json");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

CompiledProject hotspot_fixture()
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/interaction-program.json");
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)), {});
    auto decoded =
        decode_compiled_project(nlohmann::json::parse(source), "interaction-program.json");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

CompiledProject layout_contract_fixture()
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/interaction-program.json");
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)), {});
    auto document = nlohmann::json::parse(source);
    auto& layouts = document["resources"]["layouts"];
    auto layout = std::find_if(layouts.begin(), layouts.end(), [](const nlohmann::json& value) {
        return value["id"] == "hud-inline";
    });
    REQUIRE(layout != layouts.end());
    auto contract_layout = *layout;
    contract_layout["id"] = "contract-layout";
    contract_layout["contract"] = {
        {"inputs", nlohmann::json::array({{{"id", "count"},
                                           {"type", "integer"},
                                           {"nullable", false},
                                           {"hasDefault", false},
                                           {"defaultValue", nullptr}}})},
        {"signals",
         nlohmann::json::array({{{"id", "confirmed"},
                                 {"fields", nlohmann::json::array({{{"id", "choice"},
                                                                    {"type", "integer"},
                                                                    {"nullable", false},
                                                                    {"required", true}}})}}})},
        {"state",
         {{"type", "integer"}, {"nullable", false}, {"hasDefault", true}, {"defaultValue", 1}}},
    };
    auto incompatible_layout = contract_layout;
    incompatible_layout["id"] = "contract-layout-string";
    incompatible_layout["contract"]["state"] = {
        {"type", "string"},
        {"nullable", false},
        {"hasDefault", true},
        {"defaultValue", "default"},
    };
    layouts.push_back(std::move(contract_layout));
    layouts.push_back(std::move(incompatible_layout));
    auto decoded = decode_compiled_project(document, "layout-contract.json");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

ResolvedRoomPresentation resolve_room(const CompiledProject& project, SessionState& state)
{
    REQUIRE(state.room_visit());
    RuntimeWorld world(project, state);
    RoomPresentationResolver resolver;
    auto resolved = resolver.resolve(
        project, world, state, *state.room_visit(),
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

Result<RuntimePresentationSnapshot, Diagnostics>
project_snapshot(const CompiledProject& project, SessionState& state,
                 const ResolvedRoomPresentation* room = nullptr)
{
    RuntimeWorld world(project, state);
    return PresentationProjector::project(project, world, state, room);
}

RoomPresentationVisualCatalog visual_catalog(const CompiledProject& project, SessionState& state,
                                             const RoomPresentationResolution& resolution)
{
    RuntimeWorld world(project, state);
    return build_room_presentation_visual_catalog(world, resolution);
}

SessionState representative_state(const CompiledProject& project)
{
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
    REQUIRE(state.move_character(project, id<CharacterId>("hero"),
                                 compiled::RoomLocation{id<RoomId>("start")}));
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
    REQUIRE(state.upsert_desired_audio(
        project,
        DesiredAudioInstance{id<DesiredAudioInstanceId>("background-music"),
                             state.session_presentation_owner(), compiled::AudioChannel::Music,
                             id<AssetId>("audio-voice"), 0.75, std::chrono::milliseconds{150},
                             std::chrono::milliseconds{250},
                             id<DesiredAudioReplacementKey>("background-music")}));
    return state;
}

const PresentationMountedLayout* find_layout(const RuntimePresentationSnapshot& snapshot,
                                             const MountedLayoutPresentationKey& key)
{
    const auto found = std::find_if(snapshot.layouts.begin(), snapshot.layouts.end(),
                                    [&key](const auto& value) { return value.key == key; });
    return found == snapshot.layouts.end() ? nullptr : &*found;
}

const PresentationMountedLayout* find_layout(const RuntimePresentationSnapshot& snapshot,
                                             const PresentationOwner& owner,
                                             const MountedLayoutPresentationKey& key)
{
    const auto found =
        std::find_if(snapshot.layouts.begin(), snapshot.layouts.end(),
                     [&](const auto& value) { return value.owner == owner && value.key == key; });
    return found == snapshot.layouts.end() ? nullptr : &*found;
}
} // namespace

TEST_CASE("camera Focus capture freezes Room occurrence and Anchor bounds in logical world space")
{
    const auto project = focus_fixture();
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
    const auto room = resolve_room(project, state);
    auto projected = project_snapshot(project, state, &room);
    REQUIRE(projected);
    const auto& snapshot = projected.value();
    REQUIRE(snapshot.camera);

    const compiled::RoomPlacementRef placement{id<RoomId>("start"),
                                               id<RoomPlacementId>("key-placement")};
    auto occurrence = capture_camera_focus(project, snapshot, CameraFocusSource{placement});
    REQUIRE(occurrence);
    CHECK(occurrence.value().source == CameraFocusSource{placement});
    CHECK(occurrence.value().bounds == compiled::WorldPresentationRect{192.0, 216.0, 384.0, 216.0});

    const RoomAnchorFocusSource anchor{id<RoomId>("start"), id<RoomAnchorId>("desk")};
    auto anchored = capture_camera_focus(project, snapshot, CameraFocusSource{anchor});
    REQUIRE(anchored);
    CHECK(anchored.value().source == CameraFocusSource{anchor});
    CHECK(anchored.value().bounds == compiled::WorldPresentationRect{960.0, 108.0, 384.0, 324.0});

    const RoomAnchorFocusSource missing{id<RoomId>("start"), id<RoomAnchorId>("missing")};
    auto rejected = capture_camera_focus(project, snapshot, CameraFocusSource{missing});
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.camera_focus_source_unavailable");
}

TEST_CASE("presentation projector assembles the complete effective target")
{
    const auto project = fixture();
    auto state = representative_state(project);
    const auto room = resolve_room(project, state);
    auto projected = project_snapshot(project, state, &room);
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
            return std::holds_alternative<RoomCastActorKey>(actor.key);
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
    REQUIRE(snapshot.desired_audio.size() == 1);
    CHECK(snapshot.desired_audio.front().instance ==
          id<DesiredAudioInstanceId>("background-music"));
}

TEST_CASE("shared Room snapshot projector matches the runtime Room baseline")
{
    const auto project = fixture();
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
    REQUIRE(state.room_visit());

    RuntimeWorld world(project, state);
    RoomPresentationResolver resolver;
    auto resolution = resolver.resolve(
        project, world, state, *state.room_visit(),
        [](const Condition&) { return Result<bool, Diagnostics>::success(true); },
        [](const TextSource& source) {
            return Result<std::string, Diagnostics>::success(std::visit(
                [](const auto& value) -> std::string {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, LuaTextExpression>) {
                        return value.source;
                    } else {
                        return value.value;
                    }
                },
                source));
        });
    REQUIRE(resolution);
    auto focused_baseline = RoomPresentationSnapshotProjector::project(
        resolution.value(), visual_catalog(project, state, resolution.value()));
    REQUIRE(focused_baseline);
    auto runtime = project_snapshot(project, state, &resolution.value().presentation);
    REQUIRE(runtime);

    CHECK(focused_baseline.value().current_room == runtime.value().current_room);
    CHECK(focused_baseline.value().background == runtime.value().background);
    CHECK(focused_baseline.value().actors == runtime.value().actors);
    CHECK(focused_baseline.value().interactables == runtime.value().interactables);
    CHECK(focused_baseline.value().props == runtime.value().props);
    CHECK(focused_baseline.value().environments == runtime.value().environments);
}

TEST_CASE(
    "runtime hotspot projection preserves eligibility while focused Room preview stays passive")
{
    const auto project = hotspot_fixture();
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
    REQUIRE(state.room_visit());

    RuntimeWorld world(project, state);
    RoomPresentationResolver resolver;
    auto resolution = resolver.resolve(
        project, world, state, *state.room_visit(),
        [](const Condition& condition) {
            return Result<bool, Diagnostics>::success(std::holds_alternative<Always>(condition));
        },
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
    REQUIRE(resolution);
    REQUIRE(resolution.value().presentation.hotspots.size() == 3);

    const auto find_hotspot = [&](const char* hotspot_id) {
        return std::find_if(
            resolution.value().presentation.hotspots.begin(),
            resolution.value().presentation.hotspots.end(), [&](const auto& hotspot) {
                return std::visit(
                    [&](const auto& ref) { return ref.hotspot_id == id<HotspotId>(hotspot_id); },
                    hotspot.ref);
            });
    };
    const auto inspect = find_hotspot("inspect-door");
    const auto exit = find_hotspot("north-door");
    const auto alpha = find_hotspot("key-alpha");
    REQUIRE(inspect != resolution.value().presentation.hotspots.end());
    REQUIRE(exit != resolution.value().presentation.hotspots.end());
    REQUIRE(alpha != resolution.value().presentation.hotspots.end());
    CHECK(inspect->condition_eligible);
    CHECK(inspect->target_available);
    CHECK(exit->condition_eligible);
    CHECK_FALSE(exit->target_available);
    CHECK(alpha->condition_eligible);
    CHECK(alpha->target_available);
    CHECK(inspect->target == compiled::ResolvedHotspotTarget{compiled::FeatureInteractionSubject{
                                 RoomFeatureRef{id<RoomId>("start"), id<FeatureId>("door")}}});
    CHECK(alpha->target ==
          compiled::ResolvedHotspotTarget{compiled::FeatureInteractionSubject{
              InteractableFeatureRef{id<InteractableId>("key"), id<FeatureId>("surface")}}});

    auto runtime = project_snapshot(project, state, &resolution.value().presentation);
    REQUIRE(runtime);
    REQUIRE(runtime.value().hotspots.size() == 3);
    CHECK(std::count_if(runtime.value().hotspots.begin(), runtime.value().hotspots.end(),
                        [](const auto& hotspot) {
                            return hotspot.condition_eligible && !hotspot.target_available;
                        }) == 1);
    CHECK(std::any_of(runtime.value().hotspots.begin(), runtime.value().hotspots.end(),
                      [](const auto& hotspot) {
                          return std::holds_alternative<AlphaHotspotShape>(hotspot.shape);
                      }));

    auto focused = RoomPresentationSnapshotProjector::project(
        resolution.value(), visual_catalog(project, state, resolution.value()));
    REQUIRE(focused);
    CHECK(focused.value().hotspots.empty());
}

TEST_CASE("presentation projector represents absent optional families explicitly")
{
    const auto project = fixture();
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto& state = created.value();
    auto projected = project_snapshot(project, state);
    REQUIRE(projected);
    CHECK_FALSE(projected.value().background);
    CHECK(projected.value().actors.empty());
    CHECK(projected.value().interactables.empty());
    CHECK(projected.value().props.empty());
    CHECK(projected.value().environments.empty());
    CHECK(projected.value().layouts.empty());
    CHECK_FALSE(projected.value().text_and_choice.text);
    CHECK_FALSE(projected.value().text_and_choice.choice);
}

TEST_CASE("active Room projection requires its complete resolved presentation")
{
    const auto project = fixture();
    auto state = representative_state(project);
    auto projected = project_snapshot(project, state);
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

    auto projected = project_snapshot(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#000044");
    REQUIRE(state.remove_background_override(scene_owner));
    projected = project_snapshot(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#003300");
    REQUIRE(state.remove_background_override(*state.current_room_presentation_owner()));
    projected = project_snapshot(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#220000");
    REQUIRE(state.remove_background_override(room_owner));
    projected = project_snapshot(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#112233");
    REQUIRE(state.remove_background_override(state.session_presentation_owner()));
    projected = project_snapshot(project, state, &room);
    REQUIRE(projected);
    CHECK(projected.value().background->color == "#101820");
}

TEST_CASE("presentation projector canonicalizes every multi-instance family")
{
    const auto project = fixture();
    auto state = representative_state(project);
    REQUIRE(state.set_layout(project, compiled::LayoutSlot::Custom, id<LayoutId>("hud-inline")));
    REQUIRE(state.upsert_desired_audio(
        project, DesiredAudioInstance{
                     id<DesiredAudioInstanceId>("rain-left"), state.session_presentation_owner(),
                     compiled::AudioChannel::Ambient, id<AssetId>("audio-voice"), 0.5}));
    REQUIRE(state.upsert_desired_audio(
        project, DesiredAudioInstance{
                     id<DesiredAudioInstanceId>("rain-right"), state.session_presentation_owner(),
                     compiled::AudioChannel::Ambient, id<AssetId>("audio-voice"), 0.4}));
    const auto room = resolve_room(project, state);
    auto first = project_snapshot(project, state, &room);
    auto second = project_snapshot(project, state, &room);
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
    REQUIRE(first.value().desired_audio.size() == 3);
    CHECK(first.value().desired_audio[0].bus == compiled::AudioChannel::Music);
    CHECK(first.value().desired_audio[1].bus == compiled::AudioChannel::Ambient);
    CHECK(first.value().desired_audio[2].bus == compiled::AudioChannel::Ambient);
}

TEST_CASE("Layout Mount contracts keep owner-qualified identity and reevaluate bindings")
{
    const auto project = layout_contract_fixture();
    const auto input_id = id<LayoutInputId>("count");
    const auto signal_id = id<LayoutSignalId>("confirmed");
    const auto field_id = id<LayoutSignalFieldId>("choice");

    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
    const auto key =
        MountedLayoutPresentationKey{ScopedLayoutMountKey{id<ScopedLayoutInstanceId>("widget")}};
    const auto session_owner = PresentationOwner{state.session_presentation_owner()};
    const auto current_room_owner = PresentationOwner{*state.current_room_presentation_owner()};
    const auto mount = [&](PresentationOwner owner) {
        return DesiredMountedLayout{key,
                                    std::move(owner),
                                    id<LayoutId>("contract-layout"),
                                    reserved_layout_policy(compiled::LayoutSlot::Custom),
                                    {},
                                    PresentationCompositionGroup::Interface,
                                    std::nullopt,
                                    {{input_id, LayoutVariableBinding{id<PropertyId>("count")}}},
                                    {signal_id}};
    };
    REQUIRE(state.upsert_mounted_layout(project, mount(session_owner)));
    REQUIRE(state.upsert_mounted_layout(project, mount(current_room_owner)));
    REQUIRE(state.mounted_layouts().size() >= 2);

    const auto room = resolve_room(project, state);
    auto snapshot = project_snapshot(project, state, &room);
    if (!snapshot)
        for (const auto& diagnostic : snapshot.error())
            UNSCOPED_INFO(diagnostic.code << ": " << diagnostic.message);
    REQUIRE(snapshot);
    const auto* session_mount = find_layout(snapshot.value(), session_owner, key);
    const auto* room_mount = find_layout(snapshot.value(), current_room_owner, key);
    REQUIRE(session_mount);
    REQUIRE(room_mount);
    REQUIRE(session_mount->occurrence);
    REQUIRE(room_mount->occurrence);
    CHECK(*session_mount->occurrence != *room_mount->occurrence);
    REQUIRE(session_mount->inputs.size() == 1);
    CHECK(session_mount->inputs[0].value == RuntimeValue{std::int64_t{2}});

    PropertyResolver properties(project, state);
    REQUIRE(properties.set_global(id<PropertyId>("count"), RuntimeValue{std::int64_t{7}}));
    snapshot = project_snapshot(project, state, &room);
    REQUIRE(snapshot);
    session_mount = find_layout(snapshot.value(), session_owner, key);
    REQUIRE(session_mount);
    REQUIRE(session_mount->occurrence);
    const auto occurrence = *session_mount->occurrence;
    REQUIRE(session_mount->inputs.size() == 1);
    CHECK(session_mount->inputs[0].value == RuntimeValue{std::int64_t{7}});

    auto invalid = mount(session_owner);
    invalid.inputs.push_back(
        {id<LayoutInputId>("undeclared"), LayoutLiteralInput{RuntimeValue{std::int64_t{1}}}});
    CHECK_FALSE(state.upsert_mounted_layout(project, std::move(invalid)));
    const auto existing = std::find_if(
        state.mounted_layouts().begin(), state.mounted_layouts().end(),
        [&](const auto& value) { return value.owner == session_owner && value.key == key; });
    REQUIRE(existing != state.mounted_layouts().end());
    REQUIRE(existing->occurrence);
    CHECK(*existing->occurrence == occurrence);
    CHECK(existing->inputs.size() == 1);

    REQUIRE(state.validate_layout_signal(project, session_owner, key, occurrence, signal_id,
                                         {{field_id, RuntimeValue{std::int64_t{3}}}}));

    auto policy_update = mount(session_owner);
    policy_update.policy.local_order = 42;
    policy_update.policy.visibility = LayoutVisibility::Hidden;
    REQUIRE(state.upsert_mounted_layout(project, std::move(policy_update)));
    auto updated = std::find_if(
        state.mounted_layouts().begin(), state.mounted_layouts().end(),
        [&](const auto& value) { return value.owner == session_owner && value.key == key; });
    REQUIRE(updated != state.mounted_layouts().end());
    REQUIRE(updated->occurrence);
    CHECK(*updated->occurrence == occurrence);
    CHECK(updated->policy.local_order == 42);
    CHECK(updated->policy.visibility == LayoutVisibility::Hidden);

    auto replacement = DesiredMountedLayout{key,
                                            session_owner,
                                            id<LayoutId>("hud-assets"),
                                            reserved_layout_policy(compiled::LayoutSlot::Custom),
                                            {},
                                            PresentationCompositionGroup::Interface,
                                            std::nullopt,
                                            {},
                                            {}};
    REQUIRE(state.upsert_mounted_layout(project, std::move(replacement)));
    const auto replaced = std::find_if(
        state.mounted_layouts().begin(), state.mounted_layouts().end(),
        [&](const auto& value) { return value.owner == session_owner && value.key == key; });
    REQUIRE(replaced != state.mounted_layouts().end());
    REQUIRE(replaced->occurrence);
    CHECK(*replaced->occurrence != occurrence);
    CHECK(replaced->layout == id<LayoutId>("hud-assets"));
    auto stale = state.validate_layout_signal(project, session_owner, key, occurrence, signal_id,
                                              {{field_id, RuntimeValue{std::int64_t{3}}}});
    REQUIRE_FALSE(stale);
    REQUIRE_FALSE(stale.error().empty());
    CHECK(stale.error().front().code == "runtime.stale_layout_signal");
}

TEST_CASE("Layout State Slots survive unmount and expire with their semantic scope")
{
    const auto project = layout_contract_fixture();
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));

    const auto key =
        MountedLayoutPresentationKey{ScopedLayoutMountKey{id<ScopedLayoutInstanceId>("stateful")}};
    const auto mount_current_room = [&]() {
        return DesiredMountedLayout{
            key,
            PresentationOwner{*state.current_room_presentation_owner()},
            id<LayoutId>("contract-layout"),
            reserved_layout_policy(compiled::LayoutSlot::Custom),
            {},
            PresentationCompositionGroup::Interface,
            std::nullopt,
            {{id<LayoutInputId>("count"), LayoutVariableBinding{id<PropertyId>("count")}}},
            {id<LayoutSignalId>("confirmed")}};
    };
    REQUIRE(state.upsert_mounted_layout(project, mount_current_room()));
    auto mounted = std::find_if(state.mounted_layouts().begin(), state.mounted_layouts().end(),
                                [&](const auto& value) { return value.key == key; });
    REQUIRE(mounted != state.mounted_layouts().end());
    REQUIRE(mounted->occurrence);
    auto owner = mounted->owner;
    auto occurrence = *mounted->occurrence;

    auto visit_default =
        state.layout_state(project, owner, key, occurrence, LayoutStateScope::Visit);
    REQUIRE(visit_default);
    REQUIRE(visit_default.value());
    CHECK(*visit_default.value() == PersistableValue{std::int64_t{1}});

    REQUIRE(state.commit_layout_state(project, owner, key, occurrence, LayoutStateScope::Visit,
                                      PersistableValue{std::int64_t{2}}));
    REQUIRE(state.commit_layout_state(project, owner, key, occurrence, LayoutStateScope::Room,
                                      PersistableValue{std::int64_t{3}}));
    REQUIRE(state.commit_layout_state(project, owner, key, occurrence, LayoutStateScope::Session,
                                      PersistableValue{std::int64_t{4}}));
    const auto slots_before_unmount = state.layout_state_slots();
    REQUIRE(slots_before_unmount.size() == 3);

    REQUIRE(state.remove_mounted_layout(key, owner));
    CHECK(state.layout_state_slots().size() == 3);
    REQUIRE(state.upsert_mounted_layout(project, mount_current_room()));
    mounted = std::find_if(state.mounted_layouts().begin(), state.mounted_layouts().end(),
                           [&](const auto& value) { return value.key == key; });
    REQUIRE(mounted != state.mounted_layouts().end());
    REQUIRE(mounted->occurrence);
    owner = mounted->owner;
    occurrence = *mounted->occurrence;
    auto room_value = state.layout_state(project, owner, key, occurrence, LayoutStateScope::Room);
    REQUIRE(room_value);
    REQUIRE(room_value.value());
    CHECK(*room_value.value() == PersistableValue{std::int64_t{3}});

    auto invalid =
        state.commit_layout_state(project, owner, key, occurrence, LayoutStateScope::Room,
                                  PersistableValue{std::string("wrong")});
    REQUIRE_FALSE(invalid);
    room_value = state.layout_state(project, owner, key, occurrence, LayoutStateScope::Room);
    REQUIRE(room_value);
    REQUIRE(room_value.value());
    CHECK(*room_value.value() == PersistableValue{std::int64_t{3}});

    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
    CHECK(state.layout_state_slots().size() == 2);
    REQUIRE(state.upsert_mounted_layout(project, mount_current_room()));
    mounted = std::find_if(state.mounted_layouts().begin(), state.mounted_layouts().end(),
                           [&](const auto& value) { return value.key == key; });
    REQUIRE(mounted != state.mounted_layouts().end());
    REQUIRE(mounted->occurrence);
    owner = mounted->owner;
    occurrence = *mounted->occurrence;
    visit_default = state.layout_state(project, owner, key, occurrence, LayoutStateScope::Visit);
    REQUIRE(visit_default);
    REQUIRE(visit_default.value());
    CHECK(*visit_default.value() == PersistableValue{std::int64_t{1}});
    room_value = state.layout_state(project, owner, key, occurrence, LayoutStateScope::Room);
    REQUIRE(room_value);
    REQUIRE(room_value.value());
    CHECK(*room_value.value() == PersistableValue{std::int64_t{3}});

    REQUIRE(state.clear_layout_state(project, owner, key, occurrence, LayoutStateScope::Room));
    room_value = state.layout_state(project, owner, key, occurrence, LayoutStateScope::Room);
    REQUIRE(room_value);
    REQUIRE(room_value.value());
    CHECK(*room_value.value() == PersistableValue{std::int64_t{1}});
}

TEST_CASE("Layout State Slot rejects incompatible remount without consuming retained state")
{
    const auto project = layout_contract_fixture();
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));

    const auto key = MountedLayoutPresentationKey{
        ScopedLayoutMountKey{id<ScopedLayoutInstanceId>("stateful-remount")}};
    const auto owner = PresentationOwner{*state.current_room_presentation_owner()};
    const auto mount = [&](const LayoutId& layout) {
        return DesiredMountedLayout{
            key,
            owner,
            layout,
            reserved_layout_policy(compiled::LayoutSlot::Custom),
            {},
            PresentationCompositionGroup::Interface,
            std::nullopt,
            {{id<LayoutInputId>("count"), LayoutVariableBinding{id<PropertyId>("count")}}},
            {id<LayoutSignalId>("confirmed")}};
    };

    REQUIRE(state.upsert_mounted_layout(project, mount(id<LayoutId>("contract-layout"))));
    const auto mounted =
        std::find_if(state.mounted_layouts().begin(), state.mounted_layouts().end(),
                     [&](const auto& value) { return value.owner == owner && value.key == key; });
    REQUIRE(mounted != state.mounted_layouts().end());
    REQUIRE(mounted->occurrence);
    REQUIRE(state.commit_layout_state(project, owner, key, *mounted->occurrence,
                                      LayoutStateScope::Room, PersistableValue{std::int64_t{9}}));
    REQUIRE(state.remove_mounted_layout(key, owner));

    auto incompatible =
        state.upsert_mounted_layout(project, mount(id<LayoutId>("contract-layout-string")));
    REQUIRE_FALSE(incompatible);
    REQUIRE_FALSE(incompatible.error().empty());
    CHECK(incompatible.error().front().code == "runtime.layout_state_reconstruction_failed");
    REQUIRE(state.layout_state_slots().size() == 1);
    CHECK(state.layout_state_slots().front().layout == id<LayoutId>("contract-layout"));
    CHECK(state.layout_state_slots().front().value == PersistableValue{std::int64_t{9}});
    CHECK(
        std::none_of(state.mounted_layouts().begin(), state.mounted_layouts().end(),
                     [&](const auto& value) { return value.owner == owner && value.key == key; }));
}

TEST_CASE("Layout State Slot validation ignores unrelated semantic scope owners")
{
    const auto project = layout_contract_fixture();
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));

    const auto key = MountedLayoutPresentationKey{
        ScopedLayoutMountKey{id<ScopedLayoutInstanceId>("room-scoped-state")}};
    const auto current_owner = PresentationOwner{*state.current_room_presentation_owner()};
    REQUIRE(state.upsert_mounted_layout(
        project, DesiredMountedLayout{
                     key,
                     current_owner,
                     id<LayoutId>("contract-layout"),
                     reserved_layout_policy(compiled::LayoutSlot::Custom),
                     {},
                     PresentationCompositionGroup::Interface,
                     std::nullopt,
                     {{id<LayoutInputId>("count"), LayoutVariableBinding{id<PropertyId>("count")}}},
                     {id<LayoutSignalId>("confirmed")}}));
    const auto mounted = std::find_if(
        state.mounted_layouts().begin(), state.mounted_layouts().end(),
        [&](const auto& value) { return value.owner == current_owner && value.key == key; });
    REQUIRE(mounted != state.mounted_layouts().end());
    REQUIRE(mounted->occurrence);
    REQUIRE(state.commit_layout_state(project, current_owner, key, *mounted->occurrence,
                                      LayoutStateScope::Room, PersistableValue{std::int64_t{9}}));
    REQUIRE(state.remove_mounted_layout(key, current_owner));

    const auto hall_owner = PresentationOwner{RoomPresentationOwner{id<RoomId>("hall")}};
    REQUIRE(state.upsert_mounted_layout(
        project, DesiredMountedLayout{key,
                                      hall_owner,
                                      id<LayoutId>("hud-assets"),
                                      reserved_layout_policy(compiled::LayoutSlot::Custom),
                                      {},
                                      PresentationCompositionGroup::Interface,
                                      std::nullopt,
                                      {},
                                      {}}));
    REQUIRE(state.layout_state_slots().size() == 1);
    CHECK(state.layout_state_slots().front().layout == id<LayoutId>("contract-layout"));
}

TEST_CASE("snapshot publisher revisions only complete target changes and is failure atomic")
{
    const auto project = fixture();
    auto state = representative_state(project);
    const auto room = resolve_room(project, state);
    RuntimeWorld world(project, state);
    RuntimePresentationSnapshotPublisher publisher;
    REQUIRE(publisher.reproject(project, world, state, &room).value());
    REQUIRE(publisher.published());
    CHECK(publisher.published()->revision.number() == 1);
    CHECK_FALSE(publisher.reproject(project, world, state, &room).value());
    CHECK(publisher.published()->revision.number() == 1);

    state.clear_presented_text();
    REQUIRE(publisher.reproject(project, world, state, &room).value());
    CHECK(publisher.published()->revision.number() == 2);
    const auto before = *publisher.published();

    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/minimal.json");
    const std::string json((std::istreambuf_iterator<char>(input)), {});
    auto minimal = decode_compiled_project(nlohmann::json::parse(json), "minimal.json");
    REQUIRE(minimal);
    RuntimeWorld minimal_world(minimal.value(), state);
    auto failed = publisher.reproject(minimal.value(), minimal_world, state, &room);
    REQUIRE_FALSE(failed);
    REQUIRE(failed.error().size() > 1);
    CHECK(std::any_of(failed.error().begin(), failed.error().end(), [](const auto& diagnostic) {
        return diagnostic.code == "presentation.unresolved_reference";
    }));
    // Effective Gameplay Instance configuration is session-owned, so the comprehensive-state actor
    // remains resolvable even while this test deliberately projects against a minimal immutable
    // Project. Missing Project resources still reject the candidate and must not replace
    // publication.
    CHECK(*publisher.published() == before);
}
