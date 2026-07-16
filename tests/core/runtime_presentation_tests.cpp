#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/runtime_presentation.hpp>
#include <noveltea/core/session_state.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <fstream>
#include <iterator>
#include <string>

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

SessionState representative_state(const CompiledProject& project)
{
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
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
                                          {},
                                          true,
                                          false}));
    REQUIRE(
        state.set_overlay(project, id<RoomId>("start"), id<RoomOverlayId>("start-overlay"), true));
    REQUIRE(state.set_layout(project, compiled::LayoutSlot::Hud, id<LayoutId>("hud-inline")));
    REQUIRE(state.present_text(
        project, PresentedTextState{id<CharacterId>("hero"), "Hello", TextMarkup::Plain}));
    REQUIRE(state.set_transition({compiled::TransitionKind::Fade, std::string{"#000000"}, false}));
    REQUIRE(
        state.set_map_presentation(project, {id<MapId>("house"), compiled::InitialMapMode::FullMap,
                                             true, id<MapLocationId>("start-location")}));
    REQUIRE(state.set_audio_channel(
        project, {compiled::AudioChannel::Music, id<AssetId>("audio-voice"), 0.75, true, true}));
    return state;
}
} // namespace

TEST_CASE("presentation projector covers current families and resolves authored identities")
{
    const auto project = fixture();
    const auto state = representative_state(project);
    auto projected = PresentationProjector::project(project, state);
    REQUIRE(projected);
    const auto& snapshot = projected.value();
    CHECK(snapshot.revision == 0);
    REQUIRE(snapshot.background);
    CHECK(snapshot.background->asset == id<AssetId>("image-main"));
    REQUIRE(snapshot.actors.size() == 1);
    CHECK(snapshot.actors.front().pose_sprite == id<AssetId>("image-main"));
    REQUIRE(snapshot.overlays.size() == 1);
    CHECK(snapshot.overlays.front().layout == id<LayoutId>("hud-assets"));
    CHECK(snapshot.layout_slots.size() == 1);
    REQUIRE(snapshot.text_and_choice.text);
    REQUIRE(snapshot.transition);
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
    CHECK_FALSE(projected.value().text_and_choice.text);
    CHECK_FALSE(projected.value().text_and_choice.choice);
    CHECK_FALSE(projected.value().transition);
    CHECK_FALSE(projected.value().map);
}

TEST_CASE("presentation projector canonicalizes collection ordering")
{
    const auto project = fixture();
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
    REQUIRE(
        state.set_overlay(project, id<RoomId>("start"), id<RoomOverlayId>("start-overlay"), true));
    REQUIRE(
        state.set_overlay(project, id<RoomId>("hall"), id<RoomOverlayId>("hall-overlay"), false));
    REQUIRE(state.set_layout(project, compiled::LayoutSlot::Custom, id<LayoutId>("hud-inline")));
    REQUIRE(state.set_layout(project, compiled::LayoutSlot::Hud, id<LayoutId>("hud-assets")));
    REQUIRE(state.set_audio_channel(
        project, {compiled::AudioChannel::Ambient, id<AssetId>("audio-voice"), 0.5, true, true}));
    REQUIRE(state.set_audio_channel(
        project, {compiled::AudioChannel::Music, id<AssetId>("audio-voice"), 1.0, true, true}));
    auto projected = PresentationProjector::project(project, state);
    REQUIRE(projected);
    REQUIRE(projected.value().overlays.size() == 1);
    CHECK(projected.value().overlays[0].room == id<RoomId>("start"));
    REQUIRE(projected.value().layout_slots.size() == 2);
    CHECK(projected.value().layout_slots[0].slot == compiled::LayoutSlot::Hud);
    CHECK(projected.value().layout_slots[1].slot == compiled::LayoutSlot::Custom);
    REQUIRE(projected.value().audio_channels.size() == 2);
    CHECK(projected.value().audio_channels[0].channel == compiled::AudioChannel::Music);
    CHECK(projected.value().audio_channels[1].channel == compiled::AudioChannel::Ambient);
}

TEST_CASE("snapshot publisher is stable and failure atomic")
{
    const auto project = fixture();
    auto state = representative_state(project);
    RuntimePresentationSnapshotPublisher publisher;
    REQUIRE(publisher.reproject(project, state).value());
    REQUIRE(publisher.published());
    CHECK(publisher.published()->revision == 1);
    CHECK_FALSE(publisher.reproject(project, state).value());
    CHECK(publisher.published()->revision == 1);

    state.clear_presented_text();
    REQUIRE(publisher.reproject(project, state).value());
    CHECK(publisher.published()->revision == 2);

    CHECK(publisher.published()->revision == 2);
}

TEST_CASE("projection reports ordered unresolved references and preserves publication")
{
    const auto source_project = fixture();
    auto source_state = representative_state(source_project);
    RuntimePresentationSnapshotPublisher publisher;
    REQUIRE(publisher.reproject(source_project, source_state));
    const auto before = *publisher.published();

    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/minimal.json");
    const std::string json((std::istreambuf_iterator<char>(input)), {});
    auto minimal = decode_compiled_project(nlohmann::json::parse(json), "minimal.json");
    REQUIRE(minimal);
    auto failed = publisher.reproject(minimal.value(), source_state);
    REQUIRE_FALSE(failed);
    REQUIRE(failed.error().size() > 1);
    CHECK(failed.error().front().code == "presentation.unresolved_reference");
    CHECK(*publisher.published() == before);
}
