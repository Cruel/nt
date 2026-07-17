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
    static constexpr std::uint32_t current_format_version = 6;

    std::uint32_t format_version = current_format_version;
    ProjectId project;
    std::string project_version;
};

struct SavedVariable {
    VariableId id;
    RuntimeValue value;
};

struct SavedPropertyOverride {
    PropertyOwnerRef owner;
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

struct SavedActorPresentation {
    SavedActorPresentationKey key;
    SavedPresentationOwner owner;
    CharacterId character;
    CharacterPoseId pose;
    CharacterExpressionId expression;
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

struct SavedMountedLayout {
    MountedLayoutPresentationKey key;
    SavedPresentationOwner owner;
    LayoutId layout;
    MountedLayoutPolicy policy;
    PresentationCompositionGroup composition_group = PresentationCompositionGroup::Interface;
};

struct SavedDesiredAudio {
    DesiredAudioInstanceId instance;
    SavedPresentationOwner owner;
    compiled::AudioChannel bus = compiled::AudioChannel::Music;
    AssetId asset;
    double volume = 1.0;
    std::chrono::milliseconds fade_in{0};
    std::chrono::milliseconds fade_out{0};
    std::optional<DesiredAudioReplacementKey> replacement_key;
};

struct SaveState {
    SaveStateMetadata metadata;
    std::chrono::milliseconds play_time{0};
    std::uint64_t random_state = 0;
    std::vector<SavedVariable> variables;
    std::vector<SavedPropertyOverride> property_overrides;
    std::vector<CharacterWorldState> characters;
    std::vector<InteractableState> interactables;
    std::optional<RoomVisitContext> active_room_visit;
    std::vector<SavedRoomVisits> room_visits;
    std::vector<SavedDialogueLineHistory> dialogue_line_history;
    std::vector<SavedDialogueChoiceHistory> dialogue_choice_history;
    std::vector<TextLogEntry> text_log;
    std::vector<SavedLogicalTimer> logical_timers;
    std::vector<SavedLogicalTimerCompletion> pending_timer_completions;
    std::vector<SavedBackgroundOverride> background_overrides;
    std::vector<SavedActorPresentation> actors;
    std::vector<SavedPresentationProp> presentation_props;
    std::vector<SavedPresentationEnvironment> presentation_environments;
    std::vector<SavedMountedLayout> mounted_layouts;
    std::vector<SavedDesiredAudio> desired_audio;
    std::optional<PresentedTextState> presented_text;
    std::optional<ActiveChoiceState> active_choice;
    std::optional<MapPresentationState> map_presentation;
    RuntimeMode mode;
    std::vector<SavedFlowFrame> flow_stack;
    std::optional<SavedFlowBlocker> blocker;
};

[[nodiscard]] Result<SaveState, Diagnostics> make_save_state(const CompiledProject& project,
                                                             const SessionState& session);

} // namespace noveltea::core
