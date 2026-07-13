#include "noveltea/core/flow_executor.hpp"

#include <algorithm>
#include <limits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics execution_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

std::size_t room_hook_effect_count(const CompiledProject& project,
                                   const RoomTransitionFrame& transition, RoomTransitionStage stage)
{
    const compiled::RoomDefinition* room = nullptr;
    std::optional<compiled::RoomHookKind> hook;
    switch (stage) {
    case RoomTransitionStage::BeforeLeave:
        room = transition.source_room ? project.find_room(*transition.source_room) : nullptr;
        hook = compiled::RoomHookKind::BeforeLeave;
        break;
    case RoomTransitionStage::BeforeEnter:
        room = project.find_room(transition.target_room);
        hook = compiled::RoomHookKind::BeforeEnter;
        break;
    case RoomTransitionStage::AfterLeave:
        room = transition.source_room ? project.find_room(*transition.source_room) : nullptr;
        hook = compiled::RoomHookKind::AfterLeave;
        break;
    case RoomTransitionStage::AfterEnter:
        room = project.find_room(transition.target_room);
        hook = compiled::RoomHookKind::AfterEnter;
        break;
    default:
        return 0;
    }
    if (room == nullptr || !hook)
        return 0;
    const auto found = std::find_if(
        room->lifecycle.hooks.begin(), room->lifecycle.hooks.end(),
        [&hook](const compiled::RoomHookProgram& program) { return program.hook == *hook; });
    return found == room->lifecycle.hooks.end() ? 0 : found->effects.size();
}

} // namespace

Result<void, Diagnostics> FlowExecutor::start_navigation(const RoomId& target,
                                                         const compiled::RoomExitRef& selected_exit)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    const auto* source_mode = std::get_if<RoomMode>(&m_state.m_mode);
    const auto* source = source_mode == nullptr ? nullptr : m_project.find_room(source_mode->room);
    const auto* target_room = m_project.find_room(target);
    if (source == nullptr || target_room == nullptr || !m_state.m_flow_stack.empty() ||
        selected_exit.room != source_mode->room)
        return Result<void, Diagnostics>::failure(
            execution_error("execution.invalid_navigation",
                            "Navigation requires a valid exit from the active Room"));
    const auto found =
        std::find_if(source->exits.begin(), source->exits.end(),
                     [&selected_exit, &target](const compiled::RoomExit& exit) {
                         return exit.id == selected_exit.exit_id && exit.target == target;
                     });
    if (found == source->exits.end())
        return Result<void, Diagnostics>::failure(execution_error(
            "execution.invalid_navigation", "Selected Room exit does not lead to the target Room"));
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));
    const FlowFrameId id{m_state.m_next_frame_id++};
    m_state.m_flow_stack.emplace_back(RoomTransitionFrame{id,
                                                          source_mode->room,
                                                          target,
                                                          selected_exit,
                                                          {RoomTransitionStage::SourceCanLeave, 0},
                                                          NoReturnDestination{}});
    m_state.m_mode = FlowMode{};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::advance_room_transition(RoomTransitionStage stage,
                                                                std::size_t next_effect)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back());
    if (transition == nullptr || stage > RoomTransitionStage::Complete)
        return fail(execution_error("execution.invalid_room_transition_position",
                                    "Room transition position is invalid for the active frame"));
    const auto current = transition->position.stage;
    RoomTransitionStage expected = current;
    switch (current) {
    case RoomTransitionStage::SourceCanLeave:
        expected = transition->selected_exit ? RoomTransitionStage::ExitCondition
                                             : RoomTransitionStage::TargetCanEnter;
        break;
    case RoomTransitionStage::ExitCondition:
        expected = RoomTransitionStage::TargetCanEnter;
        break;
    case RoomTransitionStage::TargetCanEnter:
        expected = transition->source_room ? RoomTransitionStage::BeforeLeave
                                           : RoomTransitionStage::BeforeEnter;
        break;
    case RoomTransitionStage::BeforeLeave:
        expected = RoomTransitionStage::BeforeEnter;
        break;
    case RoomTransitionStage::BeforeEnter:
        expected = RoomTransitionStage::CommitRoomSwitch;
        break;
    case RoomTransitionStage::CommitRoomSwitch:
        expected = transition->source_room ? RoomTransitionStage::AfterLeave
                                           : RoomTransitionStage::AfterEnter;
        break;
    case RoomTransitionStage::AfterLeave:
        expected = RoomTransitionStage::AfterEnter;
        break;
    case RoomTransitionStage::AfterEnter:
        expected = RoomTransitionStage::Complete;
        break;
    case RoomTransitionStage::Complete:
        expected = RoomTransitionStage::Complete;
        break;
    }
    const auto current_effect_count = room_hook_effect_count(m_project, *transition, current);
    const bool current_is_effect_stage = current == RoomTransitionStage::BeforeLeave ||
                                         current == RoomTransitionStage::BeforeEnter ||
                                         current == RoomTransitionStage::AfterLeave ||
                                         current == RoomTransitionStage::AfterEnter;
    const bool same_effect_stage = stage == current && current_is_effect_stage &&
                                   next_effect == transition->position.next_effect + 1 &&
                                   next_effect <= current_effect_count;
    const bool can_leave_stage =
        !current_is_effect_stage || transition->position.next_effect == current_effect_count;
    if (!same_effect_stage && (!can_leave_stage || stage != expected || next_effect != 0))
        return fail(execution_error("execution.invalid_room_transition_position",
                                    "Room transition stages must advance in lifecycle order"));
    transition->position = {stage, next_effect};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::reject_room_transition()
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    const auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back());
    if (transition == nullptr || transition->position.stage > RoomTransitionStage::TargetCanEnter)
        return fail(execution_error("execution.invalid_room_rejection",
                                    "Room transition can be rejected only before hooks or commit"));
    if (!transition->source_room)
        return fail(execution_error("execution.room_rejection_without_source",
                                    "Rejected Room transition has no Room to resume"));
    const RoomId source = *transition->source_room;
    m_state.m_flow_stack.clear();
    m_state.m_blocker.reset();
    m_state.m_mode = RoomMode{source};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::complete_room_transition()
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    const auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back());
    if (transition == nullptr || transition->position.stage != RoomTransitionStage::Complete)
        return fail(execution_error("execution.incomplete_room_transition",
                                    "Room mode begins only after all transition stages complete"));
    const RoomId target = transition->target_room;
    m_state.m_flow_stack.clear();
    m_state.m_blocker.reset();
    m_state.m_mode = RoomMode{target};
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
