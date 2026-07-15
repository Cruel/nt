#pragma once

#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/save_state.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"

#include <chrono>
#include <compare>
#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

struct CheckpointBarrierTag;
struct CheckpointStatusRevisionTag;
struct CheckpointReadinessRevisionTag;
struct SaveCheckpointRevisionTag;
using CheckpointBarrierId = SessionSequence<CheckpointBarrierTag>;
using CheckpointStatusRevision = SessionSequence<CheckpointStatusRevisionTag>;
using CheckpointReadinessRevision = SessionSequence<CheckpointReadinessRevisionTag>;
using SaveCheckpointRevision = SessionSequence<SaveCheckpointRevisionTag>;

enum class RuntimeQueueKind : std::uint8_t {
    Input,
    Output,
    ScriptInput,
    HostRequest,
    PresentationAcknowledgement,
};

struct RuntimeTransactionBarrierSource {
    auto operator<=>(const RuntimeTransactionBarrierSource&) const = default;
};
struct RuntimeQueueBarrierSource {
    RuntimeQueueKind queue;
    auto operator<=>(const RuntimeQueueBarrierSource&) const = default;
};
struct FlowCheckpointBarrierSource {
    FlowFrameId owner;
    FlowBlockerKind blocker;
    auto operator<=>(const FlowCheckpointBarrierSource&) const = default;
};
struct ScriptCheckpointBarrierSource {
    ScriptInvocationHandle invocation;
    auto operator<=>(const ScriptCheckpointBarrierSource&) const = default;
};
struct HostRequestCheckpointBarrierSource {
    HostRequestId request;
    auto operator<=>(const HostRequestCheckpointBarrierSource&) const = default;
};
struct PresentationCheckpointBarrierSource {
    PresentationOperationRef operation;
    bool operator==(const PresentationCheckpointBarrierSource&) const = default;
};
using CheckpointBarrierSource =
    std::variant<RuntimeTransactionBarrierSource, RuntimeQueueBarrierSource,
                 FlowCheckpointBarrierSource, ScriptCheckpointBarrierSource,
                 HostRequestCheckpointBarrierSource, PresentationCheckpointBarrierSource>;

enum class CheckpointBarrierKind : std::uint8_t {
    RuntimeTransaction,
    UnsettledQueue,
    UnserializableFlow,
    ImmediateScriptInvocation,
    SuspendedScriptInvocation,
    PendingHostRequest,
    PresentationCausalOperation,
    InvalidReconstructibleState,
};

struct CheckpointBarrier {
    CheckpointBarrierId id;
    CheckpointBarrierSource source;
    CheckpointBarrierKind kind;
    bool operator==(const CheckpointBarrier&) const = default;
};
struct PresentationCheckpointStatus {
    CheckpointStatusRevision revision;
    std::vector<CheckpointBarrier> active_barriers;
    bool operator==(const PresentationCheckpointStatus&) const = default;
};

enum class CheckpointReadinessReason : std::uint8_t {
    RuntimeTransactionActive,
    RuntimeQueueUnsettled,
    FlowStateNotSerializable,
    ImmediateScriptInvocationActive,
    SuspendedScriptInvocationActive,
    HostRequestPending,
    PresentationBarrierActive,
    ReconstructibleStateInvalid,
    SaveProjectionFailed,
    SaveValidationFailed,
    SaveEncodingFailed,
};

struct CheckpointReadinessIssue {
    CheckpointReadinessReason reason;
    std::optional<CheckpointBarrier> barrier;
    Diagnostic diagnostic;
    bool operator==(const CheckpointReadinessIssue&) const = default;
};
struct CheckpointReadinessStatus {
    CheckpointReadinessRevision revision;
    std::vector<CheckpointReadinessIssue> issues;
    [[nodiscard]] bool can_capture() const noexcept { return issues.empty(); }
    bool operator==(const CheckpointReadinessStatus&) const = default;
};

struct CheckpointGenerationState {
    std::uint64_t structural_generation = 0;
    std::uint64_t captured_structural_generation = 0;
    std::uint64_t time_generation = 0;
    std::uint64_t captured_time_generation = 0;
    auto operator<=>(const CheckpointGenerationState&) const = default;
};

struct SaveCheckpointMetadata {
    std::uint32_t save_format_version = SaveStateMetadata::current_format_version;
    ProjectId project;
    std::string project_version;
    std::chrono::milliseconds play_time{0};
    CheckpointGenerationState generations;
    bool operator==(const SaveCheckpointMetadata&) const = default;
};
struct LatestSaveCheckpoint {
    SaveCheckpointRevision revision;
    std::string encoded_save;
    SaveCheckpointMetadata metadata;
    bool operator==(const LatestSaveCheckpoint&) const = default;
};

struct ManualSaveRequest {
    TypedSaveSlotId slot;
    auto operator<=>(const ManualSaveRequest&) const = default;
};
struct DeferredAutosaveRequest {
    auto operator<=>(const DeferredAutosaveRequest&) const = default;
};
struct ImmediateRetainedCheckpointWriteRequest {
    TypedSaveSlotId slot;
    auto operator<=>(const ImmediateRetainedCheckpointWriteRequest&) const = default;
};
using CheckpointSaveRequest = std::variant<ManualSaveRequest, DeferredAutosaveRequest,
                                           ImmediateRetainedCheckpointWriteRequest>;

enum class CheckpointWriteSource : std::uint8_t {
    CapturedCurrentState,
    RetainedCheckpoint,
};
struct CheckpointWriteSucceeded {
    TypedSaveSlotId slot;
    SaveCheckpointRevision checkpoint;
    CheckpointWriteSource source;
    auto operator<=>(const CheckpointWriteSucceeded&) const = default;
};
struct DeferredAutosaveQueued {
    auto operator<=>(const DeferredAutosaveQueued&) const = default;
};
enum class CheckpointSaveFailureStage : std::uint8_t {
    InvalidRequest,
    NoRetainedCheckpoint,
    Capture,
    SlotWrite,
};
struct CheckpointSaveFailed {
    std::optional<TypedSaveSlotId> slot;
    CheckpointSaveFailureStage stage;
    Diagnostics diagnostics;
    bool operator==(const CheckpointSaveFailed&) const = default;
};
using CheckpointSaveOutcome =
    std::variant<CheckpointWriteSucceeded, DeferredAutosaveQueued, CheckpointSaveFailed>;

} // namespace noveltea::core
