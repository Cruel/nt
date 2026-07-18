#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/flow_executor.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/runtime/runtime_checkpoint_service.hpp"
#include "runtime_test_services.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <fstream>
#include <iterator>
#include <string>
#include <string_view>

namespace noveltea::script::test {
namespace {

using RuntimeCheckpointService = runtime::RuntimeCheckpointService;
using RuntimeCheckpointFacts = runtime::RuntimeCheckpointFacts;

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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());

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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());

    core::FlowExecutor flow(project, state);
    REQUIRE(flow.block_top(core::FlowBlockerKind::Script));

    REQUIRE_FALSE(service.publish_candidate(state));
    REQUIRE(service.readiness().issues.size() == 1);
    CHECK(service.readiness().issues[0].reason ==
          core::CheckpointReadinessReason::SaveProjectionFailed);
    CHECK(service.readiness().issues[0].diagnostic.code == "save.opaque_script_suspension");
}

TEST_CASE("checkpoint service retains desired presentation and rejects causal blockers")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves, test_support::save_codec());

    REQUIRE(state.present_text(project, core::PresentedTextState{std::nullopt, "Visible text"}));
    REQUIRE(service.publish_candidate(state));
    REQUIRE(service.latest_checkpoint());
    CHECK(service.readiness().can_capture());

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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
    REQUIRE(service.publish_candidate(state));
    const auto retained_bytes = service.latest_checkpoint()->encoded_save;
    const auto manual = core::TypedSaveSlotId::manual(3);

    core::FlowExecutor flow(project, state);
    auto blocker = flow.block_top(core::FlowBlockerKind::Presentation);
    REQUIRE(blocker);
    (void)service.request(core::ManualSaveRequest{manual});
    auto blocked_facts = ready_facts();
    blocked_facts.flow_blocker = state.blocker();
    REQUIRE(service.settle(state, blocked_facts, {.structural = true}));
    auto outcomes = service.take_completed_save_outcomes();
    REQUIRE(std::holds_alternative<core::CheckpointWriteSucceeded>(outcomes.front()));
    CHECK(saves.slots[manual] == retained_bytes);

    REQUIRE(flow.cancel_blocker(core::flow_blocker_owner(blocker.value()),
                                core::flow_blocker_handle(blocker.value())));
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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
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
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
    core::FlowExecutor flow(project, state);
    REQUIRE(flow.block_top(core::FlowBlockerKind::Presentation));
    const auto slot = core::TypedSaveSlotId::manual(9);
    REQUIRE(service.request(core::ManualSaveRequest{slot}));
    auto blocked_facts = ready_facts();
    blocked_facts.flow_blocker = state.blocker();
    REQUIRE(service.settle(state, blocked_facts, {.structural = true}));
    auto outcomes = service.take_completed_save_outcomes();
    REQUIRE(outcomes.size() == 1);
    REQUIRE(std::holds_alternative<core::CheckpointSaveFailed>(outcomes.front()));
    CHECK(std::get<core::CheckpointSaveFailed>(outcomes.front()).stage ==
          core::CheckpointSaveFailureStage::NoRetainedCheckpoint);
}

TEST_CASE("loaded checkpoint becomes exact retained baseline and service reset clears lifecycle")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    RecordingSaveStore saves;
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
    REQUIRE(service.publish_candidate(state));
    const auto original_revision = service.latest_checkpoint()->revision;

    auto decoded = core::make_save_state(project, state);
    REQUIRE(decoded);
    const std::string exact_bytes = "exact loaded slot bytes";
    const core::SaveCheckpointMetadata metadata{
        .save_format_version = decoded.value().metadata.format_version,
        .project = decoded.value().metadata.project,
        .project_version = decoded.value().metadata.project_version,
        .play_time = decoded.value().play_time,
        .generations = {4, 4, 7, 7}};
    const core::SaveCheckpointThumbnail thumbnail{.encoding =
                                                      core::SaveCheckpointThumbnailEncoding::Png,
                                                  .width = 320,
                                                  .height = 180,
                                                  .bytes = "\x89PNG\r\n\x1a\nloaded-thumbnail"};
    auto prepared =
        service.prepare_loaded_checkpoint(exact_bytes, *decoded.value_if(), metadata, thumbnail);
    REQUIRE(prepared);
    CHECK(prepared.value().revision.number() == original_revision.number() + 1);
    service.commit_loaded_checkpoint(std::move(prepared).value());
    REQUIRE(service.latest_checkpoint());
    CHECK(service.latest_checkpoint()->encoded_save == exact_bytes);
    CHECK(service.latest_checkpoint()->metadata == metadata);
    REQUIRE(service.latest_checkpoint()->thumbnail);
    CHECK(*service.latest_checkpoint()->thumbnail == thumbnail);
    CHECK(service.generations() == core::CheckpointGenerationState{});

    service.reset();
    CHECK_FALSE(service.latest_checkpoint());
    CHECK_FALSE(service.pending_deferred_autosave());
    CHECK(service.generations() == core::CheckpointGenerationState{});
    REQUIRE(service.publish_candidate(state));
    CHECK(service.latest_checkpoint()->revision.number() == 1);
}

TEST_CASE("checkpoint thumbnail is revision-bound and updates every matching retained slot")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
    const auto presentation = core::PresentationSnapshotRevision::from_number(7);
    REQUIRE(service.publish_candidate(state, presentation));
    REQUIRE(service.latest_checkpoint());
    REQUIRE(service.pending_thumbnail_capture());
    const auto request = *service.pending_thumbnail_capture();
    CHECK(request.checkpoint == service.latest_checkpoint()->revision);
    CHECK(request.presentation == presentation);

    const auto slot = core::TypedSaveSlotId::manual(12);
    const auto written = service.request(core::ImmediateRetainedCheckpointWriteRequest{slot});
    REQUIRE(std::holds_alternative<core::CheckpointWriteSucceeded>(written));
    REQUIRE(saves.read_checkpoint(slot));
    CHECK_FALSE(saves.read_checkpoint(slot).value().thumbnail);

    const core::SaveCheckpointThumbnail thumbnail{.encoding =
                                                      core::SaveCheckpointThumbnailEncoding::Png,
                                                  .width = 640,
                                                  .height = 360,
                                                  .bytes = "\x89PNG\r\n\x1a\ncheckpoint-thumbnail"};
    REQUIRE(service.attach_thumbnail(request, thumbnail));
    REQUIRE(service.latest_checkpoint()->thumbnail);
    CHECK(*service.latest_checkpoint()->thumbnail == thumbnail);
    CHECK_FALSE(service.pending_thumbnail_capture());
    const auto stored = saves.read_checkpoint(slot);
    REQUIRE(stored);
    REQUIRE(stored.value().metadata);
    REQUIRE(stored.value().thumbnail);
    CHECK(stored.value().encoded_save == service.latest_checkpoint()->encoded_save);
    CHECK(*stored.value().metadata == service.latest_checkpoint()->metadata);
    CHECK(*stored.value().thumbnail == thumbnail);

    REQUIRE(service.record_structural_mutation());
    REQUIRE(service.publish_candidate(state, core::PresentationSnapshotRevision::from_number(8)));
    auto stale = service.attach_thumbnail(request, thumbnail);
    REQUIRE_FALSE(stale);
    CHECK(stale.error().front().code == "checkpoint.stale_thumbnail");
}

TEST_CASE("checkpoint thumbnail token prevents stale attachment across revision reset collisions")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
    const auto presentation = core::PresentationSnapshotRevision::from_number(3);
    REQUIRE(service.publish_candidate(state, presentation));
    REQUIRE(service.pending_thumbnail_capture());
    const auto stale_request = *service.pending_thumbnail_capture();

    service.reset();
    REQUIRE(service.publish_candidate(state, presentation));
    REQUIRE(service.pending_thumbnail_capture());
    const auto current_request = *service.pending_thumbnail_capture();
    CHECK(current_request.checkpoint == stale_request.checkpoint);
    CHECK(current_request.presentation == stale_request.presentation);
    CHECK(current_request.capture_token != stale_request.capture_token);

    const core::SaveCheckpointThumbnail thumbnail{
        .encoding = core::SaveCheckpointThumbnailEncoding::Png,
        .width = 160,
        .height = 90,
        .bytes = "\x89PNG\r\n\x1a\nreset-collision-thumbnail"};
    auto stale = service.attach_thumbnail(stale_request, thumbnail);
    REQUIRE_FALSE(stale);
    CHECK(stale.error().front().code == "checkpoint.stale_thumbnail");
    REQUIRE(service.attach_thumbnail(current_request, thumbnail));
}

TEST_CASE("checkpoint observation exposes readiness and replay distance without changing safety")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
    auto facts = ready_facts();
    facts.presentation_revision = core::PresentationSnapshotRevision::from_number(4);
    REQUIRE(service.settle(state, facts, {.structural = true}));

    REQUIRE(state.advance_time(std::chrono::milliseconds{250}));
    auto blocked = ready_facts();
    blocked.presentation_revision = core::PresentationSnapshotRevision::from_number(4);
    blocked.presentation_status = {
        core::CheckpointStatusRevision::from_number(2),
        {core::CheckpointBarrier{core::CheckpointBarrierId::from_number(5),
                                 core::PresentationCheckpointBarrierSource{
                                     core::PresentationOperationId::from_number(5)},
                                 core::CheckpointBarrierKind::PresentationCausalOperation}},
        {}};
    REQUIRE(
        service.settle(state, blocked, {.time = true, .elapsed = std::chrono::milliseconds{250}}));
    const auto observation = service.observation(state);
    CHECK_FALSE(observation.readiness.can_capture());
    CHECK(observation.presentation.active_barriers.size() == 1);
    CHECK(observation.replay_distance.time_generations == 1);
    CHECK(observation.replay_distance.play_time == std::chrono::milliseconds{250});
    CHECK(observation.thumbnail_capture_pending);
    CHECK_FALSE(observation.thumbnail_available);
}

TEST_CASE("checkpoint readiness rejects reconstructible activity for another snapshot revision")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
    auto facts = ready_facts();
    facts.presentation_revision = core::PresentationSnapshotRevision::from_number(9);
    facts.presentation_status = {core::CheckpointStatusRevision::from_number(2),
                                 {},
                                 core::PresentationReconstructibleActivity{
                                     .snapshot = core::PresentationSnapshotRevision::from_number(8),
                                     .actor_idles = {},
                                     .environment_loops = {},
                                     .desired_audio = {}}};

    REQUIRE(service.settle(state, facts, {}));
    REQUIRE_FALSE(service.readiness().can_capture());
    REQUIRE(service.readiness().issues.size() == 1);
    CHECK(service.readiness().issues.front().reason ==
          core::CheckpointReadinessReason::ReconstructibleStateInvalid);
    CHECK(service.readiness().issues.front().diagnostic.code ==
          "checkpoint.reconstructible_activity_revision_mismatch");
    CHECK_FALSE(service.latest_checkpoint());
}

TEST_CASE("loaded checkpoint rejects metadata that describes different save content")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
    auto decoded = core::make_save_state(project, state);
    REQUIRE(decoded);
    core::SaveCheckpointMetadata mismatched{
        .save_format_version = decoded.value().metadata.format_version,
        .project = decoded.value().metadata.project,
        .project_version = decoded.value().metadata.project_version,
        .play_time = std::chrono::milliseconds{99},
        .generations = {}};
    auto prepared = service.prepare_loaded_checkpoint("exact", decoded.value(), mismatched);
    REQUIRE_FALSE(prepared);
    CHECK(prepared.error().front().code == "checkpoint.stored_metadata_mismatch");
}

TEST_CASE("loaded checkpoint without thumbnail captures the restored presentation revision")
{
    const auto project = load_fixture("minimal.json");
    auto state = make_state(project);
    core::TypedMemorySaveSlotStore saves;
    RuntimeCheckpointService service(project, saves, test_support::save_codec());
    auto decoded = core::make_save_state(project, state);
    REQUIRE(decoded);

    auto prepared = service.prepare_loaded_checkpoint("exact", decoded.value());
    REQUIRE(prepared);
    service.commit_loaded_checkpoint(std::move(prepared).value());
    CHECK_FALSE(service.pending_thumbnail_capture());

    auto facts = ready_facts();
    facts.presentation_revision = core::PresentationSnapshotRevision::from_number(21);
    REQUIRE(service.settle(state, facts, {}));
    REQUIRE(service.pending_thumbnail_capture());
    CHECK(service.pending_thumbnail_capture()->checkpoint == service.latest_checkpoint()->revision);
    CHECK(service.pending_thumbnail_capture()->presentation == *facts.presentation_revision);
}

} // namespace noveltea::script::test
