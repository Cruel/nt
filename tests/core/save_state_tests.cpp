#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/flow_executor.hpp>
#include <noveltea/core/property_resolver.hpp>
#include <noveltea/core/save_state.hpp>

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
    CHECK(save.variables.size() == project.variables().size());
    REQUIRE(save.property_overrides.size() == 1);
    CHECK(save.property_overrides.front().owner() == PropertyOwnerRef{id<RoomId>("start")});
    CHECK(save.property_overrides.front().property_id() == id<PropertyId>("mood"));
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
    CHECK(save.pending_timer_completions.front().id == timer.value());
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

    SECTION("presentation waits reconstruct post-operation and are not serialized")
    {
        auto state = make_state(project);
        FlowExecutor flow(project, state);
        REQUIRE(flow.block_top(FlowBlockerKind::Presentation));
        auto snapshot = make_save_state(project, state);
        REQUIRE(snapshot);
        CHECK_FALSE(snapshot.value().blocker);
    }

    SECTION("audio waits reconstruct post-operation and are not serialized")
    {
        auto state = make_state(project);
        FlowExecutor flow(project, state);
        REQUIRE(flow.block_top(FlowBlockerKind::Audio));
        auto snapshot = make_save_state(project, state);
        REQUIRE(snapshot);
        CHECK_FALSE(snapshot.value().blocker);
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
