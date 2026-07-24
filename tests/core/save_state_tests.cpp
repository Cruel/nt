#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/flow_executor.hpp>
#include <noveltea/core/property_resolver.hpp>
#include <noveltea/presentation/room_presentation.hpp>
#include <noveltea/core/save_state.hpp>
#include <noveltea/core/save_state_codec.hpp>
#include "runtime_test_services.hpp"

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <algorithm>
#include <fstream>
#include <functional>
#include <iterator>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>

using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;
namespace test_support = noveltea::test_support;
using namespace std::chrono_literals;

namespace {
template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    return std::move(result).value();
}

CompiledProject load_fixture(std::string_view filename,
                             const std::function<void(nlohmann::json&)>& amend = {})
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    if (amend)
        amend(document);
    auto decoded = decode_compiled_project(document, std::string(filename));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

SessionState make_state(const CompiledProject& project)
{
    auto result = SessionState::create(project);
    REQUIRE(result);
    return std::move(result).value();
}

void finish_initial_room_transition(FlowExecutor& executor)
{
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::BeforeEnter));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::CommitRoomSwitch));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::AfterEnter));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::Complete));
    REQUIRE(executor.complete_room_transition());
}

DesiredPresentationEnvironment environment(PresentationEnvironmentInstanceId instance,
                                           PresentationOwner owner, const char* stop_key)
{
    return {std::move(instance),
            std::move(owner),
            id<PresentationEnvironmentStopKey>(stop_key),
            std::nullopt,
            id<MaterialId>("sprite-material"),
            {0.0, 0.0, 1.0, 1.0},
            PresentationPlane::WorldOverlay,
            3,
            LayoutClockDomain::Gameplay,
            {0.1, 0.0},
            0.8,
            true};
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
} // namespace

TEST_CASE("typed session time and logical timers advance deterministically")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);

    auto once = state.start_logical_timer(250ms);
    auto repeating = state.start_logical_timer(100ms, 75ms);
    REQUIRE(once);
    REQUIRE(repeating);
    CHECK_FALSE(state.start_logical_timer(-1ms));
    CHECK_FALSE(state.start_logical_timer(1ms, 0ms));

    REQUIRE(state.advance_time(250ms));
    CHECK(state.play_time() == 250ms);
    REQUIRE(state.logical_timers().size() == 1);
    CHECK(state.logical_timers().front().id == repeating.value());
    CHECK(state.logical_timers().front().remaining == 75ms);
    REQUIRE(state.pending_timer_completions().size() == 2);
    CHECK(state.pending_timer_completions()[0].id == once.value());
    CHECK(state.pending_timer_completions()[0].occurrences == 1);
    CHECK(state.pending_timer_completions()[1].id == repeating.value());
    CHECK(state.pending_timer_completions()[1].occurrences == 3);

    const auto completed = state.take_timer_completions();
    CHECK(completed.size() == 2);
    CHECK(state.pending_timer_completions().empty());
    CHECK(state.cancel_logical_timer(repeating.value()));
    CHECK_FALSE(state.cancel_logical_timer(repeating.value()));
    CHECK_FALSE(state.advance_time(-1ms));
    CHECK(state.play_time() == 250ms);
}

TEST_CASE("save state preserves deterministic random position and excludes gameplay pause")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    state.seed_random(424242);
    REQUIRE(state.next_random_integer(1, 100));
    REQUIRE(state.next_random_integer(1, 100));
    state.set_gameplay_paused(true);

    auto snapshot = make_save_state(project, state);
    REQUIRE(snapshot);
    CHECK(snapshot.value().random_state == state.random_state());

    const auto expected_next = state.next_random_integer(-1000, 1000);
    REQUIRE(expected_next);
    auto restored = test_support::restore_session(project, snapshot.value());
    REQUIRE(restored);
    CHECK_FALSE(restored.value().gameplay_paused());
    auto restored_next = restored.value().next_random_integer(-1000, 1000);
    REQUIRE(restored_next);
    CHECK(restored_next.value() == expected_next.value());

    auto encoded = encode_save_state(project, snapshot.value());
    REQUIRE(encoded);
    CHECK(encoded.value()["randomState"] == snapshot.value().random_state);
    auto missing_random = encoded.value();
    missing_random.erase("randomState");
    CHECK_FALSE(decode_save_state_wire(missing_random, "missing-random-state.json"));
}

TEST_CASE("native SaveState projects only persisted typed session families")
{
    STATIC_REQUIRE(std::variant_size_v<SavedFlowFrame> == 4);
    STATIC_REQUIRE(std::variant_size_v<SavedFlowBlocker> == 2);
    STATIC_REQUIRE_FALSE(std::is_default_constructible_v<LogicalTimerId>);

    const auto project = load_fixture("inheritance-properties-localization.json");
    auto state = make_state(project);
    PropertyResolver properties(project, state);
    REQUIRE(state.set_variable(project, id<VariableId>("flag"), RuntimeValue{true}));
    REQUIRE(properties.set(PropertyOwnerRef{id<RoomId>("start")}, id<PropertyId>("mood"),
                           RuntimeValue{std::string{"tense"}}));
    REQUIRE(properties.set(PropertyOwnerRef{id<RoomId>("start")}, id<PropertyId>("enabled"),
                           RuntimeValue{false}));
    REQUIRE(state.record_room_visit(project, id<RoomId>("start")));
    REQUIRE(state.record_dialogue_line(
        project,
        DialogueLineHistoryKey{id<DialogueId>("intro"), id<DialogueSegmentId>("intro-line")}));
    REQUIRE(state.append_text_log(
        project, TextLogEntry{TextLogEntryKind::Line,
                              DialogueLineTextLogOrigin{id<DialogueId>("intro"),
                                                        id<DialogueSegmentId>("intro-line")},
                              std::nullopt, "Welcome.", TextMarkup::Plain}));
    auto timer = state.start_logical_timer(10ms);
    REQUIRE(timer);
    REQUIRE(state.advance_time(10ms));

    auto snapshot = make_save_state(project, state);
    REQUIRE(snapshot);
    const auto& save = snapshot.value();
    CHECK(save.metadata.format_version == SaveStateMetadata::current_format_version);
    CHECK(save.metadata.project == project.identity().id);
    CHECK(save.metadata.project_version == project.identity().version);
    CHECK(save.play_time == 10ms);
    CHECK(save.random_state == state.random_state());
    CHECK(save.variables.size() == project.variables().size());
    REQUIRE(save.property_overrides.size() == 1);
    CHECK(save.property_overrides.front().owner == PropertyOwnerRef{id<RoomId>("start")});
    CHECK(save.property_overrides.front().property == id<PropertyId>("mood"));
    REQUIRE(save.interactables.size() == project.interactables().size());
    const auto find_interactable = [&save](std::string value) {
        const auto wanted = id<InteractableId>(std::move(value));
        return std::find_if(
            save.interactables.begin(), save.interactables.end(),
            [&wanted](const InteractableState& state) { return state.interactable == wanted; });
    };
    const auto key = find_interactable("key");
    REQUIRE(key != save.interactables.end());
    CHECK(std::holds_alternative<compiled::RoomPlacementRef>(key->location));
    const auto coin = find_interactable("coin");
    REQUIRE(coin != save.interactables.end());
    CHECK(std::holds_alternative<compiled::InventoryLocation>(coin->location));
    const auto dust = find_interactable("dust");
    REQUIRE(dust != save.interactables.end());
    CHECK(std::holds_alternative<compiled::NowhereLocation>(dust->location));
    REQUIRE(save.room_visits.size() == 1);
    CHECK(save.room_visits.front().room == id<RoomId>("start"));
    CHECK(save.dialogue_line_history.size() == 1);
    CHECK(save.text_log.size() == 1);
    CHECK(save.logical_timers.empty());
    REQUIRE(save.pending_timer_completions.size() == 1);
    CHECK(save.pending_timer_completions.front().id.value == timer.value().number());
    CHECK(std::holds_alternative<FlowMode>(save.mode));
    REQUIRE(save.flow_stack.size() == 1);
    CHECK(std::get<SavedRoomTransitionFrame>(save.flow_stack.front()).snapshot_id.value == 1);
}

TEST_CASE("save snapshots use distinct stable records for every live frame variant")
{
    const auto scene_project = load_fixture("scene-program.json");
    auto scene = make_save_state(scene_project, make_state(scene_project));
    REQUIRE(scene);
    REQUIRE(scene.value().flow_stack.size() == 1);
    CHECK(std::holds_alternative<SavedSceneFrame>(scene.value().flow_stack.front()));

    const auto dialogue_project = load_fixture("dialogue-program.json");
    auto dialogue = make_save_state(dialogue_project, make_state(dialogue_project));
    REQUIRE(dialogue);
    REQUIRE(dialogue.value().flow_stack.size() == 1);
    CHECK(std::holds_alternative<SavedDialogueFrame>(dialogue.value().flow_stack.front()));

    const auto room_project = load_fixture("comprehensive.json");
    auto room = make_save_state(room_project, make_state(room_project));
    REQUIRE(room);
    REQUIRE(room.value().flow_stack.size() == 1);
    CHECK(std::holds_alternative<SavedRoomTransitionFrame>(room.value().flow_stack.front()));

    const auto interaction_project = load_fixture("interaction-program.json");
    auto interaction_state = make_state(interaction_project);
    FlowExecutor flow(interaction_project, interaction_state);
    REQUIRE(flow.advance_room_transition(RoomTransitionStage::BeforeEnter));
    REQUIRE(flow.advance_room_transition(RoomTransitionStage::BeforeEnter, 1));
    REQUIRE(flow.advance_room_transition(RoomTransitionStage::CommitRoomSwitch));
    REQUIRE(flow.advance_room_transition(RoomTransitionStage::AfterEnter));
    REQUIRE(flow.advance_room_transition(RoomTransitionStage::AfterEnter, 1));
    REQUIRE(flow.advance_room_transition(RoomTransitionStage::Complete));
    REQUIRE(flow.complete_room_transition());
    REQUIRE(flow.start_interaction(
        InteractionInvocationContext{
            id<VerbId>("use"),
            id<RoomId>("start"),
            {compiled::InteractableInteractionSubject{id<InteractableId>("key")}}},
        InteractionRuleProgramRef{id<InteractionId>("actions"),
                                  id<InteractionRuleId>("any-context")}));
    auto interaction = make_save_state(interaction_project, interaction_state);
    REQUIRE(interaction);
    REQUIRE(interaction.value().flow_stack.size() == 1);
    CHECK(std::holds_alternative<SavedInteractionFrame>(interaction.value().flow_stack.front()));
}

TEST_CASE("desired presentation save restore remaps Scene and current Room owners and omits shell")
{
    SECTION("Scene invocation owners remap while shell records are omitted")
    {
        const auto project = load_fixture("scene-program.json");
        auto state = make_state(project);
        const auto frame = std::get<SceneFrame>(state.flow_stack().back());
        const ScenePresentationOwner scene_owner{frame.frame_id, frame.scene};
        const ActorPresentationKey scene_key =
            SceneActorKey{scene_owner, id<ActorSlotId>("hero-slot")};
        REQUIRE(
            state.set_actor(project, DesiredActorPresentation{scene_key,
                                                              scene_owner,
                                                              id<CharacterId>("hero"),
                                                              id<CharacterPoseId>("default"),
                                                              id<CharacterExpressionId>("neutral"),
                                                              std::nullopt,
                                                              {},
                                                              true,
                                                              false}));
        const ActorPresentationKey persistent_key = CharacterActorKey{id<CharacterId>("hero")};
        REQUIRE(
            state.set_actor(project, DesiredActorPresentation{persistent_key,
                                                              state.shell_presentation_owner(),
                                                              id<CharacterId>("hero"),
                                                              id<CharacterPoseId>("default"),
                                                              id<CharacterExpressionId>("neutral"),
                                                              std::nullopt,
                                                              {},
                                                              true,
                                                              true}));
        REQUIRE(
            state.present_text(project, PresentedTextState{id<CharacterId>("hero"), "Retained text",
                                                           TextMarkup::ActiveText}));

        auto saved = make_save_state(project, state);
        REQUIRE(saved);
        REQUIRE(saved.value().actors.size() == 1);
        REQUIRE(std::holds_alternative<SavedSceneActorKey>(saved.value().actors.front().key));
        CHECK(saved.value().presented_text->text == "Retained text");
        auto duplicate = saved.value();
        duplicate.actors.push_back(duplicate.actors.front());
        auto duplicate_valid = validate_save_state(project, duplicate, "duplicate-presentation");
        REQUIRE_FALSE(duplicate_valid);
        CHECK(duplicate_valid.error().front().code == "save_codec.duplicate_presentation_record");

        auto encoded = encode_save_state_text(project, saved.value());
        REQUIRE(encoded);
        auto decoded = decode_save_state_text(project, encoded.value(), "save-state-scene");
        REQUIRE(decoded);
        auto restored = test_support::restore_session(project, decoded.value());
        REQUIRE(restored);
        CHECK(restored.value().presentation_session_id() != state.presentation_session_id());
        CHECK(restored.value().shell_presentation_owner() != state.shell_presentation_owner());
        REQUIRE(restored.value().actors().size() == 1);
        const auto* restored_key =
            std::get_if<SceneActorKey>(&restored.value().actors().front().key);
        REQUIRE(restored_key);
        const auto& restored_frame = std::get<SceneFrame>(restored.value().flow_stack().back());
        CHECK(restored_key->owner.invocation == restored_frame.frame_id);
        CHECK(restored_key->owner.scene == restored_frame.scene);
        REQUIRE(restored.value().presented_text());
        CHECK(restored.value().presented_text()->text == "Retained text");
    }

    SECTION("current Room owner rebinds to the restored visit instance")
    {
        const auto project = load_fixture("minimal.json");
        auto state = make_state(project);
        FlowExecutor flow(project, state);
        finish_initial_room_transition(flow);
        REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
        REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
        const auto original_owner = state.current_room_presentation_owner();
        REQUIRE(original_owner);
        const auto shared_environment = id<PresentationEnvironmentInstanceId>("shared-environment");
        REQUIRE(state.upsert_presentation_environment(
            project, environment(shared_environment, *original_owner, "rain-loop")));
        REQUIRE(state.upsert_presentation_environment(
            project, environment(shared_environment, RoomPresentationOwner{id<RoomId>("start")},
                                 "wind-loop")));
        REQUIRE(state.upsert_presentation_environment(
            project,
            environment(shared_environment, state.session_presentation_owner(), "stars-loop")));

        auto saved = make_save_state(project, state);
        REQUIRE(saved);
        REQUIRE(saved.value().presentation_environments.size() == 3);
        CHECK(std::holds_alternative<SavedCurrentRoomPresentationOwner>(
            saved.value().presentation_environments.front().owner));
        auto encoded = encode_save_state(project, saved.value());
        REQUIRE(encoded);
        REQUIRE(encoded.value()["presentation"]["environments"].size() == 3);
        const auto& encoded_environment = encoded.value()["presentation"]["environments"][0];
        CHECK(encoded_environment["stopKey"] == "rain-loop");
        CHECK(encoded_environment["material"] == "sprite-material");
        CHECK(encoded_environment["scrollPerSecond"]["x"] == 0.1);
        CHECK(encoded_environment["opacity"] == 0.8);
        CHECK_FALSE(encoded_environment.contains("phase"));
        CHECK_FALSE(encoded_environment.contains("operation"));
        CHECK_FALSE(encoded_environment.contains("backend"));
        auto restored = test_support::restore_session(project, saved.value());
        REQUIRE(restored);
        REQUIRE(restored.value().presentation_environments().size() == 3);
        const auto restored_record = std::find_if(
            restored.value().presentation_environments().begin(),
            restored.value().presentation_environments().end(),
            [&shared_environment](const DesiredPresentationEnvironment& value) {
                return value.instance == shared_environment &&
                       std::holds_alternative<CurrentRoomPresentationOwner>(value.owner);
            });
        REQUIRE(restored_record != restored.value().presentation_environments().end());
        const auto* restored_owner =
            std::get_if<CurrentRoomPresentationOwner>(&restored_record->owner);
        REQUIRE(restored_owner);
        CHECK(restored_owner->room == original_owner->room);
        CHECK(restored_owner->visit != original_owner->visit);
        CHECK(restored.value().presentation_owner_is_active(*restored_owner));
        CHECK(restored_record->stop_key == id<PresentationEnvironmentStopKey>("rain-loop"));
        CHECK(restored_record->material == id<MaterialId>("sprite-material"));
        CHECK(restored_record->scroll_per_second.x == Catch::Approx(0.1));
        CHECK(restored_record->opacity == Catch::Approx(0.8));
    }
}

TEST_CASE("desired audio save restore persists loop policy without backend playback progress")
{
    const auto project = load_fixture("scene-program.json");
    auto state = make_state(project);
    const auto owner = state.session_presentation_owner();
    REQUIRE(state.upsert_desired_audio(
        project,
        DesiredAudioInstance{id<DesiredAudioInstanceId>("background-music"), owner,
                             compiled::AudioChannel::Music, id<AssetId>("audio-voice"), 0.7,
                             std::chrono::milliseconds{125}, std::chrono::milliseconds{250},
                             id<DesiredAudioReplacementKey>("background-music")}));
    REQUIRE(state.upsert_desired_audio(project,
                                       DesiredAudioInstance{id<DesiredAudioInstanceId>("rain-near"),
                                                            owner, compiled::AudioChannel::Ambient,
                                                            id<AssetId>("audio-voice"), 0.35}));

    auto saved = make_save_state(project, state);
    REQUIRE(saved);
    REQUIRE(saved.value().desired_audio.size() == 2);
    auto encoded = encode_save_state(project, saved.value());
    REQUIRE(encoded);
    const auto& records = encoded.value()["presentation"]["desiredAudio"];
    REQUIRE(records.size() == 2);
    for (const auto& record : records) {
        CHECK(record.contains("instance"));
        CHECK(record.contains("owner"));
        CHECK(record.contains("bus"));
        CHECK(record.contains("asset"));
        CHECK(record.contains("volume"));
        CHECK(record.contains("fadeInMs"));
        CHECK(record.contains("fadeOutMs"));
        CHECK(record.contains("replacementKey"));
        CHECK(record.size() == 8);
        CHECK_FALSE(record.contains("playing"));
        CHECK_FALSE(record.contains("track"));
        CHECK_FALSE(record.contains("voice"));
        CHECK_FALSE(record.contains("decoder"));
        CHECK_FALSE(record.contains("samplePosition"));
        CHECK_FALSE(record.contains("playbackPosition"));
    }

    auto decoded = decode_save_state_wire(encoded.value(), "desired-audio-save.json");
    REQUIRE(decoded);
    auto restored = test_support::restore_session(project, decoded.value());
    REQUIRE(restored);
    REQUIRE(restored.value().desired_audio().size() == 2);
    const auto* music =
        restored.value().desired_audio(id<DesiredAudioInstanceId>("background-music"),
                                       restored.value().session_presentation_owner());
    REQUIRE(music != nullptr);
    CHECK(music->bus == compiled::AudioChannel::Music);
    CHECK(music->volume == Catch::Approx(0.7));
    CHECK(music->fade_in == std::chrono::milliseconds{125});
    CHECK(music->fade_out == std::chrono::milliseconds{250});
}

TEST_CASE("actor idle selection persists while loop phase remains backend local")
{
    const auto project = load_fixture("scene-program.json", [](nlohmann::json& document) {
        auto& character = document["definitions"]["characters"][0];
        character["idles"] = nlohmann::json::array({{{"id", "breathing"},
                                                     {"kind", "bob"},
                                                     {"amplitude", 0.01},
                                                     {"periodMs", 1600},
                                                     {"clock", "gameplay"}}});
        character["defaults"]["idleId"] = "breathing";
    });
    auto state = make_state(project);
    REQUIRE(state.set_actor(project,
                            DesiredActorPresentation{CharacterActorKey{id<CharacterId>("hero")},
                                                     state.session_presentation_owner(),
                                                     id<CharacterId>("hero"),
                                                     id<CharacterPoseId>("default"),
                                                     id<CharacterExpressionId>("neutral"),
                                                     id<CharacterIdleId>("breathing"),
                                                     {},
                                                     true,
                                                     true}));

    auto saved = make_save_state(project, state);
    REQUIRE(saved);
    REQUIRE(saved.value().actors.size() == 1);
    CHECK(saved.value().actors.front().idle == id<CharacterIdleId>("breathing"));
    auto encoded = encode_save_state(project, saved.value());
    REQUIRE(encoded);
    CHECK(encoded.value()["presentation"]["actors"][0]["idle"] == "breathing");
    CHECK_FALSE(encoded.value()["presentation"]["actors"][0].contains("phase"));

    auto restored = test_support::restore_session(project, saved.value());
    REQUIRE(restored);
    REQUIRE(restored.value().actors().size() == 1);
    CHECK(restored.value().actors().front().idle == id<CharacterIdleId>("breathing"));
}

TEST_CASE("invalid environment restoration is failure atomic")
{
    const auto project = load_fixture("comprehensive.json");
    auto state = make_state(project);
    auto desired = environment(id<PresentationEnvironmentInstanceId>("weather"),
                               state.session_presentation_owner(), "weather");
    desired.asset = id<AssetId>("image-main");
    REQUIRE(state.upsert_presentation_environment(project, desired));
    auto saved = make_save_state(project, state);
    REQUIRE(saved);

    SECTION("missing image resource")
    {
        auto invalid = saved.value();
        invalid.presentation_environments.front().asset = id<AssetId>("missing-image");
        CHECK_FALSE(test_support::restore_session(project, invalid));
        REQUIRE(state.presentation_environments().size() == 1);
        CHECK(state.presentation_environments().front().asset == id<AssetId>("image-main"));
    }

    SECTION("stale Room owner")
    {
        auto invalid = saved.value();
        invalid.presentation_environments.front().owner =
            SavedRoomPresentationOwner{id<RoomId>("missing-room")};
        CHECK_FALSE(test_support::restore_session(project, invalid));
        REQUIRE(state.presentation_environments().size() == 1);
        CHECK(state.presentation_environments().front().owner ==
              PresentationOwner{state.session_presentation_owner()});
    }
}

TEST_CASE("immutable Room loops and Character idles reconstruct after load without save records")
{
    const auto project = load_fixture("comprehensive.json", [](nlohmann::json& document) {
        auto& character = document["definitions"]["characters"][0];
        character["idles"] = nlohmann::json::array({{{"id", "breathing"},
                                                     {"kind", "pulse"},
                                                     {"amplitude", 0.02},
                                                     {"periodMs", 1800},
                                                     {"clock", "gameplay"}}});
        character["defaults"]["idleId"] = "breathing";
        auto& rooms = document["definitions"]["rooms"];
        auto room = std::find_if(rooms.begin(), rooms.end(), [](const nlohmann::json& value) {
            return value["id"] == "start";
        });
        REQUIRE(room != rooms.end());
        for (auto& hook : (*room)["lifecycle"]["hooks"])
            hook["effects"] = nlohmann::json::array();
        (*room)["environments"] = nlohmann::json::array(
            {{{"id", "rain"},
              {"condition", {{"kind", "always"}}},
              {"asset", {{"id", "image-main"}, {"kind", "asset"}}},
              {"material", {{"id", "sprite-material"}, {"kind", "material"}}},
              {"bounds", {{"x", 0.0}, {"y", 0.0}, {"width", 1.0}, {"height", 1.0}}},
              {"plane", "world-overlay"},
              {"order", 4},
              {"clock", "gameplay"},
              {"scrollPerSecond", {{"x", 0.0}, {"y", 0.1}}},
              {"opacity", 0.6},
              {"visible", true}}});
    });
    auto state = make_state(project);
    FlowExecutor flow(project, state);
    finish_initial_room_transition(flow);
    REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
    REQUIRE(state.move_character(
        project, id<CharacterId>("hero"),
        compiled::RoomPlacementRef{id<RoomId>("start"), id<RoomPlacementId>("key-placement")}));
    const auto before = resolve_room(project, state);
    REQUIRE(before.environments.size() == 1);
    REQUIRE(before.actors.size() == 1);
    CHECK(before.actors.front().idle == id<CharacterIdleId>("breathing"));

    auto saved = make_save_state(project, state);
    REQUIRE(saved);
    CHECK(saved.value().presentation_environments.empty());
    auto restored = test_support::restore_session(project, saved.value());
    REQUIRE(restored);
    const auto after = resolve_room(project, restored.value());
    REQUIRE(after.environments.size() == 1);
    CHECK(after.environments.front().environment == id<RoomEnvironmentId>("rain"));
    CHECK(after.environments.front().scroll_per_second.y == Catch::Approx(0.1));
    REQUIRE(after.actors.size() == 1);
    CHECK(after.actors.front().idle == id<CharacterIdleId>("breathing"));
}

TEST_CASE("save preflight permits logical blockers and rejects unsafe session states")
{
    const auto project = load_fixture("scene-program.json");

    SECTION("input and duration blockers retain snapshot-local ownership")
    {
        auto state = make_state(project);
        FlowExecutor flow(project, state);
        REQUIRE(flow.block_top(FlowBlockerKind::Input));
        auto input = make_save_state(project, state);
        REQUIRE(input);
        REQUIRE(input.value().blocker);
        CHECK(std::get<SavedInputBlocker>(*input.value().blocker).owner.value == 1);

        const auto blocker = *state.blocker();
        REQUIRE(flow.cancel_blocker(flow_blocker_owner(blocker), flow_blocker_handle(blocker)));
        auto duration = DurationWait::create(500ms);
        REQUIRE(duration);
        REQUIRE(flow.block_duration(duration.value()));
        const auto active = std::get<DurationFlowBlocker>(*state.blocker());
        REQUIRE(flow.advance_duration_blocker(active.owner, active.handle, 125ms));
        auto saved_duration = make_save_state(project, state);
        REQUIRE(saved_duration);
        REQUIRE(saved_duration.value().blocker);
        CHECK(std::get<SavedDurationBlocker>(*saved_duration.value().blocker).remaining == 375ms);
    }

    SECTION("presentation waits are rejected rather than reconstructed as post-operation state")
    {
        auto state = make_state(project);
        FlowExecutor flow(project, state);
        REQUIRE(flow.block_top(FlowBlockerKind::Presentation));
        auto snapshot = make_save_state(project, state);
        REQUIRE_FALSE(snapshot);
        CHECK(snapshot.error().front().code == "save.presentation_blocker_active");
    }

    SECTION("audio waits are rejected rather than reconstructed as post-operation state")
    {
        auto state = make_state(project);
        FlowExecutor flow(project, state);
        REQUIRE(flow.block_top(FlowBlockerKind::Audio));
        auto snapshot = make_save_state(project, state);
        REQUIRE_FALSE(snapshot);
        CHECK(snapshot.error().front().code == "save.audio_blocker_active");
    }

    SECTION("opaque script suspension is rejected")
    {
        auto state = make_state(project);
        FlowExecutor flow(project, state);
        REQUIRE(flow.block_top(FlowBlockerKind::Script));
        auto snapshot = make_save_state(project, state);
        REQUIRE_FALSE(snapshot);
        CHECK(snapshot.error().front().code == "save.opaque_script_suspension");
    }

    SECTION("execution faults are rejected deterministically")
    {
        auto state = make_state(project);
        FlowExecutor flow(project, state);
        REQUIRE_FALSE(flow.apply_target(FlowTarget{id<DialogueId>("missing")}));
        auto snapshot = make_save_state(project, state);
        REQUIRE_FALSE(snapshot);
        REQUIRE(snapshot.error().size() == 1);
        CHECK(snapshot.error()[0].code == "save.execution_fault");
    }
}

TEST_CASE("typed save codec strictly decodes and links a save against its CompiledProject")
{
    const auto project = load_fixture("inheritance-properties-localization.json");
    auto state = make_state(project);
    PropertyResolver properties(project, state);
    REQUIRE(state.set_variable(project, id<VariableId>("flag"), RuntimeValue{true}));
    REQUIRE(properties.set(PropertyOwnerRef{id<RoomId>("start")}, id<PropertyId>("mood"),
                           RuntimeValue{std::string{"tense"}}));
    auto snapshot = make_save_state(project, state);
    REQUIRE(snapshot);

    auto encoded = encode_save_state(project, snapshot.value());
    REQUIRE(encoded);
    CHECK(encoded.value()["schema"] == "noveltea.save.state");
    CHECK(encoded.value()["version"] == SaveStateMetadata::current_format_version);

    auto decoded = decode_save_state(project, encoded.value(), "save-fixture.json");
    REQUIRE(decoded);
    CHECK(decoded.value().metadata.project == project.identity().id);
    CHECK(decoded.value().property_overrides.size() == 1);

    SECTION("unknown wire fields and duplicate semantic records are rejected")
    {
        auto invalid = encoded.value();
        invalid["unexpected"] = true;
        CHECK_FALSE(decode_save_state_wire(invalid, "save-fixture.json"));

        invalid = encoded.value();
        invalid["variables"].push_back(invalid["variables"][0]);
        CHECK_FALSE(decode_save_state(project, invalid, "save-fixture.json"));
    }

    SECTION("project-aware linking rejects stale references and invalid typed values")
    {
        auto invalid = encoded.value();
        invalid["propertyOverrides"][0]["property"] = "missing";
        CHECK_FALSE(decode_save_state(project, invalid, "save-fixture.json"));

        invalid = encoded.value();
        invalid["variables"][0]["value"] = "not-a-boolean";
        CHECK_FALSE(decode_save_state(project, invalid, "save-fixture.json"));
    }

    SECTION("zero-duration logical timers remain valid save values")
    {
        auto valid = encoded.value();
        valid["logicalTimers"].push_back({{"id", 1}, {"remainingMs", 0}, {"repeatMs", nullptr}});
        auto timer_save = decode_save_state(project, valid, "save-fixture.json");
        REQUIRE(timer_save);
        REQUIRE(timer_save.value().logical_timers.size() == 1);
        CHECK(timer_save.value().logical_timers.front().remaining == 0ms);
    }

    SECTION("native invalid text-log discriminants are rejected before encoding")
    {
        auto invalid = snapshot.value();
        invalid.text_log.push_back(TextLogEntry{static_cast<TextLogEntryKind>(255),
                                                SystemTextLogOrigin{}, std::nullopt, "bad",
                                                TextMarkup::Plain});
        CHECK_FALSE(validate_save_state(project, invalid, "save-fixture.json"));
        CHECK_FALSE(encode_save_state(project, invalid));
    }

    SECTION("text encoding rejects invalid UTF-8 without entering a throwing JSON path")
    {
        auto invalid = snapshot.value();
        invalid.text_log.push_back(TextLogEntry{TextLogEntryKind::Notification,
                                                SystemTextLogOrigin{}, std::nullopt,
                                                std::string{"\xc3\x28", 2}, TextMarkup::Plain});
        auto text = encode_save_state_text(project, invalid);
        REQUIRE_FALSE(text);
        CHECK(text.error().front().code == "save_codec.invalid_utf8");
    }

    SECTION("stale selected-exit Room references fail without dereferencing missing data")
    {
        const auto room_project = load_fixture("comprehensive.json");
        auto room_snapshot = make_save_state(room_project, make_state(room_project));
        REQUIRE(room_snapshot);
        REQUIRE(room_snapshot.value().flow_stack.size() == 1);
        auto& frame = std::get<SavedRoomTransitionFrame>(room_snapshot.value().flow_stack.front());
        frame.source_room = id<RoomId>("missing-room");
        frame.selected_exit =
            compiled::RoomExitRef{id<RoomId>("missing-room"), id<RoomExitId>("missing-exit")};
        CHECK_FALSE(validate_save_state(room_project, room_snapshot.value(), "save-fixture.json"));
    }

    SECTION("failed decoding cannot mutate the independently live session")
    {
        auto invalid = encoded.value();
        invalid["metadata"]["project"] = "other-project";
        CHECK_FALSE(decode_save_state(project, invalid, "save-fixture.json"));
        CHECK(state.variable(project, id<VariableId>("flag")).value() == RuntimeValue{true});
        CHECK(state.property_override(PropertyOwnerRef{id<RoomId>("start")},
                                      id<PropertyId>("mood")) != nullptr);
    }
}

TEST_CASE("typed save restoration atomically reconstructs fresh session ownership")
{
    const auto project = load_fixture("inheritance-properties-localization.json");
    auto state = make_state(project);
    PropertyResolver properties(project, state);
    const auto start = PropertyOwnerRef{id<RoomId>("start")};
    const auto hall = PropertyOwnerRef{id<RoomId>("hall")};
    const auto tower = PropertyOwnerRef{id<RoomId>("tower")};
    const auto visits = id<PropertyId>("visit-count");
    const auto enabled = id<PropertyId>("enabled");

    REQUIRE(properties.set(start, visits, RuntimeValue{std::int64_t{5}}));
    REQUIRE(properties.set(hall, visits, RuntimeValue{std::int64_t{9}}));
    REQUIRE(properties.set(start, enabled, RuntimeValue{false}));
    REQUIRE(state.advance_time(125ms));
    auto timer = state.start_logical_timer(500ms);
    REQUIRE(timer);
    FlowExecutor flow(project, state);
    auto duration = DurationWait::create(300ms);
    REQUIRE(duration);
    REQUIRE(flow.block_duration(duration.value()));

    auto snapshot = make_save_state(project, state);
    REQUIRE(snapshot);
    auto restored = test_support::restore_session(project, snapshot.value());
    REQUIRE(restored);
    PropertyResolver restored_properties(project, restored.value());

    CHECK(restored.value().play_time() == 125ms);
    REQUIRE(restored.value().logical_timers().size() == 1);
    CHECK(restored.value().logical_timers().front().remaining == 500ms);
    REQUIRE(restored.value().blocker());
    REQUIRE(std::holds_alternative<DurationFlowBlocker>(*restored.value().blocker()));
    CHECK(std::get<DurationFlowBlocker>(*restored.value().blocker()).remaining == 300ms);
    CHECK(flow_frame_id(restored.value().flow_stack().front()).number() !=
          flow_frame_id(state.flow_stack().front()).number());
    const auto start_visits = restored_properties.get(start, visits);
    const auto hall_visits = restored_properties.get(hall, visits);
    const auto tower_visits = restored_properties.get(tower, visits);
    const auto start_enabled = restored_properties.get(start, enabled);
    REQUIRE(start_visits);
    REQUIRE(hall_visits);
    REQUIRE(tower_visits);
    REQUIRE(start_enabled);
    CHECK(std::get<RuntimeValue>(start_visits.value()) == RuntimeValue{std::int64_t{5}});
    CHECK(std::get<RuntimeValue>(hall_visits.value()) == RuntimeValue{std::int64_t{9}});
    CHECK(std::get<RuntimeValue>(tower_visits.value()) == RuntimeValue{std::int64_t{9}});
    CHECK(std::get<RuntimeValue>(start_enabled.value()) == RuntimeValue{true});

    REQUIRE(properties.unset(hall, visits));
    auto without_child = make_save_state(project, state);
    REQUIRE(without_child);
    auto restored_without_child = test_support::restore_session(project, without_child.value());
    REQUIRE(restored_without_child);
    PropertyResolver fallback(project, restored_without_child.value());
    const auto fallback_visits = fallback.get(hall, visits);
    REQUIRE(fallback_visits);
    CHECK(std::get<RuntimeValue>(fallback_visits.value()) == RuntimeValue{std::int64_t{7}});
}

TEST_CASE("typed restore supports completed Room and nested Scene to Dialogue flow")
{
    SECTION("completed Room reconstructs deterministic definition-owned presentation")
    {
        const auto project = load_fixture("inheritance-properties-localization.json");
        auto snapshot = make_save_state(project, make_state(project));
        REQUIRE(snapshot);
        snapshot.value().mode = RoomMode{id<RoomId>("start")};
        snapshot.value().flow_stack.clear();
        snapshot.value().blocker.reset();
        snapshot.value().room_visits = {{id<RoomId>("start"), 1}};
        snapshot.value().active_room_visit =
            RoomVisitContext{id<RoomId>("start"), std::nullopt, std::nullopt, 1};
        auto restored = test_support::restore_session(project, snapshot.value());
        REQUIRE(restored);
        CHECK(std::holds_alternative<RoomMode>(restored.value().mode()));
        CHECK(restored.value().flow_stack().empty());
        REQUIRE(restored.value().mounted_layouts().size() == 1);
        CHECK(restored.value().mounted_layouts().front().policy.visibility ==
              LayoutVisibility::Visible);
        CHECK_FALSE(restored.value().map_presentation());
    }

    SECTION("nested Dialogue frame receives fresh ownership and restores its input wait")
    {
        const auto project = load_fixture("scene-program.json");
        auto snapshot = make_save_state(project, make_state(project));
        REQUIRE(snapshot);
        REQUIRE(snapshot.value().flow_stack.size() == 1);
        snapshot.value().flow_stack.push_back(SavedDialogueFrame{
            SavedFlowFrameId{2},
            id<DialogueId>("intro"),
            {id<DialogueBlockId>("start"), id<DialogueSegmentId>("intro-line"), std::nullopt,
             DialogueFramePosition::Stage::PresentSegment, 0, false},
            CallerDestination{}});
        snapshot.value().blocker = SavedInputBlocker{SavedFlowFrameId{2}};
        auto restored = test_support::restore_session(project, snapshot.value());
        REQUIRE(restored);
        REQUIRE(restored.value().flow_stack().size() == 2);
        CHECK(std::holds_alternative<SceneFrame>(restored.value().flow_stack().front()));
        CHECK(std::holds_alternative<DialogueFrame>(restored.value().flow_stack().back()));
        REQUIRE(restored.value().blocker());
        CHECK(flow_blocker_owner(*restored.value().blocker()) ==
              flow_frame_id(restored.value().flow_stack().back()));
    }

    SECTION("transient Scene roots retain their ResumeRoom destination")
    {
        const auto project = load_fixture("scene-program.json");
        auto snapshot = make_save_state(project, make_state(project));
        REQUIRE(snapshot);
        auto& root = std::get<SavedSceneFrame>(snapshot.value().flow_stack.front());
        root.destination = ResumeRoomDestination{id<RoomId>("start")};
        auto restored = test_support::restore_session(project, snapshot.value());
        REQUIRE(restored);
        CHECK(std::holds_alternative<ResumeRoomDestination>(
            flow_return_destination(restored.value().flow_stack().front())));
    }
}
