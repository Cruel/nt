#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/flow_executor.hpp>
#include <noveltea/core/property_resolver.hpp>
#include <noveltea/core/save_state.hpp>
#include <noveltea/core/save_state_codec.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <algorithm>
#include <fstream>
#include <iterator>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>

using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;
using namespace std::chrono_literals;

namespace {
template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    return std::move(result).value();
}

CompiledProject load_fixture(std::string_view filename)
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
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
    auto restored = FlowExecutor::restore_session(project, snapshot.value());
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
            id<VerbId>("use"), id<RoomId>("start"), {id<InteractableId>("key")}},
        InteractionRuleProgramRef{id<InteractionId>("actions"),
                                  id<InteractionRuleId>("any-context")}));
    auto interaction = make_save_state(interaction_project, interaction_state);
    REQUIRE(interaction);
    REQUIRE(interaction.value().flow_stack.size() == 1);
    CHECK(std::holds_alternative<SavedInteractionFrame>(interaction.value().flow_stack.front()));
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

    SECTION("faults and queued host requests are rejected deterministically")
    {
        auto state = make_state(project);
        FlowExecutor flow(project, state);
        REQUIRE_FALSE(flow.apply_target(FlowTarget{id<DialogueId>("missing")}));
        auto snapshot =
            make_save_state(project, state, SaveSnapshotContext{.in_flight_external_requests = 2});
        REQUIRE_FALSE(snapshot);
        REQUIRE(snapshot.error().size() == 2);
        CHECK(snapshot.error()[0].code == "save.execution_fault");
        CHECK(snapshot.error()[1].code == "save.external_requests_pending");
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
    auto restored = FlowExecutor::restore_session(project, snapshot.value());
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
    auto restored_without_child = FlowExecutor::restore_session(project, without_child.value());
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
        auto restored = FlowExecutor::restore_session(project, snapshot.value());
        REQUIRE(restored);
        CHECK(std::holds_alternative<RoomMode>(restored.value().mode()));
        CHECK(restored.value().flow_stack().empty());
        REQUIRE(restored.value().background());
        REQUIRE(restored.value().overlays().size() == 1);
        CHECK(restored.value().overlays().front().visible);
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
        auto restored = FlowExecutor::restore_session(project, snapshot.value());
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
        auto restored = FlowExecutor::restore_session(project, snapshot.value());
        REQUIRE(restored);
        CHECK(std::holds_alternative<ResumeRoomDestination>(
            flow_return_destination(restored.value().flow_stack().front())));
    }
}
