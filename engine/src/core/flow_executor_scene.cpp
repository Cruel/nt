#include "noveltea/core/flow_executor.hpp"

#include <algorithm>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics execution_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

} // namespace

Result<void, Diagnostics> FlowExecutor::advance_scene(const SceneId& scene,
                                                      const SceneStepId& expected_step,
                                                      SceneFramePosition next_position)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    auto* frame = std::get_if<SceneFrame>(&m_state.m_flow_stack.back());
    if (frame == nullptr || frame->scene != scene || frame->position.next_step != expected_step)
        return fail(execution_error("execution.stale_scene_position",
                                    "Scene advancement does not match the active step"));
    auto valid = validate_position(*frame, FlowFramePosition{next_position});
    if (!valid)
        return fail(valid.error());
    frame->position = std::move(next_position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::mark_scene_wait(const SceneId& scene,
                                                        const SceneStepId& expected_step,
                                                        SceneStepSubstate substate)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    auto* frame = !m_state.m_flow_stack.empty()
                      ? std::get_if<SceneFrame>(&m_state.m_flow_stack.back())
                      : nullptr;
    if (frame == nullptr || frame->scene != scene || frame->position.next_step != expected_step ||
        !m_state.m_blocker || flow_blocker_owner(*m_state.m_blocker) != frame->frame_id)
        return fail(execution_error("execution.invalid_scene_wait",
                                    "Scene wait does not match the active step and blocker"));
    SceneFramePosition position{expected_step, std::move(substate)};
    auto valid = validate_position(*frame, FlowFramePosition{position});
    if (!valid)
        return fail(valid.error());
    frame->position = std::move(position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::choose_scene_option(const FlowFrameId& owner,
                                                            const InputFlowBlockerHandle& handle,
                                                            const SceneChoiceOptionId& option)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    auto* blocker =
        m_state.m_blocker ? std::get_if<InputFlowBlocker>(&*m_state.m_blocker) : nullptr;
    auto* frame = !m_state.m_flow_stack.empty()
                      ? std::get_if<SceneFrame>(&m_state.m_flow_stack.back())
                      : nullptr;
    const auto* choice_state = m_state.m_active_choice
                                   ? std::get_if<SceneChoiceState>(&*m_state.m_active_choice)
                                   : nullptr;
    if (blocker == nullptr || blocker->owner != owner || blocker->handle != handle ||
        frame == nullptr || frame->frame_id != owner || !frame->position.next_step ||
        !std::holds_alternative<SceneChoiceSelectionPosition>(frame->position.substate) ||
        choice_state == nullptr || choice_state->scene != frame->scene ||
        choice_state->step != *frame->position.next_step)
        return Result<void, Diagnostics>::failure(execution_error(
            "execution.stale_scene_choice", "Scene choice does not match the active selection"));
    const auto selected = std::find_if(choice_state->options.begin(), choice_state->options.end(),
                                       [&option](const SceneChoiceOptionState& candidate) {
                                           return candidate.option == option && candidate.enabled;
                                       });
    if (selected == choice_state->options.end())
        return Result<void, Diagnostics>::failure(execution_error(
            "execution.invalid_scene_choice", "Scene choice option is missing or disabled"));
    SceneFramePosition position{frame->position.next_step,
                                SceneChoiceEffectPosition{option, 0, false}};
    auto valid = validate_position(*frame, FlowFramePosition{position});
    if (!valid)
        return fail(valid.error());
    m_state.m_blocker.reset();
    m_state.m_active_choice.reset();
    frame->position = std::move(position);
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
