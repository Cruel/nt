#include "noveltea/runtime/runtime_checkpoint_service.hpp"

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/save_state.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <utility>

namespace noveltea::runtime {
namespace {

core::Diagnostics checkpoint_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

void add_issue(std::vector<core::CheckpointReadinessIssue>& issues,
               core::CheckpointReadinessReason reason, core::Diagnostics diagnostics)
{
    for (const auto& diagnostic : diagnostics)
        issues.push_back(core::CheckpointReadinessIssue{reason, std::nullopt, diagnostic});
}

core::Diagnostic readiness_diagnostic(std::string code, std::string message)
{
    return core::Diagnostic{.code = std::move(code), .message = std::move(message)};
}

core::CheckpointBarrier make_barrier(std::uint64_t id, core::CheckpointBarrierSource source,
                                     core::CheckpointBarrierKind kind)
{
    return core::CheckpointBarrier{core::CheckpointBarrierId::from_number(id), std::move(source),
                                   kind};
}

void add_barrier_issue(std::vector<core::CheckpointReadinessIssue>& issues,
                       core::CheckpointReadinessReason reason, core::CheckpointBarrier barrier,
                       std::string code, std::string message)
{
    issues.push_back(core::CheckpointReadinessIssue{
        reason, std::move(barrier), readiness_diagnostic(std::move(code), std::move(message))});
}

} // namespace

RuntimeCheckpointService::RuntimeCheckpointService(const core::CompiledProject& project,
                                                   core::TypedSaveSlotStore& saves) noexcept
    : m_project(project), m_saves(saves),
      m_readiness{core::CheckpointReadinessRevision::from_number(1), {}}
{
}

core::Result<void, core::Diagnostics> RuntimeCheckpointService::record_structural_mutation()
{
    if (m_generations.structural_generation == std::numeric_limits<std::uint64_t>::max())
        return core::Result<void, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.structural_generation_exhausted",
                             "Checkpoint structural generation identity is exhausted."));
    ++m_generations.structural_generation;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCheckpointService::record_time_mutation()
{
    if (m_generations.time_generation == std::numeric_limits<std::uint64_t>::max())
        return core::Result<void, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.time_generation_exhausted",
                             "Checkpoint time generation identity is exhausted."));
    ++m_generations.time_generation;
    return core::Result<void, core::Diagnostics>::success();
}

bool RuntimeCheckpointService::time_only_refresh_due(std::chrono::milliseconds now) const noexcept
{
    return now >= m_next_time_only_refresh;
}

core::Result<void, core::Diagnostics>
RuntimeCheckpointService::settle(const core::SessionState& session,
                                 const RuntimeCheckpointFacts& facts,
                                 RuntimeTransactionMutations mutations)
{
    if (mutations.elapsed.count() < 0)
        mutations.elapsed = std::chrono::milliseconds{0};
    if (mutations.elapsed.count() >
        std::numeric_limits<std::int64_t>::max() - m_elapsed_runtime.count())
        return core::Result<void, core::Diagnostics>::failure(checkpoint_error(
            "checkpoint.elapsed_time_exhausted", "Checkpoint elapsed runtime is exhausted."));
    m_elapsed_runtime += mutations.elapsed;
    if (mutations.structural) {
        auto recorded = record_structural_mutation();
        if (!recorded)
            return recorded;
    }
    if (mutations.time) {
        auto recorded = record_time_mutation();
        if (!recorded)
            return recorded;
    }

    std::vector<core::CheckpointReadinessIssue> issues;
    const auto add_queue = [&](bool settled, core::RuntimeQueueKind queue, std::uint64_t id) {
        if (!settled)
            add_barrier_issue(issues, core::CheckpointReadinessReason::RuntimeQueueUnsettled,
                              make_barrier(id, core::RuntimeQueueBarrierSource{queue},
                                           core::CheckpointBarrierKind::UnsettledQueue),
                              "checkpoint.runtime_queue_unsettled",
                              "A runtime transaction queue is unsettled.");
    };
    add_queue(facts.input_queue_settled, core::RuntimeQueueKind::Input, 1);
    add_queue(facts.output_queue_settled, core::RuntimeQueueKind::Output, 2);
    add_queue(facts.script_input_queue_settled, core::RuntimeQueueKind::ScriptInput, 3);
    add_queue(facts.deferred_command_queue_settled, core::RuntimeQueueKind::DeferredCommand, 4);
    add_queue(facts.presentation_acknowledgements_settled,
              core::RuntimeQueueKind::PresentationAcknowledgement, 5);
    if (facts.immediate_script_invocation_active)
        add_barrier_issue(issues, core::CheckpointReadinessReason::ImmediateScriptInvocationActive,
                          make_barrier(1, core::RuntimeTransactionBarrierSource{},
                                       core::CheckpointBarrierKind::ImmediateScriptInvocation),
                          "checkpoint.immediate_script_invocation",
                          "A Lua invocation is still executing.");
    if (facts.flow_blocker) {
        const auto kind = core::flow_blocker_kind(*facts.flow_blocker);
        if (kind == core::FlowBlockerKind::Presentation || kind == core::FlowBlockerKind::Audio ||
            kind == core::FlowBlockerKind::Script) {
            const auto owner = core::flow_blocker_owner(*facts.flow_blocker);
            add_barrier_issue(
                issues, core::CheckpointReadinessReason::FlowStateNotSerializable,
                make_barrier(owner.number(), core::FlowCheckpointBarrierSource{owner, kind},
                             core::CheckpointBarrierKind::UnserializableFlow),
                "checkpoint.flow_not_serializable", "The active Flow blocker is not serializable.");
            if (kind == core::FlowBlockerKind::Script) {
                const auto invocation =
                    std::get<core::ScriptFlowBlocker>(*facts.flow_blocker).handle;
                add_barrier_issue(
                    issues, core::CheckpointReadinessReason::SuspendedScriptInvocationActive,
                    make_barrier(invocation.number(),
                                 core::ScriptCheckpointBarrierSource{invocation},
                                 core::CheckpointBarrierKind::SuspendedScriptInvocation),
                    "checkpoint.suspended_script_invocation",
                    "A suspended Lua invocation cannot be checkpointed.");
            }
        }
    }
    for (const auto& barrier : facts.presentation_status.active_barriers)
        issues.push_back(core::CheckpointReadinessIssue{
            core::CheckpointReadinessReason::PresentationBarrierActive, barrier,
            readiness_diagnostic("checkpoint.presentation_barrier_active",
                                 "A causal presentation operation is active.")});

    const auto reconstructibility = validate_reconstructibility(session);
    add_issue(issues, core::CheckpointReadinessReason::ReconstructibleStateInvalid,
              reconstructibility);
    if (!issues.empty()) {
        auto published = publish_readiness(std::move(issues));
        if (published && !m_pending_manual_saves.empty()) {
            for (const auto slot : m_pending_manual_saves) {
                if (m_latest_checkpoint)
                    m_completed_save_outcomes.push_back(
                        write_checkpoint(slot, *m_latest_checkpoint,
                                         core::CheckpointWriteSource::RetainedCheckpoint));
                else
                    m_completed_save_outcomes.emplace_back(core::CheckpointSaveFailed{
                        slot, core::CheckpointSaveFailureStage::NoRetainedCheckpoint,
                        checkpoint_error("checkpoint.no_retained_checkpoint",
                                         "No retained checkpoint is available to write.")});
            }
            m_pending_manual_saves.clear();
        }
        fulfill_deferred_autosave();
        return published;
    }

    auto ready = publish_readiness({});
    if (!ready)
        return ready;
    const bool structural_newer =
        m_generations.structural_generation != m_generations.captured_structural_generation;
    const bool time_newer = m_generations.time_generation != m_generations.captured_time_generation;
    const bool refresh_requested = !m_latest_checkpoint || structural_newer ||
                                   (time_newer && (!m_pending_manual_saves.empty() ||
                                                   time_only_refresh_due(m_elapsed_runtime)));
    const auto revision_before =
        m_latest_checkpoint ? std::optional{m_latest_checkpoint->revision} : std::nullopt;
    core::Result<void, core::Diagnostics> captured =
        core::Result<void, core::Diagnostics>::success();
    if (refresh_requested)
        captured = publish_candidate(session);
    if (!m_pending_manual_saves.empty()) {
        for (const auto slot : m_pending_manual_saves) {
            if (!captured) {
                m_completed_save_outcomes.emplace_back(core::CheckpointSaveFailed{
                    slot, core::CheckpointSaveFailureStage::Capture, captured.error()});
            } else if (!m_latest_checkpoint) {
                m_completed_save_outcomes.emplace_back(core::CheckpointSaveFailed{
                    slot, core::CheckpointSaveFailureStage::NoRetainedCheckpoint,
                    checkpoint_error("checkpoint.no_retained_checkpoint",
                                     "No retained checkpoint is available to write.")});
            } else {
                m_completed_save_outcomes.push_back(write_checkpoint(
                    slot, *m_latest_checkpoint,
                    (!revision_before || m_latest_checkpoint->revision != *revision_before)
                        ? core::CheckpointWriteSource::CapturedCurrentState
                        : core::CheckpointWriteSource::RetainedCheckpoint));
            }
        }
        m_pending_manual_saves.clear();
    }
    fulfill_deferred_autosave();
    if (!captured)
        return captured;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::CheckpointSaveOutcome>
RuntimeCheckpointService::request(const core::ManualSaveRequest& request) noexcept
{
    if (request.slot.is_autosave())
        return core::Result<void, core::CheckpointSaveOutcome>::failure(
            core::CheckpointSaveOutcome{core::CheckpointSaveFailed{
                request.slot, core::CheckpointSaveFailureStage::InvalidRequest,
                checkpoint_error("checkpoint.manual_autosave_slot",
                                 "Manual save requests cannot target the autosave slot.")}});
    m_pending_manual_saves.push_back(request.slot);
    return core::Result<void, core::CheckpointSaveOutcome>::success();
}

core::CheckpointSaveOutcome
RuntimeCheckpointService::request(const core::DeferredAutosaveRequest& request) noexcept
{
    m_pending_deferred_autosave = request;
    return core::DeferredAutosaveQueued{};
}

core::CheckpointSaveOutcome
RuntimeCheckpointService::request(const core::ImmediateRetainedCheckpointWriteRequest& request)
{
    core::CheckpointSaveOutcome outcome = [&]() -> core::CheckpointSaveOutcome {
        if (!m_latest_checkpoint)
            return core::CheckpointSaveFailed{
                request.slot, core::CheckpointSaveFailureStage::NoRetainedCheckpoint,
                checkpoint_error("checkpoint.no_retained_checkpoint",
                                 "No retained checkpoint is available to write.")};
        return write_checkpoint(request.slot, *m_latest_checkpoint,
                                core::CheckpointWriteSource::RetainedCheckpoint);
    }();
    m_completed_save_outcomes.push_back(outcome);
    return outcome;
}

std::vector<core::CheckpointSaveOutcome> RuntimeCheckpointService::take_completed_save_outcomes()
{
    auto outcomes = std::move(m_completed_save_outcomes);
    m_completed_save_outcomes.clear();
    return outcomes;
}

core::Result<core::LatestSaveCheckpoint, core::Diagnostics>
RuntimeCheckpointService::prepare_loaded_checkpoint(std::string encoded_save,
                                                    const core::SaveState& decoded)
{
    auto revision = allocate_checkpoint_revision();
    if (!revision)
        return core::Result<core::LatestSaveCheckpoint, core::Diagnostics>::failure(
            std::move(revision).error());
    return core::Result<core::LatestSaveCheckpoint, core::Diagnostics>::success(
        core::LatestSaveCheckpoint{*revision.value_if(), std::move(encoded_save),
                                   core::SaveCheckpointMetadata{decoded.metadata.format_version,
                                                                decoded.metadata.project,
                                                                decoded.metadata.project_version,
                                                                decoded.play_time,
                                                                {}}});
}

void RuntimeCheckpointService::commit_loaded_checkpoint(
    core::LatestSaveCheckpoint checkpoint) noexcept
{
    m_generations = checkpoint.metadata.generations;
    m_latest_checkpoint = std::move(checkpoint);
    m_pending_deferred_autosave.reset();
    m_pending_manual_saves.clear();
    m_deferred_autosave_target.reset();
    m_completed_save_outcomes.clear();
    m_next_time_only_refresh = m_elapsed_runtime + std::chrono::seconds{1};
}

void RuntimeCheckpointService::reset() noexcept
{
    m_generations = {};
    m_readiness = {core::CheckpointReadinessRevision::from_number(1), {}};
    m_latest_checkpoint.reset();
    m_pending_deferred_autosave.reset();
    m_pending_manual_saves.clear();
    m_deferred_autosave_target.reset();
    m_completed_save_outcomes.clear();
    m_next_checkpoint_revision = 1;
    m_next_readiness_revision = 2;
    m_next_time_only_refresh = {};
    m_elapsed_runtime = {};
}

core::CheckpointSaveOutcome
RuntimeCheckpointService::write_checkpoint(core::TypedSaveSlotId slot,
                                           const core::LatestSaveCheckpoint& checkpoint,
                                           core::CheckpointWriteSource source)
{
    auto written = m_saves.write_slot(slot, checkpoint.encoded_save);
    if (!written)
        return core::CheckpointSaveFailed{slot, core::CheckpointSaveFailureStage::SlotWrite,
                                          std::move(written).error()};
    return core::CheckpointWriteSucceeded{slot, checkpoint.revision, source};
}

void RuntimeCheckpointService::fulfill_deferred_autosave()
{
    if (!m_deferred_autosave_target)
        return;
    auto outcome = write_checkpoint(core::TypedSaveSlotId::autosave(), *m_deferred_autosave_target,
                                    core::CheckpointWriteSource::RetainedCheckpoint);
    const bool succeeded = std::holds_alternative<core::CheckpointWriteSucceeded>(outcome);
    m_completed_save_outcomes.push_back(std::move(outcome));
    if (succeeded) {
        m_pending_deferred_autosave.reset();
        m_deferred_autosave_target.reset();
    }
}

core::Diagnostics
RuntimeCheckpointService::validate_reconstructibility(const core::SessionState& session) const
{
    (void)session;
    return {};
}

core::Result<void, core::Diagnostics>
RuntimeCheckpointService::publish_readiness(std::vector<core::CheckpointReadinessIssue> issues)
{
    std::stable_sort(issues.begin(), issues.end(), [](const auto& left, const auto& right) {
        if (left.reason != right.reason)
            return left.reason < right.reason;
        if (left.barrier && right.barrier) {
            if (left.barrier->source.index() != right.barrier->source.index())
                return left.barrier->source.index() < right.barrier->source.index();
            return left.barrier->id.number() < right.barrier->id.number();
        }
        return left.barrier.has_value() && !right.barrier.has_value();
    });
    if (issues == m_readiness.issues)
        return core::Result<void, core::Diagnostics>::success();
    if (m_next_readiness_revision == std::numeric_limits<std::uint64_t>::max())
        return core::Result<void, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.readiness_revision_exhausted",
                             "Checkpoint readiness revision identity is exhausted."));
    m_readiness = {core::CheckpointReadinessRevision::from_number(m_next_readiness_revision++),
                   std::move(issues)};
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<core::SaveCheckpointRevision, core::Diagnostics>
RuntimeCheckpointService::allocate_checkpoint_revision()
{
    if (m_next_checkpoint_revision == std::numeric_limits<std::uint64_t>::max())
        return core::Result<core::SaveCheckpointRevision, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.revision_exhausted",
                             "Checkpoint revision identity is exhausted."));
    return core::Result<core::SaveCheckpointRevision, core::Diagnostics>::success(
        core::SaveCheckpointRevision::from_number(m_next_checkpoint_revision++));
}

core::Result<void, core::Diagnostics>
RuntimeCheckpointService::publish_candidate(const core::SessionState& session)
{
    std::vector<core::CheckpointReadinessIssue> issues;
    const auto reconstructibility = validate_reconstructibility(session);
    add_issue(issues, core::CheckpointReadinessReason::ReconstructibleStateInvalid,
              reconstructibility);
    if (!issues.empty()) {
        auto published = publish_readiness(std::move(issues));
        return published ? core::Result<void, core::Diagnostics>::failure(reconstructibility)
                         : published;
    }

    auto save = core::make_save_state(m_project, session);
    core::Diagnostics failure;
    if (!save) {
        failure = save.error();
        add_issue(issues, core::CheckpointReadinessReason::SaveProjectionFailed, failure);
    } else {
        auto* projected = save.value_if();
        auto valid = core::validate_save_state(m_project, *projected, "checkpoint-candidate");
        if (!valid) {
            failure = valid.error();
            add_issue(issues, core::CheckpointReadinessReason::SaveValidationFailed, failure);
        } else {
            auto encoded = core::encode_save_state_text(m_project, *projected);
            if (!encoded) {
                failure = encoded.error();
                add_issue(issues, core::CheckpointReadinessReason::SaveEncodingFailed, failure);
            } else {
                auto readiness = publish_readiness({});
                if (!readiness)
                    return readiness;
                auto revision = allocate_checkpoint_revision();
                if (!revision)
                    return core::Result<void, core::Diagnostics>::failure(revision.error());
                auto* encoded_value = encoded.value_if();
                const auto* revision_value = revision.value_if();
                const core::SaveCheckpointMetadata metadata{
                    .save_format_version = projected->metadata.format_version,
                    .project = projected->metadata.project,
                    .project_version = projected->metadata.project_version,
                    .play_time = projected->play_time,
                    .generations = m_generations};
                core::LatestSaveCheckpoint candidate{*revision_value, std::move(*encoded_value),
                                                     metadata};
                m_latest_checkpoint = std::move(candidate);
                if (m_pending_deferred_autosave && !m_deferred_autosave_target)
                    m_deferred_autosave_target = *m_latest_checkpoint;
                m_generations.captured_structural_generation = m_generations.structural_generation;
                m_generations.captured_time_generation = m_generations.time_generation;
                m_next_time_only_refresh = m_elapsed_runtime + std::chrono::seconds(1);
                return core::Result<void, core::Diagnostics>::success();
            }
        }
    }
    auto published = publish_readiness(std::move(issues));
    if (!published)
        return published;
    return core::Result<void, core::Diagnostics>::failure(std::move(failure));
}

} // namespace noveltea::runtime
