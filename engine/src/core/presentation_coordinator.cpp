#include "noveltea/core/presentation_coordinator.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <type_traits>

namespace noveltea::core {
namespace {
Diagnostic diagnostic(std::string code, std::string message)
{
    return Diagnostic{.code = std::move(code), .message = std::move(message)};
}

bool terminal(const PresentationOperationState& state)
{
    return !std::holds_alternative<PresentationOperationAccepted>(state) &&
           !std::holds_alternative<PresentationOperationRunning>(state);
}

Result<PresentationOperationMetadata, Diagnostics>
normalize(const TransitionPresentationOperation& operation)
{
    if (operation.id.number() == 0 || operation.kind > compiled::TransitionKind::Dissolve ||
        operation.duration.count() < 0 ||
        operation.owner.has_value() != operation.completion.has_value())
        return Result<PresentationOperationMetadata, Diagnostics>::failure({diagnostic(
            "presentation.invalid_transition_operation",
            "Transition identity, owner, and completion target must form a consistent operation")});
    PresentationCompletionTarget completion = NoPresentationCompletion{};
    if (operation.owner)
        completion = PresentationFlowCompletion{*operation.owner, *operation.completion};
    return Result<PresentationOperationMetadata, Diagnostics>::success(
        {.operation = operation.id,
         .sequence = PresentationOperationSequence::from_number(1),
         .owner = PresentationOperationOwner::GameplayRuntime,
         .checkpoint_class = CheckpointClass::CausalBarrier,
         .completion = std::move(completion)});
}

Result<PresentationOperationMetadata, Diagnostics>
normalize(const LayoutPresentationOperation& operation)
{
    if (operation.id.number() == 0 || operation.action > compiled::LayoutAction::Swap ||
        operation.slot > compiled::LayoutSlot::Custom ||
        (operation.action == compiled::LayoutAction::Hide && operation.layout) ||
        (operation.action != compiled::LayoutAction::Hide && !operation.layout))
        return Result<PresentationOperationMetadata, Diagnostics>::failure(
            {diagnostic("presentation.invalid_layout_operation",
                        "Layout action and Layout identity conflict")});
    return Result<PresentationOperationMetadata, Diagnostics>::success(
        {.operation = operation.id,
         .sequence = PresentationOperationSequence::from_number(1),
         .owner = PresentationOperationOwner::GameplayRuntime,
         .checkpoint_class = CheckpointClass::Disposable,
         .completion = NoPresentationCompletion{}});
}

Result<PresentationOperationMetadata, Diagnostics> normalize(const AudioOperation& operation)
{
    if (operation.id.number() == 0 || operation.action > compiled::AudioAction::FadeOut ||
        operation.channel > compiled::AudioChannel::Ambient || operation.fade.count() < 0 ||
        !std::isfinite(operation.volume) || operation.volume < 0.0 || operation.volume > 1.0 ||
        operation.owner.has_value() != operation.completion.has_value())
        return Result<PresentationOperationMetadata, Diagnostics>::failure({diagnostic(
            "presentation.invalid_audio_operation",
            "Audio identity, owner, and completion target must form a consistent operation")});
    if ((operation.action == compiled::AudioAction::Play ||
         operation.action == compiled::AudioAction::FadeIn) != operation.asset.has_value())
        return Result<PresentationOperationMetadata, Diagnostics>::failure({diagnostic(
            "presentation.invalid_audio_operation", "Audio action and Asset identity conflict")});

    PresentationCompletionTarget completion = NoPresentationCompletion{};
    if (operation.completion) {
        if (const auto* flow = std::get_if<AudioFlowBlockerHandle>(&*operation.completion))
            completion = AudioFlowCompletion{*operation.owner, *flow};
        else
            completion = ScriptAudioCompletion{
                *operation.owner, std::get<ScriptInvocationHandle>(*operation.completion)};
    }
    const bool playing = operation.action == compiled::AudioAction::Play ||
                         operation.action == compiled::AudioAction::FadeIn;
    if (!playing && operation.loop)
        return Result<PresentationOperationMetadata, Diagnostics>::failure(
            {diagnostic("presentation.invalid_audio_operation",
                        "Audio stop and fade-out operations cannot declare looping playback")});
    const bool persistent_loop = playing && operation.loop &&
                                 (operation.channel == compiled::AudioChannel::Music ||
                                  operation.channel == compiled::AudioChannel::Ambient) &&
                                 !operation.completion;
    return Result<PresentationOperationMetadata, Diagnostics>::success(
        {.operation = operation.id,
         .sequence = PresentationOperationSequence::from_number(1),
         .owner = PresentationOperationOwner::GameplayRuntime,
         .checkpoint_class =
             persistent_loop ? CheckpointClass::Reconstructible : CheckpointClass::CausalBarrier,
         .completion = std::move(completion)});
}

Result<PresentationOperationMetadata, Diagnostics>
normalize(const ActiveTextPresentationOperation& operation)
{
    if (operation.id.number() == 0)
        return Result<PresentationOperationMetadata, Diagnostics>::failure(
            {diagnostic("presentation.invalid_active_text_operation",
                        "ActiveText presentation operation identity must be nonzero")});
    return Result<PresentationOperationMetadata, Diagnostics>::success(
        {.operation = operation.id,
         .sequence = PresentationOperationSequence::from_number(1),
         .owner = PresentationOperationOwner::GameplayRuntime,
         .checkpoint_class = CheckpointClass::CausalBarrier,
         .completion = NoPresentationCompletion{}});
}
} // namespace

PresentationCoordinator::PresentationCoordinator(
    PresentationSnapshotBackendPort* snapshot_backend,
    PresentationOperationBackendPort* operation_backend)
    : m_snapshot_backend(snapshot_backend), m_operation_backend(operation_backend)
{
}

Result<PresentationOperationLifecycle, Diagnostics>
PresentationCoordinator::accept(const PresentationOperation& operation)
{
    return std::visit(
        [this](const auto& value) -> Result<PresentationOperationLifecycle, Diagnostics> {
            auto metadata = normalize(value);
            if (!metadata)
                return Result<PresentationOperationLifecycle, Diagnostics>::failure(
                    metadata.error());
            return accept_normalized(value, std::move(*metadata.value_if()));
        },
        operation);
}

Result<PresentationOperationLifecycle, Diagnostics>
PresentationCoordinator::accept(const AudioOperation& operation)
{
    auto metadata = normalize(operation);
    if (!metadata)
        return Result<PresentationOperationLifecycle, Diagnostics>::failure(metadata.error());
    return accept_normalized(operation, std::move(*metadata.value_if()));
}

Result<PresentationOperationLifecycle, Diagnostics>
PresentationCoordinator::accept(const ActiveTextPresentationOperation& operation)
{
    auto metadata = normalize(operation);
    if (!metadata)
        return Result<PresentationOperationLifecycle, Diagnostics>::failure(metadata.error());
    return accept_normalized(operation, std::move(*metadata.value_if()));
}

Result<PresentationOperationLifecycle, Diagnostics>
PresentationCoordinator::accept_normalized(CoordinatedPresentationOperation operation,
                                           PresentationOperationMetadata metadata)
{
    if (find(metadata.operation))
        return Result<PresentationOperationLifecycle, Diagnostics>::failure({diagnostic(
            "presentation.duplicate_operation", "Operation identity was already accepted")});
    if (metadata.checkpoint_class == CheckpointClass::CausalBarrier &&
        m_checkpoint_status.revision.number() == std::numeric_limits<std::uint64_t>::max())
        return Result<PresentationOperationLifecycle, Diagnostics>::failure(
            {diagnostic("presentation.checkpoint_status_exhausted",
                        "Presentation checkpoint-status revision is exhausted")});
    if (m_next_sequence == 0 || m_next_sequence == std::numeric_limits<std::uint64_t>::max())
        return Result<PresentationOperationLifecycle, Diagnostics>::failure({diagnostic(
            "presentation.sequence_exhausted", "Presentation operation sequence is exhausted")});
    metadata.sequence = PresentationOperationSequence::from_number(m_next_sequence++);
    Record record{{metadata, PresentationOperationAccepted{}}, std::move(operation), false, false};
    m_records.push_back(std::move(record));
    if (metadata.checkpoint_class == CheckpointClass::CausalBarrier)
        add_barrier(metadata);
    rebuild_views();
    return Result<PresentationOperationLifecycle, Diagnostics>::success(m_records.back().lifecycle);
}

Result<void, Diagnostics>
PresentationCoordinator::acknowledge(const BackendOperationAcknowledgement& acknowledgement)
{
    auto* record = find(acknowledgement.operation);
    if (!record)
        return Result<void, Diagnostics>::failure({diagnostic(
            "presentation.stale_acknowledgement", "Acknowledgement names no accepted operation")});
    if (record->lifecycle.metadata.sequence != acknowledgement.sequence)
        return Result<void, Diagnostics>::failure(
            {diagnostic("presentation.wrong_sequence",
                        "Acknowledgement sequence does not match the operation")});
    if (record->lifecycle.metadata.owner != acknowledgement.owner)
        return Result<void, Diagnostics>::failure({diagnostic(
            "presentation.wrong_owner", "Acknowledgement owner does not match the operation")});
    if (terminal(record->lifecycle.state))
        return Result<void, Diagnostics>::failure(
            {diagnostic("presentation.operation_terminal",
                        "Acknowledgement names an already-terminal operation")});
    if (std::holds_alternative<BackendOperationRunning>(acknowledgement.fact)) {
        if (std::holds_alternative<PresentationOperationRunning>(record->lifecycle.state) &&
            !record->running_reacknowledgement_allowed)
            return Result<void, Diagnostics>::failure({diagnostic(
                "presentation.duplicate_acknowledgement", "Operation is already running")});
        record->running_reacknowledgement_allowed = false;
        record->lifecycle.state = PresentationOperationRunning{};
        rebuild_views();
        return Result<void, Diagnostics>::success();
    }
    if (std::holds_alternative<BackendOperationCompleted>(acknowledgement.fact))
        return transition_terminal(*record, PresentationOperationCompleted{});
    const auto& failure = std::get<BackendOperationFailed>(acknowledgement.fact);
    return transition_terminal(*record,
                               PresentationOperationFailed{failure.domain, failure.diagnostic});
}

Result<void, Diagnostics> PresentationCoordinator::cancel(PresentationOperationRef operation,
                                                          PresentationCancellationReason reason)
{
    auto* record = find(operation);
    if (!record)
        return Result<void, Diagnostics>::failure({diagnostic(
            "presentation.unknown_operation", "Cancellation names no accepted operation")});
    return transition_terminal(*record, PresentationOperationCancelled{reason});
}

Result<void, Diagnostics> PresentationCoordinator::replace(PresentationOperationRef operation,
                                                           PresentationOperationRef replacement)
{
    auto* replacement_record = find(replacement);
    auto* record = find(operation);
    if (!record || !replacement_record || terminal(replacement_record->lifecycle.state))
        return Result<void, Diagnostics>::failure(
            {diagnostic("presentation.invalid_replacement",
                        "Replacement must name a live accepted operation")});
    if (record == replacement_record)
        return Result<void, Diagnostics>::failure(
            {diagnostic("presentation.invalid_replacement", "An operation cannot replace itself")});
    return transition_terminal(*record, PresentationOperationReplaced{replacement});
}

void PresentationCoordinator::cancel_all(PresentationCancellationReason reason)
{
    for (auto& record : m_records) {
        if (!terminal(record.lifecycle.state))
            static_cast<void>(transition_terminal(record, PresentationOperationCancelled{reason}));
    }
}

Result<void, Diagnostics>
PresentationCoordinator::transition_terminal(Record& record, PresentationOperationState state)
{
    if (terminal(record.lifecycle.state))
        return Result<void, Diagnostics>::failure(
            {diagnostic("presentation.operation_terminal", "Operation is already terminal")});
    auto barrier = m_checkpoint_status.active_barriers.end();
    if (record.lifecycle.metadata.checkpoint_class == CheckpointClass::CausalBarrier) {
        barrier = std::find_if(
            m_checkpoint_status.active_barriers.begin(), m_checkpoint_status.active_barriers.end(),
            [&](const CheckpointBarrier& value) {
                const auto* source =
                    std::get_if<PresentationCheckpointBarrierSource>(&value.source);
                return source && source->operation == record.lifecycle.metadata.operation;
            });
        if (barrier == m_checkpoint_status.active_barriers.end())
            return Result<void, Diagnostics>::failure(
                {diagnostic("presentation.missing_checkpoint_barrier",
                            "Causal operation has no matching checkpoint barrier")});
        if (m_checkpoint_status.revision.number() == std::numeric_limits<std::uint64_t>::max())
            return Result<void, Diagnostics>::failure(
                {diagnostic("presentation.checkpoint_status_exhausted",
                            "Presentation checkpoint-status revision is exhausted")});
    }
    record.lifecycle.state = std::move(state);
    record.running_reacknowledgement_allowed = false;
    if (barrier != m_checkpoint_status.active_barriers.end()) {
        m_checkpoint_status.active_barriers.erase(barrier);
        m_checkpoint_status.revision =
            CheckpointStatusRevision::from_number(m_checkpoint_status.revision.number() + 1);
    }
    rebuild_views();
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
PresentationCoordinator::reconcile_snapshot(const RuntimePresentationSnapshot& snapshot)
{
    if (snapshot.revision == 0)
        return Result<void, Diagnostics>::failure(
            {diagnostic("presentation.invalid_snapshot_revision",
                        "Presentation snapshot revision must be nonzero")});
    if (m_snapshot && m_snapshot->revision == snapshot.revision && *m_snapshot != snapshot)
        return Result<void, Diagnostics>::failure(
            {diagnostic("presentation.snapshot_revision_conflict",
                        "A snapshot revision cannot identify two different desired-state values")});
    m_snapshot = snapshot;
    if (m_reconciled_revision && *m_reconciled_revision == snapshot.revision)
        return Result<void, Diagnostics>::success();
    if (!m_snapshot_backend)
        return Result<void, Diagnostics>::success();
    auto reconciled = m_snapshot_backend->reconcile(snapshot);
    if (reconciled)
        m_reconciled_revision = snapshot.revision;
    return reconciled;
}

Result<void, Diagnostics> PresentationCoordinator::deliver_pending()
{
    if (!m_operation_backend)
        return Result<void, Diagnostics>::success();
    for (auto& record : m_records) {
        if (record.delivered || terminal(record.lifecycle.state))
            continue;
        auto delivered =
            m_operation_backend->realize({record.lifecycle.metadata, record.operation});
        if (!delivered)
            return delivered;
        record.delivered = true;
    }
    return Result<void, Diagnostics>::success();
}

void PresentationCoordinator::reset_backends(PresentationCancellationReason reason)
{
    if (m_operation_backend)
        m_operation_backend->reset(reason);
    if (m_snapshot_backend)
        m_snapshot_backend->reset(reason);
    m_reconciled_revision.reset();
    for (auto& record : m_records) {
        if (!terminal(record.lifecycle.state))
            record.delivered = false;
        if (std::holds_alternative<PresentationOperationRunning>(record.lifecycle.state))
            record.running_reacknowledgement_allowed = true;
    }
}

void PresentationCoordinator::clear_session()
{
    m_records.clear();
    m_lifecycle_view.clear();
    m_next_sequence = 1;
    m_checkpoint_status = {CheckpointStatusRevision::from_number(1), {}};
    m_snapshot.reset();
    m_reconciled_revision.reset();
}

PresentationCoordinator::Record* PresentationCoordinator::find(PresentationOperationRef operation)
{
    const auto found = std::find_if(m_records.begin(), m_records.end(), [&](const Record& record) {
        return record.lifecycle.metadata.operation == operation;
    });
    return found == m_records.end() ? nullptr : &*found;
}

const PresentationCoordinator::Record*
PresentationCoordinator::find(PresentationOperationRef operation) const
{
    const auto found = std::find_if(m_records.begin(), m_records.end(), [&](const Record& record) {
        return record.lifecycle.metadata.operation == operation;
    });
    return found == m_records.end() ? nullptr : &*found;
}

void PresentationCoordinator::add_barrier(const PresentationOperationMetadata& metadata)
{
    m_checkpoint_status.active_barriers.push_back(
        {CheckpointBarrierId::from_number(metadata.sequence.number()),
         PresentationCheckpointBarrierSource{metadata.operation},
         CheckpointBarrierKind::PresentationCausalOperation});
    m_checkpoint_status.revision =
        CheckpointStatusRevision::from_number(m_checkpoint_status.revision.number() + 1);
}

void PresentationCoordinator::rebuild_views()
{
    m_lifecycle_view.clear();
    m_lifecycle_view.reserve(m_records.size());
    for (const auto& record : m_records)
        m_lifecycle_view.push_back(record.lifecycle);
}

const std::vector<PresentationOperationLifecycle>&
PresentationCoordinator::lifecycles() const noexcept
{
    return m_lifecycle_view;
}

const PresentationCheckpointStatus& PresentationCoordinator::checkpoint_status() const noexcept
{
    return m_checkpoint_status;
}

std::optional<RuntimePresentationSnapshot> PresentationCoordinator::desired_snapshot() const
{
    return m_snapshot;
}
} // namespace noveltea::core
