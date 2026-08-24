#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/flow.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/presentation_operation_contracts.hpp"
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
struct PrimaryActivateInput {
    compiled::InteractionSubject subject;
    bool operator==(const PrimaryActivateInput&) const = default;
};
struct OpenVerbMenuInput {
    compiled::InteractionSubject subject;
    bool operator==(const OpenVerbMenuInput&) const = default;
};
struct InvokeInteractionInput {
    VerbId verb;
    std::vector<InteractionSubjectBinding> bindings;
    bool operator==(const InvokeInteractionInput&) const = default;
};
struct BeginCommandBuilderInput {
    std::vector<compiled::InteractionSubject> watched_subjects;
    bool operator==(const BeginCommandBuilderInput&) const = default;
};
struct CommandBuilderSubjectPressInput {
    CommandBuilderOccurrenceId occurrence;
    compiled::InteractionSubject subject;
    bool operator==(const CommandBuilderSubjectPressInput&) const = default;
};
struct UpdateCommandBuilderWatchInput {
    CommandBuilderOccurrenceId occurrence;
    std::vector<compiled::InteractionSubject> watched_subjects;
    bool operator==(const UpdateCommandBuilderWatchInput&) const = default;
};
struct SubmitCommandBuilderInput {
    CommandBuilderOccurrenceId occurrence;
    VerbId verb;
    std::vector<InteractionSubjectBinding> bindings;
    bool operator==(const SubmitCommandBuilderInput&) const = default;
};
struct CancelCommandBuilderInput {
    CommandBuilderOccurrenceId occurrence;
    bool operator==(const CancelCommandBuilderInput&) const = default;
};
struct SetVariableDebugInput {
    PropertyId variable;
    std::optional<RuntimeValue> value;
    bool operator==(const SetVariableDebugInput&) const = default;
};
struct SetPropertyDebugInput {
    PropertyOwnerRef owner;
    PropertyId property;
    RuntimeValue value;
    bool operator==(const SetPropertyDebugInput&) const = default;
};
struct LayoutSignalInput {
    PresentationOwner owner;
    MountedLayoutPresentationKey key;
    LayoutMountOccurrenceId occurrence;
    LayoutSignalId signal;
    std::vector<LayoutSignalFieldValue> fields;
    bool operator==(const LayoutSignalInput&) const = default;
};
struct CommitLayoutStateInput {
    PresentationOwner owner;
    MountedLayoutPresentationKey key;
    LayoutMountOccurrenceId occurrence;
    LayoutStateScope scope = LayoutStateScope::Session;
    PersistableValue value;
    bool operator==(const CommitLayoutStateInput&) const = default;
};
struct ClearLayoutStateInput {
    PresentationOwner owner;
    MountedLayoutPresentationKey key;
    LayoutMountOccurrenceId occurrence;
    LayoutStateScope scope = LayoutStateScope::Session;
    bool operator==(const ClearLayoutStateInput&) const = default;
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
using RuntimeInputMessage = std::variant<
    StartRuntimeInput, StopRuntimeInput, ResetRuntimeInput, AdvanceTimeInput, ContinueInput,
    SelectSceneChoiceInput, SelectDialogueChoiceInput, NavigateRoomInput,
    SelectInteractionSubjectsInput, ClearInteractionSubjectSelectionInput, PrimaryActivateInput,
    OpenVerbMenuInput, InvokeInteractionInput, BeginCommandBuilderInput,
    CommandBuilderSubjectPressInput, UpdateCommandBuilderWatchInput, SubmitCommandBuilderInput,
    CancelCommandBuilderInput, SetVariableDebugInput, SetPropertyDebugInput, LayoutSignalInput,
    CommitLayoutStateInput, ClearLayoutStateInput, SaveRuntimeInput, LoadRuntimeInput,
    BeginPlaybackInput, EndPlaybackInput, ClearPlaybackInput, UndoPlaybackStepInput,
    ReplayPlaybackInput, CompletePresentationInput, CancelPresentationInput, CompleteAudioInput,
    CancelAudioInput, AcknowledgeAudioTerminationInput>;

using PresentationOperation =
    std::variant<SceneTransitionGroupOperation, RoomNavigationTransitionOperation,
                 BackgroundPresentationOperation, CameraPanOperation, CameraZoomOperation,
                 CameraRotationOperation, CameraFocusOperation, CameraShakeOperation,
                 CameraPunchOperation, CameraFlashOperation, ActorPresentationOperation,
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
struct VerbOfferAmbiguityObservation {
    compiled::InteractionSubject subject;
    std::vector<VerbId> primary_verbs;
    bool operator==(const VerbOfferAmbiguityObservation&) const = default;
};
struct LayoutSignalObservation {
    PresentationOwner owner;
    MountedLayoutPresentationKey key;
    LayoutMountOccurrenceId occurrence;
    LayoutSignalId signal;
    std::vector<LayoutSignalFieldValue> fields;
    bool operator==(const LayoutSignalObservation&) const = default;
};
using RuntimeObservation =
    std::variant<PlaybackObservation, DebuggerObservation, RuntimeStateObservation,
                 RoomPresentationDiagnosticObservation, VerbOfferAmbiguityObservation,
                 LayoutSignalObservation, CheckpointRuntimeObservation>;

} // namespace noveltea::core
