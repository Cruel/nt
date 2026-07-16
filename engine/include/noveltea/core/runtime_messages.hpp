#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/flow.hpp"
#include "noveltea/core/presentation_contracts.hpp"
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

struct TransitionPresentationOperation {
    PresentationOperationId id;
    compiled::TransitionKind kind;
    std::chrono::milliseconds duration{0};
    std::optional<std::string> color;
    std::optional<FlowFrameId> owner;
    std::optional<PresentationFlowBlockerHandle> completion;
    bool operator==(const TransitionPresentationOperation&) const = default;
};
struct LayoutPresentationOperation {
    PresentationOperationId id;
    compiled::LayoutAction action;
    compiled::LayoutSlot slot;
    std::optional<LayoutId> layout;
    bool operator==(const LayoutPresentationOperation&) const = default;
};
using PresentationOperation =
    std::variant<TransitionPresentationOperation, LayoutPresentationOperation>;

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
using RuntimeObservation =
    std::variant<PlaybackObservation, DebuggerObservation, RuntimeStateObservation>;

} // namespace noveltea::core
