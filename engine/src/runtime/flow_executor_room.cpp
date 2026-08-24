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

RoomTransitionStage next_stage(const RoomTransitionFrame& transition) noexcept
{
    switch (transition.position.stage) {
    case RoomTransitionStage::SourceCanLeave:
        return transition.selected_exit ? RoomTransitionStage::ExitCondition
                                        : RoomTransitionStage::TargetCanEnter;
    case RoomTransitionStage::ExitCondition:
        return RoomTransitionStage::TargetCanEnter;
    case RoomTransitionStage::TargetCanEnter:
        return transition.source_room ? RoomTransitionStage::BeforeLeave
                                      : RoomTransitionStage::BeforeEnter;
    case RoomTransitionStage::BeforeLeave:
        return RoomTransitionStage::BeforeEnter;
    case RoomTransitionStage::BeforeEnter:
        return RoomTransitionStage::CommitRoomSwitch;
    case RoomTransitionStage::CommitRoomSwitch:
        return transition.source_room ? RoomTransitionStage::AfterLeave
                                      : RoomTransitionStage::AfterEnter;
    case RoomTransitionStage::AfterLeave:
        return RoomTransitionStage::AfterEnter;
    case RoomTransitionStage::AfterEnter:
    case RoomTransitionStage::Complete:
        return RoomTransitionStage::Complete;
    }
    return RoomTransitionStage::Complete;
}

} // namespace

Result<void, Diagnostics> FlowExecutor::start_navigation(const RoomId& target,
                                                         const compiled::RoomExitRef& selected_exit)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    const auto* source_mode = std::get_if<RoomMode>(&m_state.m_mode);
    const auto* source = source_mode == nullptr ? nullptr : room_definition(source_mode->room);
    const auto* target_room = room_definition(target);
    const auto* source_context = m_state.m_room_visit ? &*m_state.m_room_visit : nullptr;
    if (source == nullptr || target_room == nullptr || source_context == nullptr ||
        source_context->room != source_mode->room || !m_state.m_flow_stack.empty() ||
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
                                                          RoomTransitionKind::NavigationAttempt,
                                                          RoomEntryCause::NavigationAttempt,
                                                          *source_context,
                                                          {RoomTransitionStage::SourceCanLeave, 0},
                                                          NoReturnDestination{}});
    m_state.m_mode = FlowMode{};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::advance_room_transition(RoomTransitionStage stage,
                                                                std::size_t next_effect)
{
    if (m_state.m_flow_stack.empty())
        return fail(execution_error("execution.invalid_room_transition_position",
                                    "Room transition position is invalid for the active frame"));
    const auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back());
    if (transition == nullptr)
        return fail(execution_error("execution.invalid_room_transition_position",
                                    "Room transition position is invalid for the active frame"));
    return advance_room_transition(transition->position,
                                   RoomTransitionPosition{stage, next_effect, false});
}

Result<void, Diagnostics>
FlowExecutor::advance_room_transition(const RoomTransitionPosition& expected_position,
                                      RoomTransitionPosition next_position)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back());
    if (transition == nullptr || transition->position != expected_position ||
        next_position.stage > RoomTransitionStage::Complete || next_position.next_effect != 0 ||
        next_position.awaiting_completion || next_position.stage != next_stage(*transition))
        return fail(execution_error(
            "execution.stale_room_transition_position",
            "Room transition advancement does not match canonical lifecycle order"));

    auto valid = validate_position(*transition, FlowFramePosition{next_position});
    if (!valid)
        return fail(valid.error());
    transition->position = std::move(next_position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
FlowExecutor::mark_room_transition_wait(const RoomTransitionPosition& expected_position,
                                        RoomTransitionPosition next_position)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    auto* transition = !m_state.m_flow_stack.empty()
                           ? std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back())
                           : nullptr;
    if (transition == nullptr || transition->position != expected_position || !m_state.m_blocker ||
        flow_blocker_owner(*m_state.m_blocker) != transition->frame_id ||
        expected_position.stage != RoomTransitionStage::CommitRoomSwitch ||
        expected_position.awaiting_completion || next_position.stage != expected_position.stage ||
        next_position.next_effect != 0 || !next_position.awaiting_completion)
        return fail(execution_error("execution.invalid_room_transition_wait",
                                    "Only the committed Room presentation transition may block"));
    auto valid = validate_position(*transition, FlowFramePosition{next_position});
    if (!valid)
        return fail(valid.error());
    transition->position = std::move(next_position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::reject_room_transition()
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    const auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back());
    if (transition == nullptr || transition->kind != RoomTransitionKind::NavigationAttempt ||
        transition->position.stage > RoomTransitionStage::TargetCanEnter ||
        !transition->source_context || !transition->source_room ||
        transition->source_context->room != *transition->source_room)
        return fail(execution_error("execution.invalid_room_rejection",
                                    "Only a pre-commit Navigation Attempt may be rejected"));
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
