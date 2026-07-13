#include "noveltea/core/save_state.hpp"

#include <algorithm>
#include <type_traits>

namespace noveltea::core {
namespace {

void add_preflight_error(Diagnostics& diagnostics, std::string code, std::string message)
{
    diagnostics.push_back(Diagnostic{.code = std::move(code), .message = std::move(message)});
}

std::optional<SavedFlowFrameId> saved_owner(const FlowStack& stack,
                                            const FlowFrameId& owner) noexcept
{
    for (std::size_t index = 0; index < stack.size(); ++index) {
        if (flow_frame_id(stack[index]) == owner)
            return SavedFlowFrameId{index + 1};
    }
    return std::nullopt;
}

SavedFlowFrame save_frame(const FlowFrame& frame, std::size_t index)
{
    const SavedFlowFrameId snapshot_id{index + 1};
    return std::visit(
        [snapshot_id](const auto& value) -> SavedFlowFrame {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneFrame>)
                return SavedSceneFrame{snapshot_id, value.scene, value.position, value.destination};
            else if constexpr (std::is_same_v<T, DialogueFrame>)
                return SavedDialogueFrame{snapshot_id, value.dialogue, value.position,
                                          value.destination};
            else if constexpr (std::is_same_v<T, InteractionFrame>)
                return SavedInteractionFrame{snapshot_id, value.invocation, value.program,
                                             value.position, value.destination};
            else
                return SavedRoomTransitionFrame{snapshot_id,       value.source_room,
                                                value.target_room, value.selected_exit,
                                                value.position,    value.destination};
        },
        frame);
}

} // namespace

Result<SaveState, Diagnostics> make_save_state(const CompiledProject& project,
                                               const SessionState& session,
                                               SaveSnapshotContext context)
{
    Diagnostics diagnostics;
    if (session.m_execution_fault)
        add_preflight_error(diagnostics, "save.execution_fault",
                            "A faulted execution session cannot be saved");
    if (session.m_flow_running)
        add_preflight_error(diagnostics, "save.execution_in_progress",
                            "A session cannot be saved while flow execution is in progress");
    if (context.in_flight_external_requests != 0)
        add_preflight_error(diagnostics, "save.external_requests_pending",
                            "Host requests must be consumed or rejected before saving");
    if (session.m_blocker && std::holds_alternative<ScriptFlowBlocker>(*session.m_blocker))
        add_preflight_error(diagnostics, "save.opaque_script_suspension",
                            "Opaque Lua coroutine suspension is not serializable");
    if (!diagnostics.empty())
        return Result<SaveState, Diagnostics>::failure(std::move(diagnostics));

    SaveState save{
        .metadata = {SaveStateMetadata::current_format_version, project.identity().id,
                     project.identity().version},
        .play_time = session.m_play_time,
        .variables = {},
        .property_overrides = {},
        .interactables = session.m_interactables,
        .room_visits = {},
        .dialogue_line_history = {},
        .dialogue_choice_history = {},
        .text_log = session.m_text_log,
        .logical_timers = session.m_logical_timers,
        .pending_timer_completions = session.m_pending_timer_completions,
        .mode = session.m_mode,
        .flow_stack = {},
        .blocker = std::nullopt,
    };

    save.variables.reserve(project.variables().size());
    for (const auto& definition : project.variables()) {
        const auto value = session.m_variables.find(definition.id);
        if (value != session.m_variables.end())
            save.variables.push_back(SavedVariable{definition.id, value->second});
    }
    for (const auto& value : session.m_property_overrides) {
        const auto* definition = project.find_property(value.property_id());
        if (definition != nullptr && definition->persistence() == PropertyPersistence::Save)
            save.property_overrides.push_back(value);
    }
    save.room_visits.reserve(session.m_room_visits.size());
    for (const auto& [room, count] : session.m_room_visits)
        save.room_visits.push_back(SavedRoomVisits{room, count});
    std::sort(save.room_visits.begin(), save.room_visits.end(),
              [](const SavedRoomVisits& left, const SavedRoomVisits& right) {
                  return left.room.text() < right.room.text();
              });
    for (const auto& [key, count] : session.m_dialogue_line_history)
        save.dialogue_line_history.push_back(SavedDialogueLineHistory{key, count});
    for (const auto& [key, count] : session.m_dialogue_choice_history)
        save.dialogue_choice_history.push_back(SavedDialogueChoiceHistory{key, count});
    save.flow_stack.reserve(session.m_flow_stack.size());
    for (std::size_t index = 0; index < session.m_flow_stack.size(); ++index)
        save.flow_stack.push_back(save_frame(session.m_flow_stack[index], index));

    if (session.m_blocker) {
        const auto owner =
            saved_owner(session.m_flow_stack, flow_blocker_owner(*session.m_blocker));
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(Diagnostics{
                Diagnostic{.code = "save.invalid_blocker_owner",
                           .message = "The active blocker is not owned by a saved flow frame"}});
        if (const auto* input = std::get_if<InputFlowBlocker>(&*session.m_blocker)) {
            (void)input;
            save.blocker = SavedInputBlocker{*owner};
        } else if (const auto* duration = std::get_if<DurationFlowBlocker>(&*session.m_blocker)) {
            save.blocker = SavedDurationBlocker{*owner, duration->remaining};
        }
        // Presentation and audio blockers are reconstructed at their logical post-operation state.
    }
    return Result<SaveState, Diagnostics>::success(std::move(save));
}

} // namespace noveltea::core
