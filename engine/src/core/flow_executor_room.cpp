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

bool is_effect_stage(RoomTransitionStage stage) noexcept
{
    return stage == RoomTransitionStage::BeforeLeave || stage == RoomTransitionStage::BeforeEnter ||
           stage == RoomTransitionStage::AfterLeave || stage == RoomTransitionStage::AfterEnter;
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
        next_position.stage > RoomTransitionStage::Complete)
        return fail(
            execution_error("execution.stale_room_transition_position",
                            "Room transition advancement does not match the active position"));

    auto valid = validate_position(*transition, FlowFramePosition{next_position});
    if (!valid)
        return fail(valid.error());

    const bool effect_stage = is_effect_stage(expected_position.stage);
    const auto effect_count =
        room_hook_effect_count(m_project, *transition, expected_position.stage);
    const bool advances_effect = effect_stage && next_position.stage == expected_position.stage &&
                                 next_position.next_effect == expected_position.next_effect + 1 &&
                                 !next_position.awaiting_completion &&
                                 next_position.next_effect <= effect_count;
    const bool stage_complete = !effect_stage || (!expected_position.awaiting_completion &&
                                                  expected_position.next_effect == effect_count);
    const bool advances_stage = stage_complete && next_position.stage == next_stage(*transition) &&
                                next_position.next_effect == 0 &&
                                !next_position.awaiting_completion;
    if (!advances_effect && !advances_stage)
        return fail(execution_error("execution.invalid_room_transition_position",
                                    "Room transition stages must advance in lifecycle order"));

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
    const bool waitable_stage =
        transition != nullptr && (is_effect_stage(expected_position.stage) ||
                                  expected_position.stage == RoomTransitionStage::CommitRoomSwitch);
    if (transition == nullptr || transition->position != expected_position || !m_state.m_blocker ||
        flow_blocker_owner(*m_state.m_blocker) != transition->frame_id || !waitable_stage ||
        expected_position.awaiting_completion || next_position.stage != expected_position.stage ||
        next_position.next_effect != expected_position.next_effect ||
        !next_position.awaiting_completion)
        return fail(
            execution_error("execution.invalid_room_transition_wait",
                            "Room transition wait does not match the active lifecycle step"));
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
