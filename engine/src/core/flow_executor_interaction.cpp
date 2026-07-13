#include "noveltea/core/flow_executor.hpp"

#include <utility>

namespace noveltea::core {
namespace {

Diagnostics interaction_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

} // namespace

Result<void, Diagnostics>
FlowExecutor::advance_interaction(const InteractionFramePosition& expected_position,
                                  InteractionProgramRef next_program,
                                  InteractionFramePosition next_position)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    auto* frame = std::get_if<InteractionFrame>(&m_state.m_flow_stack.back());
    if (frame == nullptr || frame->position != expected_position)
        return fail(interaction_error("execution.stale_interaction_position",
                                      "Interaction position changed before it was advanced"));
    FlowFrame candidate = *frame;
    auto& candidate_frame = std::get<InteractionFrame>(candidate);
    candidate_frame.program = next_program;
    candidate_frame.position = next_position;
    auto valid = validate_position(candidate, FlowFramePosition{next_position});
    if (!valid)
        return fail(valid.error());
    frame->program = std::move(next_program);
    frame->position = std::move(next_position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
FlowExecutor::mark_interaction_wait(const InteractionFramePosition& expected_position,
                                    InteractionFramePosition next_position)
{
    if (!next_position.awaiting_completion)
        return fail(interaction_error("execution.invalid_interaction_wait",
                                      "Interaction wait position must await completion"));
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    auto* frame = std::get_if<InteractionFrame>(&m_state.m_flow_stack.back());
    if (frame == nullptr || frame->position != expected_position)
        return fail(interaction_error("execution.stale_interaction_position",
                                      "Interaction position changed before it was blocked"));
    auto valid = validate_position(*frame, FlowFramePosition{next_position});
    if (!valid)
        return fail(valid.error());
    frame->position = std::move(next_position);
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
