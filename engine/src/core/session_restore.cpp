#include "noveltea/core/flow_executor.hpp"

#include "noveltea/core/save_state.hpp"
#include "noveltea/core/save_state_codec.hpp"

#include <algorithm>
#include <limits>
#include <type_traits>
#include <unordered_map>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics restore_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

std::uint64_t saved_frame_number(const SavedFlowFrame& frame) noexcept
{
    return std::visit([](const auto& value) { return value.snapshot_id.value; }, frame);
}

} // namespace

Result<SessionState, Diagnostics> FlowExecutor::restore_session(const CompiledProject& project,
                                                                const SaveState& save)
{
    auto valid = validate_save_state(project, save, "save-slot");
    if (!valid)
        return Result<SessionState, Diagnostics>::failure(valid.error());

    auto created = SessionState::create(project);
    auto* state = created.value_if();
    if (state == nullptr)
        return Result<SessionState, Diagnostics>::failure(created.error());

    state->m_mode = save.mode;
    state->m_flow_stack.clear();
    state->m_blocker.reset();
    state->m_execution_fault.reset();
    state->m_variables.clear();
    for (const auto& variable : save.variables)
        state->m_variables.emplace(variable.id, variable.value);
    state->m_property_overrides.clear();
    for (const auto& saved_override : save.property_overrides) {
        const auto* definition = project.find_property(saved_override.property);
        if (definition == nullptr)
            return Result<SessionState, Diagnostics>::failure(restore_error(
                "save_restore.invalid_property", "Validated property declaration disappeared."));
        auto restored =
            make_property_override(saved_override.owner, *definition, saved_override.value);
        auto* value = restored.value_if();
        if (value == nullptr)
            return Result<SessionState, Diagnostics>::failure(restored.error());
        state->store_property_override(std::move(*value));
    }
    state->m_interactables = save.interactables;
    state->m_room_visits.clear();
    for (const auto& visits : save.room_visits)
        state->m_room_visits.emplace(visits.room, visits.count);
    state->m_dialogue_line_history.clear();
    for (const auto& history : save.dialogue_line_history)
        state->m_dialogue_line_history.emplace_back(history.key, history.count);
    state->m_dialogue_choice_history.clear();
    for (const auto& history : save.dialogue_choice_history)
        state->m_dialogue_choice_history.emplace_back(history.key, history.count);
    state->m_text_log = save.text_log;
    state->m_play_time = save.play_time;
    state->m_random_state = save.random_state;
    state->m_gameplay_paused = false;

    std::uint64_t max_timer_id = 0;
    for (const auto& timer : save.logical_timers)
        max_timer_id = std::max(max_timer_id, timer.id.value);
    for (const auto& completion : save.pending_timer_completions)
        max_timer_id = std::max(max_timer_id, completion.id.value);
    std::vector<std::uint64_t> saved_timer_ids;
    saved_timer_ids.reserve(save.logical_timers.size() + save.pending_timer_completions.size());
    for (const auto& timer : save.logical_timers)
        saved_timer_ids.push_back(timer.id.value);
    for (const auto& completion : save.pending_timer_completions)
        saved_timer_ids.push_back(completion.id.value);
    std::sort(saved_timer_ids.begin(), saved_timer_ids.end());
    saved_timer_ids.erase(std::unique(saved_timer_ids.begin(), saved_timer_ids.end()),
                          saved_timer_ids.end());
    if (saved_timer_ids.size() >= std::numeric_limits<std::uint64_t>::max() - max_timer_id)
        return Result<SessionState, Diagnostics>::failure(restore_error(
            "save_restore.handle_overflow", "Logical timer handles cannot be reconstructed."));
    std::unordered_map<std::uint64_t, std::uint64_t> timer_ids;
    std::uint64_t next_timer_id = max_timer_id + 1;
    for (const auto saved_id : saved_timer_ids)
        timer_ids.emplace(saved_id, next_timer_id++);
    state->m_logical_timers.clear();
    for (const auto& timer : save.logical_timers) {
        const auto restored_id = timer_ids.find(timer.id.value);
        if (restored_id == timer_ids.end())
            return Result<SessionState, Diagnostics>::failure(restore_error(
                "save_restore.invalid_timer", "Saved logical timer identity was not mapped."));
        state->m_logical_timers.push_back(LogicalTimer{LogicalTimerId{restored_id->second},
                                                       timer.remaining, timer.repeat_interval});
    }
    state->m_pending_timer_completions.clear();
    for (const auto& completion : save.pending_timer_completions) {
        const auto restored_id = timer_ids.find(completion.id.value);
        if (restored_id == timer_ids.end())
            return Result<SessionState, Diagnostics>::failure(restore_error(
                "save_restore.invalid_timer", "Saved timer completion identity was not mapped."));
        state->m_pending_timer_completions.push_back(
            LogicalTimerCompletion{LogicalTimerId{restored_id->second}, completion.occurrences});
    }
    state->m_next_logical_timer_id = next_timer_id;

    std::uint64_t max_frame_id = 0;
    for (const auto& frame : save.flow_stack)
        max_frame_id = std::max(max_frame_id, saved_frame_number(frame));
    if (save.flow_stack.size() >= std::numeric_limits<std::uint64_t>::max() - max_frame_id)
        return Result<SessionState, Diagnostics>::failure(restore_error(
            "save_restore.handle_overflow", "Flow frame handles cannot be reconstructed."));
    std::unordered_map<std::uint64_t, std::uint64_t> frame_ids;
    std::uint64_t next_frame_id = max_frame_id + 1;
    state->m_flow_stack.reserve(save.flow_stack.size());
    for (const auto& saved_frame : save.flow_stack) {
        const auto snapshot_id = saved_frame_number(saved_frame);
        const auto live_id = next_frame_id++;
        frame_ids.emplace(snapshot_id, live_id);
        state->m_flow_stack.push_back(std::visit(
            [live_id](const auto& frame) -> FlowFrame {
                using T = std::decay_t<decltype(frame)>;
                const FlowFrameId id{live_id};
                if constexpr (std::is_same_v<T, SavedSceneFrame>)
                    return SceneFrame{id, frame.scene, frame.position, frame.destination};
                else if constexpr (std::is_same_v<T, SavedDialogueFrame>)
                    return DialogueFrame{id, frame.dialogue, frame.position, frame.destination};
                else if constexpr (std::is_same_v<T, SavedInteractionFrame>)
                    return InteractionFrame{id, frame.invocation, frame.program, frame.position,
                                            frame.destination};
                else
                    return RoomTransitionFrame{id,
                                               frame.source_room,
                                               frame.target_room,
                                               frame.selected_exit,
                                               frame.position,
                                               frame.destination};
            },
            saved_frame));
    }
    state->m_next_frame_id = next_frame_id;
    state->m_next_blocker_handle = 1;
    if (save.blocker) {
        const auto owner_snapshot =
            std::visit([](const auto& blocker) { return blocker.owner.value; }, *save.blocker);
        const auto owner = frame_ids.find(owner_snapshot);
        if (owner == frame_ids.end())
            return Result<SessionState, Diagnostics>::failure(restore_error(
                "save_restore.invalid_blocker", "Saved blocker owner could not be reconstructed."));
        const FlowFrameId owner_id{owner->second};
        state->m_blocker = std::visit(
            [owner_id](const auto& blocker) -> FlowBlocker {
                using T = std::decay_t<decltype(blocker)>;
                if constexpr (std::is_same_v<T, SavedInputBlocker>)
                    return InputFlowBlocker{owner_id, InputFlowBlockerHandle{1}};
                else
                    return DurationFlowBlocker{owner_id, DurationFlowBlockerHandle{1},
                                               blocker.remaining};
            },
            *save.blocker);
        state->m_next_blocker_handle = 2;
    }

    state->m_actors.clear();
    state->m_background.reset();
    state->m_layouts.clear();
    state->m_overlays.clear();
    state->m_presented_text.reset();
    state->m_active_choice.reset();
    state->m_transition.reset();
    state->m_audio_channels.clear();
    state->m_map_presentation.reset();
    const auto reconstruct_room_presentation = [&project, state](const RoomId& room) {
        const auto* definition = project.find_room(room);
        if (definition == nullptr)
            return;
        state->m_background = definition->background;
        for (const auto& overlay : definition->overlays)
            state->m_overlays.push_back(RoomOverlayState{room, overlay.id, overlay.visible});
    };
    if (const auto* room = std::get_if<RoomMode>(&state->m_mode)) {
        reconstruct_room_presentation(room->room);
    } else if (!state->m_flow_stack.empty()) {
        const auto* transition = std::get_if<RoomTransitionFrame>(&state->m_flow_stack.back());
        if (transition != nullptr) {
            const bool committed = transition->position.stage >= RoomTransitionStage::AfterLeave;
            if (committed)
                reconstruct_room_presentation(transition->target_room);
            else if (transition->source_room)
                reconstruct_room_presentation(*transition->source_room);
        }
    }
    state->m_flow_running = false;
    return Result<SessionState, Diagnostics>::success(std::move(*state));
}

} // namespace noveltea::core
