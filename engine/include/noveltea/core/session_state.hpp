#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/feature_state.hpp"
#include "noveltea/core/flow.hpp"
#include "noveltea/core/property.hpp"
#include "noveltea/core/presentation_operation_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/room_presentation_contracts.hpp"

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

namespace session_state_detail {

class FlowState {
protected:
    FlowState(RuntimeMode mode, FlowStack flow_stack, std::uint64_t next_frame_id)
        : m_mode(std::move(mode)), m_flow_stack(std::move(flow_stack)),
          m_next_frame_id(next_frame_id)
    {
    }

    RuntimeMode m_mode;
    FlowStack m_flow_stack;
    std::optional<FlowBlocker> m_blocker;
    std::optional<Diagnostics> m_execution_fault;
    std::uint64_t m_next_frame_id;
    std::uint64_t m_next_blocker_handle = 1;
    bool m_flow_running = false;
};

class GameplayState {
protected:
    GameplayState(std::unordered_map<VariableId, RuntimeValue> variables,
                  std::vector<CharacterWorldState> characters,
                  std::vector<InteractableState> interactables)
        : m_variables(std::move(variables)), m_character_world(std::move(characters)),
          m_interactables(std::move(interactables))
    {
    }

    std::unordered_map<VariableId, RuntimeValue> m_variables;
    std::vector<PropertyOverride> m_property_overrides;
    std::vector<CharacterWorldState> m_character_world;
    std::vector<InteractableState> m_interactables;
    std::optional<RoomVisitContext> m_room_visit;
    std::optional<RoomVisitInstanceId> m_room_visit_instance;
    bool m_gameplay_paused = false;
};

class PresentationState {
protected:
    PresentationState(PresentationSessionId presentation_session,
                      ShellPresentationScopeId shell_presentation_scope)
        : m_presentation_session(presentation_session),
          m_shell_presentation_scope(shell_presentation_scope)
    {
    }

    PresentationSessionId m_presentation_session;
    ShellPresentationScopeId m_shell_presentation_scope;
    std::vector<DesiredBackgroundOverride> m_background_overrides;
    std::vector<DesiredActorPresentation> m_actors;
    std::vector<DesiredPresentationProp> m_presentation_props;
    std::vector<DesiredPresentationEnvironment> m_presentation_environments;
    std::vector<DesiredMountedLayout> m_mounted_layouts;
    std::vector<DesiredAudioInstance> m_desired_audio;
    std::optional<PresentedTextState> m_presented_text;
    std::optional<ActiveChoiceState> m_active_choice;
    std::optional<MapPresentationState> m_map_presentation;
};

class HistoryState {
protected:
    std::unordered_map<RoomId, std::uint64_t> m_room_visits;
    std::vector<std::pair<DialogueLineHistoryKey, std::uint64_t>> m_dialogue_line_history;
    std::vector<std::pair<DialogueChoiceHistoryKey, std::uint64_t>> m_dialogue_choice_history;
    std::vector<TextLogEntry> m_text_log;
};

class TimeState {
protected:
    std::chrono::milliseconds m_play_time{0};
    std::uint64_t m_random_state = 0x4e6f76656c546561ULL;
    std::vector<LogicalTimer> m_logical_timers;
    std::vector<LogicalTimerCompletion> m_pending_timer_completions;
    std::uint64_t m_next_logical_timer_id = 1;
};

} // namespace session_state_detail

// SessionState remains the singular public runtime-state authority. Its private value-owned base
// families organize mutation by responsibility without exposing independently orchestrated state.
class SessionState : private session_state_detail::FlowState,
                     private session_state_detail::GameplayState,
                     private session_state_detail::PresentationState,
                     private session_state_detail::HistoryState,
                     private session_state_detail::TimeState {
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
    [[nodiscard]] std::uint64_t random_state() const noexcept { return m_random_state; }
    void seed_random(std::uint64_t seed) noexcept { m_random_state = seed; }
    [[nodiscard]] std::uint64_t next_random_u64() noexcept;
    [[nodiscard]] double next_random_unit() noexcept;
    [[nodiscard]] Result<std::int64_t, Diagnostics> next_random_integer(std::int64_t minimum,
                                                                        std::int64_t maximum);
    [[nodiscard]] bool gameplay_paused() const noexcept { return m_gameplay_paused; }
    void set_gameplay_paused(bool paused) noexcept { m_gameplay_paused = paused; }
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

    [[nodiscard]] PresentationSessionId presentation_session_id() const noexcept
    {
        return m_presentation_session;
    }
    [[nodiscard]] SessionPresentationOwner session_presentation_owner() const noexcept
    {
        return SessionPresentationOwner{m_presentation_session};
    }
    [[nodiscard]] ShellPresentationOwner shell_presentation_owner() const noexcept
    {
        return ShellPresentationOwner{m_shell_presentation_scope};
    }
    [[nodiscard]] std::optional<CurrentRoomPresentationOwner>
    current_room_presentation_owner() const noexcept;
    [[nodiscard]] bool presentation_owner_is_active(const PresentationOwner& owner) const noexcept;
    [[nodiscard]] Result<void, Diagnostics>
    validate_presentation_owner(const PresentationOwner& owner) const;
    [[nodiscard]] Result<void, Diagnostics>
    validate_presentation_owner(const CompiledProject& project,
                                const PresentationOwner& owner) const;
    void remove_presentation_owned_by(const PresentationOwner& owner) noexcept;
    void remove_scene_presentation(const FlowFrame& frame) noexcept;

    [[nodiscard]] const std::vector<DesiredBackgroundOverride>&
    background_overrides() const noexcept
    {
        return m_background_overrides;
    }
    [[nodiscard]] Result<void, Diagnostics>
    upsert_background_override(const CompiledProject& project, DesiredBackgroundOverride value);
    [[nodiscard]] Result<void, Diagnostics>
    remove_background_override(const PresentationOwner& owner);
    [[nodiscard]] Result<void, Diagnostics>
    set_background(const CompiledProject& project, PresentationOwner owner,
                   compiled::BackgroundPresentation background);
    [[nodiscard]] Result<void, Diagnostics>
    set_background(const CompiledProject& project, compiled::BackgroundPresentation background)
    {
        return set_background(project, session_presentation_owner(), std::move(background));
    }

    [[nodiscard]] const std::vector<DesiredActorPresentation>& actors() const noexcept
    {
        return m_actors;
    }
    [[nodiscard]] const DesiredActorPresentation*
    actor(const ActorPresentationKey& key, const PresentationOwner& owner) const noexcept;
    [[nodiscard]] Result<void, Diagnostics> set_actor(const CompiledProject& project,
                                                      DesiredActorPresentation actor);
    [[nodiscard]] Result<void, Diagnostics> remove_actor(const CompiledProject& project,
                                                         const ActorPresentationKey& key,
                                                         const PresentationOwner& owner);
    [[nodiscard]] Result<void, Diagnostics>
    set_actor_presentation_complete(const CompiledProject& project, const ActorPresentationKey& key,
                                    const PresentationOwner& owner, bool complete);
    [[nodiscard]] const std::vector<DesiredPresentationProp>& presentation_props() const noexcept
    {
        return m_presentation_props;
    }
    [[nodiscard]] Result<void, Diagnostics> upsert_presentation_prop(const CompiledProject& project,
                                                                     DesiredPresentationProp value);
    [[nodiscard]] Result<void, Diagnostics>
    remove_presentation_prop(const PresentationPropInstanceId& instance,
                             const PresentationOwner& owner);
    [[nodiscard]] const std::vector<DesiredPresentationEnvironment>&
    presentation_environments() const noexcept
    {
        return m_presentation_environments;
    }
    [[nodiscard]] Result<void, Diagnostics>
    upsert_presentation_environment(const CompiledProject& project,
                                    DesiredPresentationEnvironment value);
    [[nodiscard]] Result<void, Diagnostics>
    remove_presentation_environment(const PresentationEnvironmentInstanceId& instance,
                                    const PresentationOwner& owner);
    [[nodiscard]] Result<void, Diagnostics>
    remove_presentation_environments(const PresentationEnvironmentStopKey& stop_key,
                                     const PresentationOwner& owner);

    [[nodiscard]] const std::vector<InteractableState>& interactables() const noexcept
    {
        return m_interactables;
    }
    [[nodiscard]] const InteractableState* interactable(const InteractableId& id) const noexcept;
    [[nodiscard]] const std::vector<CharacterWorldState>& character_world() const noexcept
    {
        return m_character_world;
    }
    [[nodiscard]] const CharacterWorldState* character_world(const CharacterId& id) const noexcept;
    [[nodiscard]] Result<void, Diagnostics> move_character(const CompiledProject& project,
                                                           const CharacterId& id,
                                                           CharacterWorldLocation location);
    [[nodiscard]] Result<void, Diagnostics>
    set_character_enabled(const CompiledProject& project, const CharacterId& id, bool enabled);
    [[nodiscard]] Result<void, Diagnostics>
    set_character_visible(const CompiledProject& project, const CharacterId& id, bool visible);
    [[nodiscard]] const std::optional<RoomVisitContext>& room_visit() const noexcept
    {
        return m_room_visit;
    }
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
    [[nodiscard]] Result<void, Diagnostics>
    commit_room_entry(const CompiledProject& project, const RoomId& room,
                      std::optional<compiled::RoomExitRef> entry_exit = std::nullopt);
    [[nodiscard]] Result<void, Diagnostics>
    commit_room_navigation(const CompiledProject& project,
                           const RoomPresentationResolution& target);
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
    void clear_text_log() noexcept { m_text_log.clear(); }

    [[nodiscard]] const std::vector<DesiredMountedLayout>& mounted_layouts() const noexcept
    {
        return m_mounted_layouts;
    }
    [[nodiscard]] Result<std::optional<LayoutId>, Diagnostics>
    layout(compiled::LayoutSlot slot) const;
    [[nodiscard]] Result<void, Diagnostics> upsert_mounted_layout(const CompiledProject& project,
                                                                  DesiredMountedLayout layout);
    [[nodiscard]] Result<void, Diagnostics>
    remove_mounted_layout(const MountedLayoutPresentationKey& key, const PresentationOwner& owner);
    [[nodiscard]] Result<void, Diagnostics> set_layout(const CompiledProject& project,
                                                       compiled::LayoutSlot slot, LayoutId layout);
    [[nodiscard]] Result<void, Diagnostics> set_layout(const CompiledProject& project,
                                                       PresentationOwner owner,
                                                       compiled::LayoutSlot slot, LayoutId layout);
    [[nodiscard]] Result<void, Diagnostics> clear_layout(compiled::LayoutSlot slot);
    [[nodiscard]] Result<void, Diagnostics> clear_layout(const PresentationOwner& owner,
                                                         compiled::LayoutSlot slot);
    [[nodiscard]] const std::vector<DesiredAudioInstance>& desired_audio() const noexcept
    {
        return m_desired_audio;
    }
    [[nodiscard]] const DesiredAudioInstance*
    desired_audio(const DesiredAudioInstanceId& instance,
                  const PresentationOwner& owner) const noexcept;
    [[nodiscard]] Result<void, Diagnostics> upsert_desired_audio(const CompiledProject& project,
                                                                 DesiredAudioInstance value);
    [[nodiscard]] Result<void, Diagnostics>
    remove_desired_audio(const DesiredAudioInstanceId& instance, const PresentationOwner& owner);
    [[nodiscard]] Result<void, Diagnostics>
    remove_desired_audio_bus(compiled::AudioChannel bus, const PresentationOwner& owner);
    [[nodiscard]] Result<void, Diagnostics>
    apply_presentation_target(const CompiledProject& project,
                              const PresentationTargetDraft& target);
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
                                                          const SessionState&);

    SessionState(RuntimeMode mode, FlowStack flow_stack,
                 std::unordered_map<VariableId, RuntimeValue> variables,
                 std::vector<CharacterWorldState> characters,
                 std::vector<InteractableState> interactables, std::uint64_t next_frame_id,
                 PresentationSessionId presentation_session,
                 ShellPresentationScopeId shell_presentation_scope)
        : FlowState(std::move(mode), std::move(flow_stack), next_frame_id),
          GameplayState(std::move(variables), std::move(characters), std::move(interactables)),
          PresentationState(presentation_session, shell_presentation_scope)
    {
    }

    [[nodiscard]] static Result<RoomVisitInstanceId, Diagnostics> allocate_room_visit_instance_id();

    void store_property_override(PropertyOverride value);
    void erase_property_override(const PropertyOwnerRef& owner,
                                 const PropertyId& property) noexcept;
};

} // namespace noveltea::core
