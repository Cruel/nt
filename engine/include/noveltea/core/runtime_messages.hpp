#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/flow.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/presentation_operation_requests.hpp"
#include "noveltea/core/runtime_value.hpp"
#include "noveltea/core/session_operation_id.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"

#include <chrono>
#include <compare>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

struct StartRuntimeInput {
    auto operator<=>(const StartRuntimeInput&) const = default;
};
struct StopRuntimeInput {
    auto operator<=>(const StopRuntimeInput&) const = default;
};
struct ResetRuntimeInput {
    auto operator<=>(const ResetRuntimeInput&) const = default;
};
struct AdvanceTimeInput {
    std::chrono::microseconds elapsed{0};
    auto operator<=>(const AdvanceTimeInput&) const = default;
};
struct ContinueInput {
    auto operator<=>(const ContinueInput&) const = default;
};
struct SelectSceneChoiceInput {
    SceneChoiceOptionId option;
    auto operator<=>(const SelectSceneChoiceInput&) const = default;
};
struct SelectDialogueChoiceInput {
    DialogueEdgeId edge;
    auto operator<=>(const SelectDialogueChoiceInput&) const = default;
};
struct NavigateRoomInput {
    RoomExitId exit;
    auto operator<=>(const NavigateRoomInput&) const = default;
};
struct SelectInteractionSubjectsInput {
    std::vector<compiled::InteractionSubject> subjects;
    bool operator==(const SelectInteractionSubjectsInput&) const = default;
};
struct ClearInteractionSubjectSelectionInput {
    auto operator<=>(const ClearInteractionSubjectSelectionInput&) const = default;
};
struct InvokeInteractionInput {
    VerbId verb;
    std::vector<compiled::InteractionSubject> operands;
    bool operator==(const InvokeInteractionInput&) const = default;
};
struct SetVariableDebugInput {
    VariableId variable;
    RuntimeValue value;
    bool operator==(const SetVariableDebugInput&) const = default;
};
struct SetPropertyDebugInput {
    PropertyOwnerRef owner;
    PropertyId property;
    RuntimeValue value;
    bool operator==(const SetPropertyDebugInput&) const = default;
};
struct SaveRuntimeInput {
    TypedSaveSlotId slot;
    auto operator<=>(const SaveRuntimeInput&) const = default;
};
struct LoadRuntimeInput {
    TypedSaveSlotId slot;
    auto operator<=>(const LoadRuntimeInput&) const = default;
};
struct BeginPlaybackInput {
    auto operator<=>(const BeginPlaybackInput&) const = default;
};
struct EndPlaybackInput {
    auto operator<=>(const EndPlaybackInput&) const = default;
};
struct ClearPlaybackInput {
    auto operator<=>(const ClearPlaybackInput&) const = default;
};
struct UndoPlaybackStepInput {
    auto operator<=>(const UndoPlaybackStepInput&) const = default;
};
struct ReplayPlaybackInput {
    auto operator<=>(const ReplayPlaybackInput&) const = default;
};
struct CompletePresentationInput {
    PresentationOperationId operation;
    FlowFrameId owner;
    PresentationFlowBlockerHandle completion;
    auto operator<=>(const CompletePresentationInput&) const = default;
};
struct CancelPresentationInput {
    PresentationOperationId operation;
    FlowFrameId owner;
    PresentationFlowBlockerHandle completion;
    auto operator<=>(const CancelPresentationInput&) const = default;
};
struct CompleteAudioInput {
    AudioOperationId operation;
    FlowFrameId owner;
    AudioCompletionHandle completion;
    auto operator<=>(const CompleteAudioInput&) const = default;
};
struct CancelAudioInput {
    AudioOperationId operation;
    FlowFrameId owner;
    AudioCompletionHandle completion;
    auto operator<=>(const CancelAudioInput&) const = default;
};
struct AcknowledgeAudioTerminationInput {
    AudioOperationId operation;
    auto operator<=>(const AcknowledgeAudioTerminationInput&) const = default;
};
using RuntimeInputMessage =
    std::variant<StartRuntimeInput, StopRuntimeInput, ResetRuntimeInput, AdvanceTimeInput,
                 ContinueInput, SelectSceneChoiceInput, SelectDialogueChoiceInput,
                 NavigateRoomInput, SelectInteractionSubjectsInput,
                 ClearInteractionSubjectSelectionInput, InvokeInteractionInput,
                 SetVariableDebugInput, SetPropertyDebugInput, SaveRuntimeInput, LoadRuntimeInput,
                 BeginPlaybackInput, EndPlaybackInput, ClearPlaybackInput, UndoPlaybackStepInput,
                 ReplayPlaybackInput, CompletePresentationInput, CancelPresentationInput,
                 CompleteAudioInput, CancelAudioInput, AcknowledgeAudioTerminationInput>;

using PresentationOperation =
    std::variant<SceneTransitionGroupOperation, RoomNavigationTransitionOperation,
                 BackgroundPresentationOperation, ActorPresentationOperation,
                 LayoutFinitePresentationOperation>;

struct NewAudioPlaybackTarget {
    auto operator<=>(const NewAudioPlaybackTarget&) const = default;
};
struct AudioPlaybackOperationTarget {
    AudioOperationId operation;
    auto operator<=>(const AudioPlaybackOperationTarget&) const = default;
};
struct DesiredAudioOperationTarget {
    DesiredAudioInstanceId instance;
    PresentationOwner owner;
    bool operator==(const DesiredAudioOperationTarget&) const = default;
};
struct AudioBusOperationTarget {
    compiled::AudioChannel bus;
    auto operator<=>(const AudioBusOperationTarget&) const = default;
};
using AudioOperationTarget = std::variant<NewAudioPlaybackTarget, AudioPlaybackOperationTarget,
                                          DesiredAudioOperationTarget, AudioBusOperationTarget>;

enum class AudioOperationPurpose : std::uint8_t {
    Gameplay,
    UiCosmetic,
};

struct AudioOperation {
    AudioOperationId id;
    compiled::AudioAction action;
    compiled::AudioChannel channel;
    std::optional<AssetId> asset;
    std::chrono::milliseconds fade{0};
    bool loop = false;
    double volume = 1.0;
    std::optional<FlowFrameId> owner;
    std::optional<AudioCompletionHandle> completion;
    AudioOperationTarget target = NewAudioPlaybackTarget{};
    AudioOperationPurpose purpose = AudioOperationPurpose::Gameplay;
    bool skippable = true;
    bool operator==(const AudioOperation&) const = default;
};

enum class SaveOutcomeStatus : std::uint8_t {
    Saved,
    Loaded,
    Deleted,
    Failed
};
struct SaveOutcome {
    TypedSaveSlotId slot;
    SaveOutcomeStatus status = SaveOutcomeStatus::Saved;
    bool autosave = false;
    auto operator<=>(const SaveOutcome&) const = default;
};

struct PlaybackObservation {
    std::size_t step_index = 0;
    bool handled = false;
    auto operator<=>(const PlaybackObservation&) const = default;
};
struct DebuggerObservation {
    std::optional<FlowFrameId> active_frame;
    bool operator==(const DebuggerObservation&) const = default;
};
struct RuntimeStateObservation {
    RuntimeMode mode;
    std::optional<FlowFrameId> active_frame;
    std::optional<FlowBlockerKind> blocker;
    bool operator==(const RuntimeStateObservation&) const = default;
};
struct RoomPresentationDiagnosticObservation {
    RoomId room;
    Diagnostics diagnostics;
    bool operator==(const RoomPresentationDiagnosticObservation&) const = default;
};
using RuntimeObservation =
    std::variant<PlaybackObservation, DebuggerObservation, RuntimeStateObservation,
                 RoomPresentationDiagnosticObservation, CheckpointRuntimeObservation>;

} // namespace noveltea::core
