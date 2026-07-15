#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/session_operation_id.hpp"

#include <compare>
#include <cstdint>
#include <optional>
#include <variant>

namespace noveltea::core {

struct PresentationSnapshotRevisionTag;
struct PresentationOperationSequenceTag;
struct MountedLayoutInstanceTag;
using PresentationSnapshotRevision = SessionSequence<PresentationSnapshotRevisionTag>;
using PresentationOperationSequence = SessionSequence<PresentationOperationSequenceTag>;
using MountedLayoutInstanceId = SessionSequence<MountedLayoutInstanceTag>;

enum class CheckpointClass : std::uint8_t {
    Reconstructible,
    CausalBarrier,
    Disposable,
};

enum class PresentationPlane : std::uint8_t {
    WorldBackground,
    WorldContent,
    WorldOverlay,
    GameUi,
    MenuOverlay,
    Modal,
    Transition,
    Debug,
};
enum class LayoutClockDomain : std::uint8_t {
    Gameplay,
    UnscaledPresentation,
};
enum class LayoutInputMode : std::uint8_t {
    None,
    Normal,
    BlockGameplay,
    Modal,
};
enum class GameplayPausePolicy : std::uint8_t {
    Continue,
    PauseWhileVisible,
};
enum class LayoutVisibility : std::uint8_t {
    Hidden,
    Visible,
};
enum class EscapeDismissalPolicy : std::uint8_t {
    Ignore,
    Dismiss,
};
enum class MountedLayoutOwner : std::uint8_t {
    Gameplay,
    Shell,
};

struct MountedLayoutPolicy {
    PresentationPlane plane;
    std::int32_t local_order = 0;
    LayoutClockDomain clock;
    LayoutInputMode input;
    GameplayPausePolicy gameplay_pause;
    LayoutVisibility visibility;
    EscapeDismissalPolicy escape_dismissal;
    std::optional<PresentationOperationId> entrance_operation;
    std::optional<PresentationOperationId> exit_operation;
    auto operator<=>(const MountedLayoutPolicy&) const = default;
};

struct MountedLayoutInstance {
    MountedLayoutInstanceId instance;
    LayoutId layout;
    MountedLayoutOwner owner;
    MountedLayoutPolicy policy;
    bool operator==(const MountedLayoutInstance&) const = default;
};

using PresentationOperationRef = std::variant<PresentationOperationId, AudioOperationId>;

enum class PresentationOperationOwner : std::uint8_t {
    GameplayRuntime,
    Shell,
};

struct NoPresentationCompletion {
    auto operator<=>(const NoPresentationCompletion&) const = default;
};
struct PresentationFlowCompletion {
    FlowFrameId owner;
    PresentationFlowBlockerHandle blocker;
    auto operator<=>(const PresentationFlowCompletion&) const = default;
};
struct AudioFlowCompletion {
    FlowFrameId owner;
    AudioFlowBlockerHandle blocker;
    auto operator<=>(const AudioFlowCompletion&) const = default;
};
struct ScriptAudioCompletion {
    FlowFrameId owner;
    ScriptInvocationHandle invocation;
    auto operator<=>(const ScriptAudioCompletion&) const = default;
};
using PresentationCompletionTarget =
    std::variant<NoPresentationCompletion, PresentationFlowCompletion, AudioFlowCompletion,
                 ScriptAudioCompletion>;

struct PresentationOperationMetadata {
    PresentationOperationRef operation;
    PresentationOperationSequence sequence;
    PresentationOperationOwner owner;
    CheckpointClass checkpoint_class;
    PresentationCompletionTarget completion;
    bool operator==(const PresentationOperationMetadata&) const = default;
};

struct PresentationOperationAccepted {
    auto operator<=>(const PresentationOperationAccepted&) const = default;
};
struct PresentationOperationRunning {
    auto operator<=>(const PresentationOperationRunning&) const = default;
};
struct PresentationOperationCompleted {
    auto operator<=>(const PresentationOperationCompleted&) const = default;
};

enum class PresentationCancellationReason : std::uint8_t {
    ExplicitRequest,
    OwnerEnded,
    FastForward,
    RuntimeReset,
    ProjectReload,
    CheckpointLoad,
};
struct PresentationOperationCancelled {
    PresentationCancellationReason reason;
    auto operator<=>(const PresentationOperationCancelled&) const = default;
};
struct PresentationOperationReplaced {
    PresentationOperationRef replacement;
    bool operator==(const PresentationOperationReplaced&) const = default;
};
enum class PresentationFailureDomain : std::uint8_t {
    WorldPresentation,
    LayoutPresentation,
    AudioPresentation,
};
struct PresentationOperationFailed {
    PresentationFailureDomain domain;
    Diagnostic diagnostic;
    bool operator==(const PresentationOperationFailed&) const = default;
};
using PresentationOperationState =
    std::variant<PresentationOperationAccepted, PresentationOperationRunning,
                 PresentationOperationCompleted, PresentationOperationCancelled,
                 PresentationOperationReplaced, PresentationOperationFailed>;

struct PresentationOperationLifecycle {
    PresentationOperationMetadata metadata;
    PresentationOperationState state;
    bool operator==(const PresentationOperationLifecycle&) const = default;
};

} // namespace noveltea::core
