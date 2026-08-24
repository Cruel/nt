#pragma once

#include "noveltea/core/session_state.hpp"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace noveltea::core {

struct SaveStateMetadata {
    ProjectId project;
    std::string project_version;
    std::string save_contract;
};

struct SavedRuntimeRoomConfiguration {
    RoomId id;
    bool declared = false;
    RuntimeConfigurationSource birth_source;
    std::optional<RuntimeConfigurationSource> structural_override_source;
    RuntimeInstanceProvenance provenance;
    std::vector<RuntimeRoomExitTargetOverride> birth_exit_target_overrides;
    std::vector<RuntimeRoomExitTargetOverride> structural_override_exit_target_overrides;
    std::vector<RuntimeRoomExitTargetOverride> exit_target_overrides;
};
struct SavedRuntimeCharacterConfiguration {
    CharacterId id;
    bool declared = false;
    RuntimeConfigurationSource birth_source;
    std::optional<RuntimeConfigurationSource> structural_override_source;
    RuntimeInstanceProvenance provenance;
};
struct SavedRuntimeInteractableConfiguration {
    InteractableId id;
    bool declared = false;
    RuntimeConfigurationSource birth_source;
    std::optional<RuntimeConfigurationSource> structural_override_source;
    RuntimeInstanceProvenance provenance;
};

struct SavedPropertyOverride {
    PropertyTargetRef target;
    PropertyId property;
    RuntimeValue value;
};

struct SavedRoomVisits {
    RoomId room;
    std::uint64_t count;
};

struct SavedDialogueLineHistory {
    DialogueLineHistoryKey key;
    std::uint64_t count;
};

struct SavedDialogueChoiceHistory {
    DialogueChoiceHistoryKey key;
    std::uint64_t count;
};

// Snapshot-local only: reconnects pending timer completions to their saved timer. It is never a
// live SessionState handle or a project ID.
struct SavedLogicalTimerId {
    std::uint64_t value;
    auto operator<=>(const SavedLogicalTimerId&) const = default;
};

struct SavedLogicalTimer {
    SavedLogicalTimerId id;
    std::chrono::milliseconds remaining;
    std::optional<std::chrono::milliseconds> repeat_interval;
};

struct SavedLogicalTimerCompletion {
    SavedLogicalTimerId id;
    std::uint64_t occurrences;
};

// Snapshot-local only: reconnects a saved blocker to its saved frame. It is never a project ID.
struct SavedFlowFrameId {
    std::uint64_t value;
    auto operator<=>(const SavedFlowFrameId&) const = default;
};

struct SavedSceneFrame {
    SavedFlowFrameId snapshot_id;
    SceneId scene;
    SceneFramePosition position;
    ReturnDestination destination;
};
struct SavedDialogueFrame {
    SavedFlowFrameId snapshot_id;
    DialogueId dialogue;
    DialogueFramePosition position;
    std::vector<DialogueStageSlotRuntimeState> stage_slots;
    std::vector<DialogueMediaSlotRuntimeState> media_slots;
    ReturnDestination destination;
};
struct SavedInteractionFrame {
    SavedFlowFrameId snapshot_id;
    InteractionInvocationContext invocation;
    InteractionProgramRef program;
    InteractionFramePosition position;
    ReturnDestination destination;
};
struct SavedRoomTransitionFrame {
    SavedFlowFrameId snapshot_id;
    std::optional<RoomId> source_room;
    RoomId target_room;
    std::optional<compiled::RoomExitRef> selected_exit;
    RoomTransitionKind kind = RoomTransitionKind::DirectedRoomChange;
    RoomEntryCause entry_cause = RoomEntryCause::DirectedRoomChange;
    std::optional<RoomVisitContext> source_context;
    RoomTransitionPosition position;
    ReturnDestination destination;
};
using SavedFlowFrame = std::variant<SavedSceneFrame, SavedDialogueFrame, SavedInteractionFrame,
                                    SavedRoomTransitionFrame>;

struct SavedInputBlocker {
    SavedFlowFrameId owner;
};
struct SavedDurationBlocker {
    SavedFlowFrameId owner;
    std::chrono::milliseconds remaining;
};
using SavedFlowBlocker = std::variant<SavedInputBlocker, SavedDurationBlocker>;

struct SavedScenePresentationOwner {
    SavedFlowFrameId invocation;
    SceneId scene;
    auto operator<=>(const SavedScenePresentationOwner&) const = default;
};
struct SavedCurrentRoomPresentationOwner {
    RoomId room;
    auto operator<=>(const SavedCurrentRoomPresentationOwner&) const = default;
};
struct SavedRoomPresentationOwner {
    RoomId room;
    auto operator<=>(const SavedRoomPresentationOwner&) const = default;
};
struct SavedSessionPresentationOwner {
    auto operator<=>(const SavedSessionPresentationOwner&) const = default;
};
using SavedPresentationOwner =
    std::variant<SavedScenePresentationOwner, SavedCurrentRoomPresentationOwner,
                 SavedRoomPresentationOwner, SavedSessionPresentationOwner>;

struct SavedSceneActorKey {
    SavedScenePresentationOwner owner;
    ActorSlotId slot;
    auto operator<=>(const SavedSceneActorKey&) const = default;
};
using SavedActorPresentationKey =
    std::variant<CharacterActorKey, RoomCastActorKey, SavedSceneActorKey, ScopedActorKey>;

struct SavedBackgroundOverride {
    SavedPresentationOwner owner;
    compiled::BackgroundPresentation background;
};

struct SavedCameraView {
    SavedPresentationOwner owner;
    compiled::CameraView view;
};

struct SavedActorPresentation {
    SavedActorPresentationKey key;
    SavedPresentationOwner owner;
    CharacterId character;
    CharacterPresentationProfileId profile;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    std::optional<CharacterAppearanceId> appearance;
    std::optional<CharacterIdleId> idle;
    ActorLogicalPlacement placement;
    bool visible = false;
    bool presentation_complete = true;
};

struct SavedPresentationProp {
    PresentationPropInstanceId instance;
    SavedPresentationOwner owner;
    std::optional<AssetId> asset;
    std::optional<MaterialId> material;
    std::optional<compiled::RoomPlacementRef> placement;
    compiled::NormalizedRect bounds{0.0, 0.0, 0.0, 0.0};
    PresentationPlane plane = PresentationPlane::WorldContent;
    std::int32_t order = 0;
    bool visible = true;
};

struct SavedPresentationEnvironment {
    PresentationEnvironmentInstanceId instance;
    SavedPresentationOwner owner;
    PresentationEnvironmentStopKey stop_key;
    std::optional<AssetId> asset;
    MaterialId material;
    compiled::NormalizedRect bounds{0.0, 0.0, 1.0, 1.0};
    PresentationPlane plane = PresentationPlane::WorldContent;
    std::int32_t order = 0;
    LayoutClockDomain clock = LayoutClockDomain::Gameplay;
    compiled::Vector2 scroll_per_second{0.0, 0.0};
    double opacity = 1.0;
    bool visible = true;
};

struct SavedBackgroundMaterialOccurrence {
    auto operator<=>(const SavedBackgroundMaterialOccurrence&) const = default;
};
struct SavedActorMaterialOccurrence {
    SavedActorPresentationKey key;
    CharacterPresentationLayerId layer;
    auto operator<=>(const SavedActorMaterialOccurrence&) const = default;
};
struct SavedPropMaterialOccurrence {
    PresentationPropInstanceId instance;
    auto operator<=>(const SavedPropMaterialOccurrence&) const = default;
};
struct SavedEnvironmentMaterialOccurrence {
    PresentationEnvironmentInstanceId instance;
    auto operator<=>(const SavedEnvironmentMaterialOccurrence&) const = default;
};
struct SavedLayoutMaterialOccurrence {
    MountedLayoutPresentationKey key;
    MaterialId material;
    auto operator<=>(const SavedLayoutMaterialOccurrence&) const = default;
};
struct SavedPostprocessMaterialOccurrence {
    PostprocessEffectInstanceId instance;
    auto operator<=>(const SavedPostprocessMaterialOccurrence&) const = default;
};
using SavedMaterialOccurrence =
    std::variant<SavedBackgroundMaterialOccurrence, SavedActorMaterialOccurrence,
                 SavedPropMaterialOccurrence, SavedEnvironmentMaterialOccurrence,
                 SavedLayoutMaterialOccurrence, SavedPostprocessMaterialOccurrence>;

struct SavedMaterialParameter {
    SavedPresentationOwner owner;
    SavedMaterialOccurrence occurrence;
    MaterialId material;
    std::string parameter;
    std::optional<compiled::MaterialParameterValue> value;
    std::optional<MaterialParameterBinding> binding;
    MaterialClockPolicy clock = MaterialClockPolicy::Gameplay;
};

struct SavedPostprocessEffect {
    PostprocessEffectInstanceId instance;
    SavedPresentationOwner owner;
    MaterialId material;
    compiled::MaterialPostprocessScope scope = compiled::MaterialPostprocessScope::World;
    std::int32_t order = 0;
    MaterialClockPolicy clock = MaterialClockPolicy::Gameplay;
    bool visible = true;
};

struct SavedMountedLayout {
    MountedLayoutPresentationKey key;
    SavedPresentationOwner owner;
    LayoutId layout;
    MountedLayoutPolicy policy;
    LayoutScaleOverrides scale_overrides{};
    PresentationCompositionGroup composition_group = PresentationCompositionGroup::Interface;
    std::vector<LayoutInputAssignment> inputs;
    std::vector<LayoutSignalId> connected_signals;
};

struct SavedVisitLayoutStateOwner {
    RoomId room;
    auto operator<=>(const SavedVisitLayoutStateOwner&) const = default;
};
struct SavedRoomLayoutStateOwner {
    RoomId room;
    auto operator<=>(const SavedRoomLayoutStateOwner&) const = default;
};
struct SavedFlowLayoutStateOwner {
    SavedFlowFrameId flow;
    auto operator<=>(const SavedFlowLayoutStateOwner&) const = default;
};
struct SavedSessionLayoutStateOwner {
    auto operator<=>(const SavedSessionLayoutStateOwner&) const = default;
};
using SavedLayoutStateScopeOwner =
    std::variant<SavedVisitLayoutStateOwner, SavedRoomLayoutStateOwner, SavedFlowLayoutStateOwner,
                 SavedSessionLayoutStateOwner>;

struct SavedLayoutStateSlot {
    SavedLayoutStateScopeOwner scope_owner;
    MountedLayoutPresentationKey key;
    LayoutId layout;
    PersistableValue value;
    bool operator==(const SavedLayoutStateSlot&) const = default;
};

struct SavedDesiredAudio {
    DesiredAudioInstanceId instance;
    SavedPresentationOwner owner;
    compiled::AudioPurpose purpose = compiled::AudioPurpose::Music;
    compiled::AudioPausePolicy pause_policy = compiled::AudioPausePolicy::Gameplay;
    AssetId asset;
    double gain = 1.0;
    double pan = 0.0;
    std::optional<compiled::AudioPanSource> pan_source;
    std::chrono::milliseconds fade_in{0};
    std::chrono::milliseconds fade_out{0};
    std::optional<DesiredAudioReplacementKey> replacement_key;
};

struct SaveState {
    SaveStateMetadata metadata;
    std::chrono::milliseconds play_time{0};
    std::uint64_t random_state = 0;
    std::uint64_t next_runtime_instance_id = 1;
    std::uint64_t next_item_stack_id = 1;
    std::uint64_t room_entry_sequence = 0;
    std::vector<SavedRuntimeRoomConfiguration> runtime_rooms;
    std::vector<SavedRuntimeCharacterConfiguration> runtime_characters;
    std::vector<SavedRuntimeInteractableConfiguration> runtime_interactables;
    std::vector<SavedPropertyOverride> property_overrides;
    std::vector<CharacterWorldState> characters;
    std::vector<InteractableState> interactables;
    std::vector<ItemStackState> item_stacks;
    std::optional<RoomVisitContext> active_room_visit;
    std::vector<SavedRoomVisits> room_visits;
    std::vector<SavedDialogueLineHistory> dialogue_line_history;
    std::vector<SavedDialogueChoiceHistory> dialogue_choice_history;
    std::vector<TextLogEntry> text_log;
    std::vector<SavedLogicalTimer> logical_timers;
    std::vector<SavedLogicalTimerCompletion> pending_timer_completions;
    std::vector<SavedBackgroundOverride> background_overrides;
    std::vector<SavedCameraView> camera_views;
    std::vector<SavedActorPresentation> actors;
    std::vector<SavedPresentationProp> presentation_props;
    std::vector<SavedPresentationEnvironment> presentation_environments;
    std::vector<SavedMaterialParameter> material_parameters;
    std::vector<SavedPostprocessEffect> postprocess_effects;
    std::vector<SavedMountedLayout> mounted_layouts;
    std::vector<SavedLayoutStateSlot> layout_state_slots;
    std::vector<SavedDesiredAudio> desired_audio;
    std::optional<PresentedTextState> presented_text;
    std::optional<ActiveChoiceState> active_choice;
    RuntimeMode mode;
    std::vector<SavedFlowFrame> flow_stack;
    std::optional<SavedFlowBlocker> blocker;
};

[[nodiscard]] Result<SaveState, Diagnostics> make_save_state(const CompiledProject& project,
                                                             const SessionState& session);

} // namespace noveltea::core
