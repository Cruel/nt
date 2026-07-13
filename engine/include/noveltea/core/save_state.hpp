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
    static constexpr std::uint32_t current_format_version = 1;

    std::uint32_t format_version = current_format_version;
    ProjectId project;
    std::string project_version;
};

struct SavedVariable {
    VariableId id;
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

struct SaveState {
    SaveStateMetadata metadata;
    std::chrono::milliseconds play_time{0};
    std::vector<SavedVariable> variables;
    std::vector<PropertyOverride> property_overrides;
    std::vector<InteractableState> interactables;
    std::vector<SavedRoomVisits> room_visits;
    std::vector<SavedDialogueLineHistory> dialogue_line_history;
    std::vector<SavedDialogueChoiceHistory> dialogue_choice_history;
    std::vector<TextLogEntry> text_log;
    std::vector<LogicalTimer> logical_timers;
    std::vector<LogicalTimerCompletion> pending_timer_completions;
    RuntimeMode mode;
    std::vector<SavedFlowFrame> flow_stack;
    std::optional<SavedFlowBlocker> blocker;
};

struct SaveSnapshotContext {
    std::size_t in_flight_external_requests = 0;
};

[[nodiscard]] Result<SaveState, Diagnostics> make_save_state(const CompiledProject& project,
                                                             const SessionState& session,
                                                             SaveSnapshotContext context = {});

} // namespace noveltea::core
