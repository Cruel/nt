#include "noveltea/runtime/runtime_checkpoint_service.hpp"

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/save_state.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <string_view>
#include <utility>

namespace noveltea::runtime {
namespace {

core::Diagnostics checkpoint_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

bool valid_png_bytes(std::string_view bytes)
{
    constexpr std::string_view signature = "\x89PNG\r\n\x1a\n";
    return bytes.size() > signature.size() && bytes.starts_with(signature);
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
                                                   core::TypedSaveSlotStore& saves,
                                                   const core::SaveStateCodecPort& save_codec) noexcept
    : m_project(project), m_saves(saves), m_save_codec(save_codec),
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
    m_presentation_status = facts.presentation_status;
    if (m_latest_checkpoint && !m_latest_checkpoint->presentation_revision &&
        facts.presentation_revision) {
        m_latest_checkpoint->presentation_revision = facts.presentation_revision;
        if (!m_latest_checkpoint->thumbnail && !m_thumbnail_capture_token)
            assign_thumbnail_capture_token();
    }
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

    const auto reconstructibility = validate_reconstructibility(facts);
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
        captured = publish_candidate(session, facts.presentation_revision);
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
RuntimeCheckpointService::prepare_loaded_checkpoint(
    std::string encoded_save, const core::SaveState& decoded,
    std::optional<core::SaveCheckpointMetadata> stored_metadata,
    std::optional<core::SaveCheckpointThumbnail> stored_thumbnail,
    std::optional<core::PresentationSnapshotRevision> presentation_revision)
{
    auto revision = allocate_checkpoint_revision();
    if (!revision)
        return core::Result<core::LatestSaveCheckpoint, core::Diagnostics>::failure(
            std::move(revision).error());
    const core::SaveCheckpointMetadata decoded_metadata{decoded.metadata.format_version,
                                                        decoded.metadata.project,
                                                        decoded.metadata.project_version,
                                                        decoded.play_time,
                                                        {}};
    if (stored_metadata &&
        (stored_metadata->save_format_version != decoded_metadata.save_format_version ||
         stored_metadata->project != decoded_metadata.project ||
         stored_metadata->project_version != decoded_metadata.project_version ||
         stored_metadata->play_time != decoded_metadata.play_time)) {
        return core::Result<core::LatestSaveCheckpoint, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.stored_metadata_mismatch",
                             "Stored checkpoint metadata does not describe the encoded save."));
    }
    auto metadata = stored_metadata ? std::move(*stored_metadata) : decoded_metadata;
    return core::Result<core::LatestSaveCheckpoint, core::Diagnostics>::success(
        core::LatestSaveCheckpoint{*revision.value_if(), std::move(encoded_save),
                                   std::move(metadata), presentation_revision,
                                   std::move(stored_thumbnail)});
}

void RuntimeCheckpointService::commit_loaded_checkpoint(
    core::LatestSaveCheckpoint checkpoint) noexcept
{
    m_generations = {};
    m_latest_checkpoint = std::move(checkpoint);
    if (!m_latest_checkpoint->thumbnail && m_latest_checkpoint->presentation_revision)
        assign_thumbnail_capture_token();
    else
        m_thumbnail_capture_token.reset();
    m_pending_deferred_autosave.reset();
    m_pending_manual_saves.clear();
    m_deferred_autosave_target.reset();
    m_completed_save_outcomes.clear();
    m_written_slots.clear();
    m_next_time_only_refresh = m_elapsed_runtime + std::chrono::seconds{1};
}

void RuntimeCheckpointService::reset() noexcept
{
    m_generations = {};
    m_readiness = {core::CheckpointReadinessRevision::from_number(1), {}};
    m_latest_checkpoint.reset();
    m_presentation_status = {core::CheckpointStatusRevision::from_number(1), {}, std::nullopt};
    m_pending_deferred_autosave.reset();
    m_pending_manual_saves.clear();
    m_deferred_autosave_target.reset();
    m_completed_save_outcomes.clear();
    m_written_slots.clear();
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
    auto written = m_saves.write_checkpoint(
        slot, core::TypedSaveSlotCheckpoint{checkpoint.encoded_save, checkpoint.metadata,
                                            checkpoint.thumbnail});
    if (!written)
        return core::CheckpointSaveFailed{slot, core::CheckpointSaveFailureStage::SlotWrite,
                                          std::move(written).error()};
    m_written_slots.insert_or_assign(slot, checkpoint.revision);
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
RuntimeCheckpointService::validate_reconstructibility(const RuntimeCheckpointFacts& facts) const
{
    if (!facts.presentation_revision || !facts.presentation_status.reconstructible_activity)
        return {};
    if (facts.presentation_status.reconstructible_activity->snapshot !=
        *facts.presentation_revision)
        return checkpoint_error("checkpoint.reconstructible_activity_revision_mismatch",
                                "Presentation reconstructible activity does not match the "
                                "displayed snapshot revision.");
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

core::Result<void, core::Diagnostics> RuntimeCheckpointService::publish_candidate(
    const core::SessionState& session,
    std::optional<core::PresentationSnapshotRevision> presentation_revision)
{
    std::vector<core::CheckpointReadinessIssue> issues;
    auto save = core::make_save_state(m_project, session);
    core::Diagnostics failure;
    if (!save) {
        failure = save.error();
        add_issue(issues, core::CheckpointReadinessReason::SaveProjectionFailed, failure);
    } else {
        auto* projected = save.value_if();
        auto valid = m_save_codec.validate(m_project, *projected, "checkpoint-candidate");
        if (!valid) {
            failure = valid.error();
            add_issue(issues, core::CheckpointReadinessReason::SaveValidationFailed, failure);
        } else {
            auto encoded = m_save_codec.encode(m_project, *projected);
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
                                                     metadata, presentation_revision, std::nullopt};
                m_latest_checkpoint = std::move(candidate);
                assign_thumbnail_capture_token();
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

core::CheckpointRuntimeObservation
RuntimeCheckpointService::observation(const core::SessionState& session) const
{
    core::CheckpointReplayDistance replay_distance;
    replay_distance.structural_generations =
        m_generations.structural_generation >= m_generations.captured_structural_generation
            ? m_generations.structural_generation - m_generations.captured_structural_generation
            : 0;
    replay_distance.time_generations =
        m_generations.time_generation >= m_generations.captured_time_generation
            ? m_generations.time_generation - m_generations.captured_time_generation
            : 0;
    if (m_latest_checkpoint && session.play_time() >= m_latest_checkpoint->metadata.play_time)
        replay_distance.play_time = session.play_time() - m_latest_checkpoint->metadata.play_time;

    return core::CheckpointRuntimeObservation{
        .readiness = m_readiness,
        .presentation = m_presentation_status,
        .retained_revision =
            m_latest_checkpoint ? std::optional{m_latest_checkpoint->revision} : std::nullopt,
        .retained_metadata =
            m_latest_checkpoint ? std::optional{m_latest_checkpoint->metadata} : std::nullopt,
        .replay_distance = replay_distance,
        .thumbnail_available = m_latest_checkpoint && m_latest_checkpoint->thumbnail.has_value(),
        .thumbnail_capture_pending = pending_thumbnail_capture().has_value(),
    };
}

std::optional<core::CheckpointThumbnailCaptureRequest>
RuntimeCheckpointService::pending_thumbnail_capture() const noexcept
{
    if (!m_latest_checkpoint || m_latest_checkpoint->thumbnail ||
        !m_latest_checkpoint->presentation_revision || !m_thumbnail_capture_token)
        return std::nullopt;
    return core::CheckpointThumbnailCaptureRequest{*m_thumbnail_capture_token,
                                                   m_latest_checkpoint->revision,
                                                   *m_latest_checkpoint->presentation_revision};
}

core::Result<void, core::Diagnostics>
RuntimeCheckpointService::attach_thumbnail(const core::CheckpointThumbnailCaptureRequest& request,
                                           core::SaveCheckpointThumbnail thumbnail)
{
    if (thumbnail.encoding != core::SaveCheckpointThumbnailEncoding::Png || thumbnail.width == 0 ||
        thumbnail.height == 0 || !valid_png_bytes(thumbnail.bytes))
        return core::Result<void, core::Diagnostics>::failure(checkpoint_error(
            "checkpoint.invalid_thumbnail", "Checkpoint thumbnail must be a non-empty PNG image."));
    if (!m_latest_checkpoint || m_latest_checkpoint->revision != request.checkpoint ||
        m_latest_checkpoint->presentation_revision != request.presentation ||
        m_thumbnail_capture_token != request.capture_token)
        return core::Result<void, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.stale_thumbnail",
                             "Checkpoint thumbnail does not match the retained checkpoint."));

    auto replacement = *m_latest_checkpoint;
    replacement.thumbnail = std::move(thumbnail);
    for (const auto& [slot, revision] : m_written_slots) {
        if (revision != replacement.revision)
            continue;
        auto written = m_saves.write_checkpoint(
            slot, core::TypedSaveSlotCheckpoint{replacement.encoded_save, replacement.metadata,
                                                replacement.thumbnail});
        if (!written)
            return core::Result<void, core::Diagnostics>::failure(std::move(written).error());
    }
    if (m_deferred_autosave_target && m_deferred_autosave_target->revision == replacement.revision)
        m_deferred_autosave_target->thumbnail = replacement.thumbnail;
    m_latest_checkpoint = std::move(replacement);
    m_thumbnail_capture_token.reset();
    return core::Result<void, core::Diagnostics>::success();
}

void RuntimeCheckpointService::assign_thumbnail_capture_token() noexcept
{
    if (m_next_thumbnail_capture_token == 0) {
        m_thumbnail_capture_token.reset();
        return;
    }
    m_thumbnail_capture_token = m_next_thumbnail_capture_token;
    if (m_next_thumbnail_capture_token == std::numeric_limits<std::uint64_t>::max())
        m_next_thumbnail_capture_token = 0;
    else
        ++m_next_thumbnail_capture_token;
}

} // namespace noveltea::runtime
