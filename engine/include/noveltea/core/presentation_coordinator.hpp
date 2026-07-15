#pragma once

#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/runtime_presentation.hpp"

#include <cstdint>
#include <optional>
#include <vector>

namespace noveltea::core {

enum class ActiveTextPresentationPhase : std::uint8_t {
    Stable,
    Reveal,
    Fade,
};

struct ActiveTextPresentationOperation {
    PresentationOperationId id;
    ActiveTextPresentationPhase phase = ActiveTextPresentationPhase::Reveal;
    LayoutClockDomain clock = LayoutClockDomain::Gameplay;
    bool operator==(const ActiveTextPresentationOperation&) const = default;
};

using CoordinatedPresentationOperation =
    std::variant<TransitionPresentationOperation, LayoutPresentationOperation, AudioOperation,
                 ActiveTextPresentationOperation>;

struct CoordinatedOperationDelivery {
    PresentationOperationMetadata metadata;
    CoordinatedPresentationOperation operation;
    bool operator==(const CoordinatedOperationDelivery&) const = default;
};

class PresentationSnapshotBackendPort {
public:
    virtual ~PresentationSnapshotBackendPort() = default;
    [[nodiscard]] virtual Result<void, Diagnostics>
    reconcile(const RuntimePresentationSnapshot& snapshot) = 0;
    virtual void reset(PresentationCancellationReason reason) = 0;
};

class PresentationOperationBackendPort {
public:
    virtual ~PresentationOperationBackendPort() = default;
    [[nodiscard]] virtual Result<void, Diagnostics>
    realize(const CoordinatedOperationDelivery& delivery) = 0;
    virtual void reset(PresentationCancellationReason reason) = 0;
};

struct BackendOperationRunning {
    auto operator<=>(const BackendOperationRunning&) const = default;
};
struct BackendOperationCompleted {
    auto operator<=>(const BackendOperationCompleted&) const = default;
};
struct BackendOperationFailed {
    PresentationFailureDomain domain;
    Diagnostic diagnostic;
    bool operator==(const BackendOperationFailed&) const = default;
};
using BackendOperationFact =
    std::variant<BackendOperationRunning, BackendOperationCompleted, BackendOperationFailed>;

struct BackendOperationAcknowledgement {
    PresentationOperationRef operation;
    PresentationOperationSequence sequence;
    PresentationOperationOwner owner;
    BackendOperationFact fact;
    bool operator==(const BackendOperationAcknowledgement&) const = default;
};

class PresentationCoordinator {
public:
    PresentationCoordinator(PresentationSnapshotBackendPort* snapshot_backend = nullptr,
                            PresentationOperationBackendPort* operation_backend = nullptr);

    [[nodiscard]] Result<PresentationOperationLifecycle, Diagnostics>
    accept(const PresentationOperation& operation);
    [[nodiscard]] Result<PresentationOperationLifecycle, Diagnostics>
    accept(const AudioOperation& operation);
    [[nodiscard]] Result<PresentationOperationLifecycle, Diagnostics>
    accept(const ActiveTextPresentationOperation& operation);
    [[nodiscard]] Result<void, Diagnostics>
    acknowledge(const BackendOperationAcknowledgement& acknowledgement);
    [[nodiscard]] Result<void, Diagnostics> cancel(PresentationOperationRef operation,
                                                   PresentationCancellationReason reason);
    [[nodiscard]] Result<void, Diagnostics> replace(PresentationOperationRef operation,
                                                    PresentationOperationRef replacement);
    void cancel_all(PresentationCancellationReason reason);

    [[nodiscard]] Result<void, Diagnostics>
    reconcile_snapshot(const RuntimePresentationSnapshot& snapshot);
    [[nodiscard]] Result<void, Diagnostics> deliver_pending();
    void reset_backends(PresentationCancellationReason reason);
    void clear_session();

    [[nodiscard]] const std::vector<PresentationOperationLifecycle>& lifecycles() const noexcept;
    [[nodiscard]] const PresentationCheckpointStatus& checkpoint_status() const noexcept;
    [[nodiscard]] std::optional<RuntimePresentationSnapshot> desired_snapshot() const;

private:
    struct Record {
        PresentationOperationLifecycle lifecycle;
        CoordinatedPresentationOperation operation;
        bool delivered = false;
        bool running_reacknowledgement_allowed = false;
    };

    [[nodiscard]] Result<PresentationOperationLifecycle, Diagnostics>
    accept_normalized(CoordinatedPresentationOperation operation,
                      PresentationOperationMetadata metadata);
    [[nodiscard]] Result<void, Diagnostics> transition_terminal(Record& record,
                                                                PresentationOperationState state);
    [[nodiscard]] Record* find(PresentationOperationRef operation);
    [[nodiscard]] const Record* find(PresentationOperationRef operation) const;
    void rebuild_views();
    void add_barrier(const PresentationOperationMetadata& metadata);

    PresentationSnapshotBackendPort* m_snapshot_backend;
    PresentationOperationBackendPort* m_operation_backend;
    std::uint64_t m_next_sequence = 1;
    std::vector<Record> m_records;
    std::vector<PresentationOperationLifecycle> m_lifecycle_view;
    PresentationCheckpointStatus m_checkpoint_status{CheckpointStatusRevision::from_number(1), {}};
    std::optional<RuntimePresentationSnapshot> m_snapshot;
    std::optional<std::uint64_t> m_reconciled_revision;
};

} // namespace noveltea::core
