#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/feature_state.hpp"
#include "noveltea/core/flow.hpp"
#include "noveltea/core/property.hpp"
#include "noveltea/core/result.hpp"

#include <cstddef>
#include <chrono>
#include <compare>
#include <cstdint>
#include <optional>
#include <utility>
#include <unordered_map>
#include <variant>
#include <vector>

namespace noveltea::core {

struct SaveState;
struct SaveSnapshotContext;

class LogicalTimerId {
public:
    LogicalTimerId() = delete;
    [[nodiscard]] std::uint64_t number() const noexcept { return m_value; }
    auto operator<=>(const LogicalTimerId&) const = default;

private:
    friend class SessionState;
    friend class FlowExecutor;
    explicit LogicalTimerId(std::uint64_t value) noexcept : m_value(value) {}
    std::uint64_t m_value;
};

struct LogicalTimer {
    LogicalTimerId id;
    std::chrono::milliseconds remaining;
    std::optional<std::chrono::milliseconds> repeat_interval;
};

struct LogicalTimerCompletion {
    LogicalTimerId id;
    std::uint64_t occurrences;
};

struct RoomMode {
    RoomId room;
};
struct FlowMode {};
struct EndedMode {};
using RuntimeMode = std::variant<RoomMode, FlowMode, EndedMode>;

// Typed kernel state remains intentionally separate from feature state and persistence, which are
// added by their owning phases rather than mirrored from the transitional GameSession.
class SessionState {
public:
    SessionState() = delete;

    [[nodiscard]] static Result<SessionState, Diagnostics> create(const CompiledProject& project);

    [[nodiscard]] const RuntimeMode& mode() const noexcept { return m_mode; }
    [[nodiscard]] const FlowStack& flow_stack() const noexcept { return m_flow_stack; }
    [[nodiscard]] const std::optional<FlowBlocker>& blocker() const noexcept { return m_blocker; }
    [[nodiscard]] const std::optional<Diagnostics>& execution_fault() const noexcept
    {
        return m_execution_fault;
    }
    [[nodiscard]] std::chrono::milliseconds play_time() const noexcept { return m_play_time; }
    [[nodiscard]] Result<void, Diagnostics> advance_time(std::chrono::milliseconds elapsed);
    [[nodiscard]] Result<LogicalTimerId, Diagnostics>
    start_logical_timer(std::chrono::milliseconds initial_duration,
                        std::optional<std::chrono::milliseconds> repeat_interval = std::nullopt);
    [[nodiscard]] bool cancel_logical_timer(const LogicalTimerId& id) noexcept;
    [[nodiscard]] const std::vector<LogicalTimer>& logical_timers() const noexcept
    {
        return m_logical_timers;
    }
    [[nodiscard]] const std::vector<LogicalTimerCompletion>&
    pending_timer_completions() const noexcept
    {
        return m_pending_timer_completions;
    }
    [[nodiscard]] std::vector<LogicalTimerCompletion> take_timer_completions() noexcept;

    [[nodiscard]] Result<RuntimeValue, Diagnostics> variable(const CompiledProject& project,
                                                             const VariableId& id) const;
    [[nodiscard]] Result<void, Diagnostics> set_variable(const CompiledProject& project,
                                                         const VariableId& id, RuntimeValue value);

    [[nodiscard]] const RuntimeValue* property_override(const PropertyOwnerRef& owner,
                                                        const PropertyId& property) const noexcept;
    [[nodiscard]] std::size_t property_override_count() const noexcept
    {
        return m_property_overrides.size();
    }

    [[nodiscard]] const std::vector<ActorState>& actors() const noexcept { return m_actors; }
    [[nodiscard]] const ActorState* actor(const ActorSlotKey& key) const noexcept;
    [[nodiscard]] Result<void, Diagnostics> set_actor(const CompiledProject& project,
                                                      ActorState actor);
    [[nodiscard]] Result<void, Diagnostics> remove_actor(const CompiledProject& project,
                                                         const ActorSlotKey& key);
    [[nodiscard]] Result<void, Diagnostics>
    set_actor_presentation_complete(const CompiledProject& project, const ActorSlotKey& key,
                                    bool complete);

    [[nodiscard]] const std::vector<InteractableState>& interactables() const noexcept
    {
        return m_interactables;
    }
    [[nodiscard]] const InteractableState* interactable(const InteractableId& id) const noexcept;
    [[nodiscard]] Result<void, Diagnostics>
    move_interactable(const CompiledProject& project, const InteractableId& id,
                      compiled::InteractableLocation location);
    [[nodiscard]] Result<void, Diagnostics> set_interactable_enabled(const CompiledProject& project,
                                                                     const InteractableId& id,
                                                                     bool enabled);
    [[nodiscard]] Result<void, Diagnostics> set_interactable_visible(const CompiledProject& project,
                                                                     const InteractableId& id,
                                                                     bool visible);

    [[nodiscard]] std::uint64_t room_visits(const RoomId& room) const noexcept;
    [[nodiscard]] Result<void, Diagnostics> record_room_visit(const CompiledProject& project,
                                                              const RoomId& room);
    [[nodiscard]] Result<void, Diagnostics> commit_room_entry(const CompiledProject& project,
                                                              const RoomId& room);
    [[nodiscard]] std::uint64_t
    dialogue_line_visits(const DialogueLineHistoryKey& key) const noexcept;
    [[nodiscard]] std::uint64_t
    dialogue_choice_visits(const DialogueChoiceHistoryKey& key) const noexcept;
    [[nodiscard]] Result<void, Diagnostics> record_dialogue_line(const CompiledProject& project,
                                                                 const DialogueLineHistoryKey& key);
    [[nodiscard]] Result<void, Diagnostics>
    record_dialogue_choice(const CompiledProject& project, const DialogueChoiceHistoryKey& key);

    [[nodiscard]] const std::vector<TextLogEntry>& text_log() const noexcept { return m_text_log; }
    [[nodiscard]] Result<void, Diagnostics> append_text_log(const CompiledProject& project,
                                                            TextLogEntry entry);

    [[nodiscard]] const std::optional<compiled::BackgroundPresentation>& background() const noexcept
    {
        return m_background;
    }
    [[nodiscard]] Result<void, Diagnostics>
    set_background(const CompiledProject& project, compiled::BackgroundPresentation background);
    [[nodiscard]] const std::vector<LayoutSlotState>& layouts() const noexcept { return m_layouts; }
    [[nodiscard]] Result<void, Diagnostics> set_layout(const CompiledProject& project,
                                                       compiled::LayoutSlot slot, LayoutId layout);
    void clear_layout(compiled::LayoutSlot slot) noexcept;
    [[nodiscard]] const std::vector<RoomOverlayState>& overlays() const noexcept
    {
        return m_overlays;
    }
    [[nodiscard]] Result<void, Diagnostics> set_overlay(const CompiledProject& project, RoomId room,
                                                        RoomOverlayId overlay, bool visible);
    [[nodiscard]] const std::optional<PresentedTextState>& presented_text() const noexcept
    {
        return m_presented_text;
    }
    [[nodiscard]] Result<void, Diagnostics> present_text(const CompiledProject& project,
                                                         PresentedTextState text);
    void clear_presented_text() noexcept { m_presented_text.reset(); }
    [[nodiscard]] const std::optional<ActiveChoiceState>& active_choice() const noexcept
    {
        return m_active_choice;
    }
    [[nodiscard]] Result<void, Diagnostics> present_choice(const CompiledProject& project,
                                                           ActiveChoiceState choice);
    void clear_choice() noexcept { m_active_choice.reset(); }
    [[nodiscard]] const std::optional<LogicalTransitionState>& transition() const noexcept
    {
        return m_transition;
    }
    [[nodiscard]] Result<void, Diagnostics> set_transition(LogicalTransitionState transition);
    [[nodiscard]] const std::vector<AudioChannelState>& audio_channels() const noexcept
    {
        return m_audio_channels;
    }
    [[nodiscard]] Result<void, Diagnostics> set_audio_channel(const CompiledProject& project,
                                                              AudioChannelState audio);
    [[nodiscard]] const std::optional<MapPresentationState>& map_presentation() const noexcept
    {
        return m_map_presentation;
    }
    [[nodiscard]] Result<void, Diagnostics> set_map_presentation(const CompiledProject& project,
                                                                 MapPresentationState map);

private:
    friend class FlowExecutor;
    friend class PropertyResolver;
    friend Result<SaveState, Diagnostics> make_save_state(const CompiledProject&,
                                                          const SessionState&, SaveSnapshotContext);

    SessionState(RuntimeMode mode, FlowStack flow_stack,
                 std::unordered_map<VariableId, RuntimeValue> variables,
                 std::vector<InteractableState> interactables, std::uint64_t next_frame_id)
        : m_mode(std::move(mode)), m_flow_stack(std::move(flow_stack)),
          m_variables(std::move(variables)), m_interactables(std::move(interactables)),
          m_next_frame_id(next_frame_id)
    {
    }

    void store_property_override(PropertyOverride value);
    void erase_property_override(const PropertyOwnerRef& owner,
                                 const PropertyId& property) noexcept;

    RuntimeMode m_mode;
    FlowStack m_flow_stack;
    std::optional<FlowBlocker> m_blocker;
    std::optional<Diagnostics> m_execution_fault;
    std::unordered_map<VariableId, RuntimeValue> m_variables;
    std::vector<PropertyOverride> m_property_overrides;
    std::vector<ActorState> m_actors;
    std::vector<InteractableState> m_interactables;
    std::unordered_map<RoomId, std::uint64_t> m_room_visits;
    std::vector<std::pair<DialogueLineHistoryKey, std::uint64_t>> m_dialogue_line_history;
    std::vector<std::pair<DialogueChoiceHistoryKey, std::uint64_t>> m_dialogue_choice_history;
    std::vector<TextLogEntry> m_text_log;
    std::optional<compiled::BackgroundPresentation> m_background;
    std::vector<LayoutSlotState> m_layouts;
    std::vector<RoomOverlayState> m_overlays;
    std::optional<PresentedTextState> m_presented_text;
    std::optional<ActiveChoiceState> m_active_choice;
    std::optional<LogicalTransitionState> m_transition;
    std::vector<AudioChannelState> m_audio_channels;
    std::optional<MapPresentationState> m_map_presentation;
    std::chrono::milliseconds m_play_time{0};
    std::vector<LogicalTimer> m_logical_timers;
    std::vector<LogicalTimerCompletion> m_pending_timer_completions;
    std::uint64_t m_next_logical_timer_id = 1;
    std::uint64_t m_next_frame_id;
    std::uint64_t m_next_blocker_handle = 1;
    bool m_flow_running = false;
};

} // namespace noveltea::core
