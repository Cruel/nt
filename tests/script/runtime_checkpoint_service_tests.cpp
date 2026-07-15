#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/flow_executor.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/script/runtime_checkpoint_service.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <fstream>
#include <iterator>
#include <string>
#include <string_view>

namespace noveltea::script::test {
namespace {

core::CompiledProject load_fixture(std::string_view filename)
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto decoded =
        core::decode_compiled_project(nlohmann::json::parse(source), std::string(filename));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

core::SessionState make_state(const core::CompiledProject& project)
{
    auto state = core::SessionState::create(project);
    REQUIRE(state);
    return std::move(state).value();
}

template<class Id> Id id(std::string value)
{
    auto parsed = Id::create(std::move(value));
    REQUIRE(parsed);
    return std::move(parsed).value();
}

class RecordingSaveStore final : public core::TypedSaveSlotStore {
public:
    bool fail_writes = false;
    std::vector<std::string> attempted_bytes;
    std::unordered_map<core::TypedSaveSlotId, std::string, core::TypedSaveSlotIdHash> slots;

    core::Result<bool, core::Diagnostics> has_slot(core::TypedSaveSlotId slot) const override
    {
        return core::Result<bool, core::Diagnostics>::success(slots.contains(slot));
    }
    core::Result<std::string, core::Diagnostics>
    read_slot(core::TypedSaveSlotId slot) const override
    {
        const auto found = slots.find(slot);
        if (found == slots.end())
            return core::Result<std::string, core::Diagnostics>::failure(
                core::Diagnostics{core::Diagnostic{"test.missing", "missing"}});
        return core::Result<std::string, core::Diagnostics>::success(found->second);
    }
    core::Result<void, core::Diagnostics> write_slot(core::TypedSaveSlotId slot,
                                                     std::string_view bytes) override
    {
        attempted_bytes.emplace_back(bytes);
        if (fail_writes)
            return core::Result<void, core::Diagnostics>::failure(
                core::Diagnostics{core::Diagnostic{"test.write_failed", "write failed"}});
        slots[slot] = std::string(bytes);
        return core::Result<void, core::Diagnostics>::success();
    }
    core::Result<void, core::Diagnostics> delete_slot(core::TypedSaveSlotId slot) override
    {
        slots.erase(slot);
        return core::Result<void, core::Diagnostics>::success();
    }
};

RuntimeCheckpointFacts ready_facts()
{
    return RuntimeCheckpointFacts{
        .presentation_status = {core::CheckpointStatusRevision::from_number(1), {}}};
}

} // namespace

TEST_CASE(
    "checkpoint service publishes immutable candidates and preserves them on projection failure")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);

    REQUIRE(service.publish_candidate(state));
    REQUIRE(service.latest_checkpoint());
    const auto retained = *service.latest_checkpoint();
    const auto retained_generations = service.generations();
    CHECK(retained.metadata.play_time == state.play_time());
    CHECK(retained.metadata.generations == service.generations());
    CHECK(retained.metadata.project == project.identity().id);
    CHECK(retained.metadata.project_version == project.identity().version);
    CHECK(retained.revision.number() == 1);

    auto decoded =
        core::decode_save_state_text(project, retained.encoded_save, "checkpoint-candidate-test");
    REQUIRE(decoded);
    CHECK(decoded.value().play_time == retained.metadata.play_time);
    CHECK(decoded.value().metadata.project == retained.metadata.project);
    CHECK(decoded.value().metadata.project_version == retained.metadata.project_version);

    core::FlowExecutor flow(project, state);
    REQUIRE(flow.block_top(core::FlowBlockerKind::Presentation));
    REQUIRE_FALSE(service.publish_candidate(state));
    REQUIRE(service.latest_checkpoint());
    CHECK(*service.latest_checkpoint() == retained);
    CHECK(service.generations() == retained_generations);
    REQUIRE_FALSE(service.readiness().can_capture());
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::SaveProjectionFailed);
}

TEST_CASE("checkpoint service preserves deterministic projection diagnostic ordering")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);

    core::FlowExecutor flow(project, state);
    REQUIRE(flow.block_top(core::FlowBlockerKind::Script));

    REQUIRE_FALSE(service.publish_candidate(
        state, core::SaveSnapshotContext{.in_flight_external_requests = 1}));
    REQUIRE(service.readiness().issues.size() == 2);
    CHECK(service.readiness().issues[0].reason ==
          core::CheckpointReadinessReason::SaveProjectionFailed);
    CHECK(service.readiness().issues[0].diagnostic.code == "save.external_requests_pending");
    CHECK(service.readiness().issues[1].reason ==
          core::CheckpointReadinessReason::SaveProjectionFailed);
    CHECK(service.readiness().issues[1].diagnostic.code == "save.opaque_script_suspension");
}

TEST_CASE("checkpoint service rejects omitted presentation and causal blockers")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);

    REQUIRE(state.present_text(project, core::PresentedTextState{std::nullopt, "Visible text"}));
    REQUIRE_FALSE(service.publish_candidate(state));
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::ReconstructibleStateInvalid);

    state.clear_presented_text();
    core::FlowExecutor flow(project, state);
    REQUIRE(flow.block_top(core::FlowBlockerKind::Presentation));
    REQUIRE_FALSE(service.publish_candidate(state));
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::SaveProjectionFailed);
    CHECK(service.readiness().issues.front().diagnostic.code == "save.presentation_blocker_active");
}

TEST_CASE("checkpoint service preserves retained bytes when encoding fails")
{
    const auto project = load_fixture("scene-program.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);
    REQUIRE(service.publish_candidate(state));
    const auto retained = *service.latest_checkpoint();
    const auto retained_generations = service.generations();

    REQUIRE(state.set_variable(project, id<core::VariableId>("player-name"),
                               core::RuntimeValue{std::string{"\xff"}}));
    REQUIRE(service.record_structural_mutation());
    REQUIRE_FALSE(service.publish_candidate(state));
    CHECK(*service.latest_checkpoint() == retained);
    CHECK(service.generations().captured_structural_generation ==
          retained_generations.captured_structural_generation);
    CHECK(service.generations().captured_time_generation ==
          retained_generations.captured_time_generation);
    REQUIRE_FALSE(service.readiness().can_capture());
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::SaveEncodingFailed);
}

TEST_CASE("checkpoint service preserves retained state when candidate validation fails")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);
    REQUIRE(service.publish_candidate(state));
    const auto retained = *service.latest_checkpoint();
    const auto retained_generations = service.generations();

    core::TextLogEntry invalid_entry{
        .kind = core::TextLogEntryKind::Notification,
        .origin = core::SystemTextLogOrigin{},
        .speaker = std::nullopt,
        .text = "Invalid markup candidate",
        .markup = static_cast<core::TextMarkup>(255),
    };
    REQUIRE(state.append_text_log(project, std::move(invalid_entry)));
    REQUIRE(service.record_structural_mutation());

    REQUIRE_FALSE(service.publish_candidate(state));
    REQUIRE(service.latest_checkpoint());
    CHECK(*service.latest_checkpoint() == retained);
    CHECK(service.generations().captured_structural_generation ==
          retained_generations.captured_structural_generation);
    CHECK(service.generations().captured_time_generation ==
          retained_generations.captured_time_generation);
    REQUIRE_FALSE(service.readiness().can_capture());
    REQUIRE(service.readiness().issues.size() == 1);
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::SaveValidationFailed);
    CHECK(service.readiness().issues.front().diagnostic.code == "save_codec.invalid_text_log");
}

TEST_CASE("checkpoint settlement reports suspended Lua with deterministic revisions")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::FlowExecutor flow(project, state);
    REQUIRE(flow.block_top(core::FlowBlockerKind::Script));
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves);
    const RuntimeCheckpointFacts facts{
        .flow_blocker = state.blocker(),
        .presentation_status = {core::CheckpointStatusRevision::from_number(1), {}},
    };

    REQUIRE(service.settle(state, facts, {}));
    const auto revision = service.readiness().revision;
    REQUIRE(service.readiness().issues.size() == 2);
    CHECK(service.readiness().issues[0].reason ==
          core::CheckpointReadinessReason::FlowStateNotSerializable);
    CHECK(service.readiness().issues[1].reason ==
          core::CheckpointReadinessReason::SuspendedScriptInvocationActive);
    REQUIRE(service.settle(state, facts, {}));
    CHECK(service.readiness().revision == revision);
}

TEST_CASE("manual checkpoint saves refresh, retain, and reject invalid requests")
{
    const auto project = load_fixture("scene-program.json");
    auto state = make_state(project);
    RecordingSaveStore saves;
    RuntimeCheckpointService service(project, saves);
    REQUIRE(service.publish_candidate(state));

    const auto manual = core::TypedSaveSlotId::manual(2);
    REQUIRE(service.request(core::ManualSaveRequest{manual}));
    REQUIRE(service.settle(state, ready_facts(), {}));
    auto outcomes = service.take_completed_save_outcomes();
    REQUIRE(outcomes.size() == 1);
    const auto* retained = std::get_if<core::CheckpointWriteSucceeded>(&outcomes.front());
    REQUIRE(retained);
    CHECK(retained->source == core::CheckpointWriteSource::RetainedCheckpoint);

    REQUIRE(state.set_variable(project, id<core::VariableId>("count"), std::int64_t{8}));
    (void)service.request(core::ManualSaveRequest{manual});
    REQUIRE(service.settle(state, ready_facts(), {.structural = true}));
    outcomes = service.take_completed_save_outcomes();
    REQUIRE(outcomes.size() == 1);
    const auto* captured = std::get_if<core::CheckpointWriteSucceeded>(&outcomes.front());
    REQUIRE(captured);
    CHECK(captured->source == core::CheckpointWriteSource::CapturedCurrentState);

    const auto invalid =
        service.request(core::ManualSaveRequest{core::TypedSaveSlotId::autosave()});
    REQUIRE_FALSE(invalid);
    CHECK(std::get<core::CheckpointSaveFailed>(invalid.error()).stage ==
          core::CheckpointSaveFailureStage::InvalidRequest);
}

TEST_CASE("multiple manual checkpoint requests in one settlement all write the same revision")
{
    const auto project = load_fixture("scene-program.json");
    auto state = make_state(project);
    RecordingSaveStore saves;
    RuntimeCheckpointService service(project, saves);
    REQUIRE(service.publish_candidate(state));
    REQUIRE(state.set_variable(project, id<core::VariableId>("count"), std::int64_t{6}));

    const auto first = core::TypedSaveSlotId::manual(5);
    const auto second = core::TypedSaveSlotId::manual(6);
    REQUIRE(service.request(core::ManualSaveRequest{first}));
    REQUIRE(service.request(core::ManualSaveRequest{second}));
    REQUIRE(service.settle(state, ready_facts(), {.structural = true}));

    const auto outcomes = service.take_completed_save_outcomes();
    REQUIRE(outcomes.size() == 2);
    const auto* first_written = std::get_if<core::CheckpointWriteSucceeded>(&outcomes[0]);
    const auto* second_written = std::get_if<core::CheckpointWriteSucceeded>(&outcomes[1]);
    REQUIRE(first_written);
    REQUIRE(second_written);
    CHECK(first_written->checkpoint == second_written->checkpoint);
    CHECK(first_written->source == core::CheckpointWriteSource::CapturedCurrentState);
    CHECK(second_written->source == core::CheckpointWriteSource::CapturedCurrentState);
    CHECK(saves.slots[first] == saves.slots[second]);
}

TEST_CASE("manual checkpoint save uses retained state while ineligible and reports capture failure")
{
    const auto project = load_fixture("scene-program.json");
    auto state = make_state(project);
    RecordingSaveStore saves;
    RuntimeCheckpointService service(project, saves);
    REQUIRE(service.publish_candidate(state));
    const auto retained_bytes = service.latest_checkpoint()->encoded_save;
    const auto manual = core::TypedSaveSlotId::manual(3);

    REQUIRE(state.present_text(project, core::PresentedTextState{std::nullopt, "busy"}));
    (void)service.request(core::ManualSaveRequest{manual});
    REQUIRE(service.settle(state, ready_facts(), {.structural = true}));
    auto outcomes = service.take_completed_save_outcomes();
    REQUIRE(std::holds_alternative<core::CheckpointWriteSucceeded>(outcomes.front()));
    CHECK(saves.slots[manual] == retained_bytes);

    state.clear_presented_text();
    REQUIRE(state.set_variable(project, id<core::VariableId>("player-name"),
                               core::RuntimeValue{std::string{"\xff"}}));
    (void)service.request(core::ManualSaveRequest{manual});
    REQUIRE_FALSE(service.settle(state, ready_facts(), {.structural = true}));
    outcomes = service.take_completed_save_outcomes();
    REQUIRE(std::holds_alternative<core::CheckpointSaveFailed>(outcomes.front()));
    CHECK(std::get<core::CheckpointSaveFailed>(outcomes.front()).stage ==
          core::CheckpointSaveFailureStage::Capture);
}

TEST_CASE("deferred autosave targets the next publication and retries identical retained bytes")
{
    const auto project = load_fixture("scene-program.json");
    auto state = make_state(project);
    RecordingSaveStore saves;
    RuntimeCheckpointService service(project, saves);
    REQUIRE(service.publish_candidate(state));
    (void)service.request(core::DeferredAutosaveRequest{});
    REQUIRE(service.settle(state, ready_facts(), {}));
    CHECK(saves.attempted_bytes.empty());

    REQUIRE(state.set_variable(project, id<core::VariableId>("count"), std::int64_t{4}));
    saves.fail_writes = true;
    REQUIRE(service.settle(state, ready_facts(), {.structural = true}));
    REQUIRE(saves.attempted_bytes.size() == 1);
    const auto exact_target = saves.attempted_bytes.front();

    REQUIRE(state.set_variable(project, id<core::VariableId>("count"), std::int64_t{5}));
    saves.fail_writes = false;
    REQUIRE(service.settle(state, ready_facts(), {.structural = true}));
    REQUIRE(saves.attempted_bytes.size() == 2);
    CHECK(saves.attempted_bytes.back() == exact_target);
    CHECK_FALSE(service.pending_deferred_autosave());
}

TEST_CASE("immediate retained write never captures and reports missing retained state")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    RecordingSaveStore saves;
    RuntimeCheckpointService service(project, saves);
    const auto slot = core::TypedSaveSlotId::autosave();
    auto missing = service.request(core::ImmediateRetainedCheckpointWriteRequest{slot});
    REQUIRE(std::holds_alternative<core::CheckpointSaveFailed>(missing));
    CHECK(std::get<core::CheckpointSaveFailed>(missing).stage ==
          core::CheckpointSaveFailureStage::NoRetainedCheckpoint);
    REQUIRE(service.publish_candidate(state));
    const auto revision = service.latest_checkpoint()->revision;
    auto written = service.request(core::ImmediateRetainedCheckpointWriteRequest{slot});
    REQUIRE(std::holds_alternative<core::CheckpointWriteSucceeded>(written));
    CHECK(std::get<core::CheckpointWriteSucceeded>(written).checkpoint == revision);
}

TEST_CASE("ineligible manual save without retained state reports missing checkpoint")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    RecordingSaveStore saves;
    RuntimeCheckpointService service(project, saves);
    REQUIRE(state.present_text(project, core::PresentedTextState{std::nullopt, "busy"}));
    const auto slot = core::TypedSaveSlotId::manual(9);
    REQUIRE(service.request(core::ManualSaveRequest{slot}));
    REQUIRE(service.settle(state, ready_facts(), {.structural = true}));
    auto outcomes = service.take_completed_save_outcomes();
    REQUIRE(outcomes.size() == 1);
    REQUIRE(std::holds_alternative<core::CheckpointSaveFailed>(outcomes.front()));
    CHECK(std::get<core::CheckpointSaveFailed>(outcomes.front()).stage ==
          core::CheckpointSaveFailureStage::NoRetainedCheckpoint);
}

} // namespace noveltea::script::test
