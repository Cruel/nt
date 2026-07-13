#include "noveltea/core/flow_executor.hpp"

#include <limits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics execution_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

} // namespace

Result<FlowBlocker, Diagnostics> FlowExecutor::block_top(FlowBlockerKind kind)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return Result<FlowBlocker, Diagnostics>::failure(ready.error());
    if (kind > FlowBlockerKind::Script ||
        m_state.m_next_blocker_handle == std::numeric_limits<std::uint64_t>::max())
        return Result<FlowBlocker, Diagnostics>::failure(
            execution_error("execution.invalid_blocker", "Flow blocker cannot be allocated"));
    const auto owner = flow_frame_id(m_state.m_flow_stack.back());
    const auto handle = m_state.m_next_blocker_handle++;
    FlowBlocker blocker = [&]() -> FlowBlocker {
        switch (kind) {
        case FlowBlockerKind::Input:
            return InputFlowBlocker{owner, InputFlowBlockerHandle{handle}};
        case FlowBlockerKind::Duration:
            return DurationFlowBlocker{owner, DurationFlowBlockerHandle{handle}};
        case FlowBlockerKind::Presentation:
            return PresentationFlowBlocker{owner, PresentationFlowBlockerHandle{handle}};
        case FlowBlockerKind::Audio:
            return AudioFlowBlocker{owner, AudioFlowBlockerHandle{handle}};
        case FlowBlockerKind::Script:
            return ScriptFlowBlocker{owner, ScriptInvocationHandle{handle}};
        }
        return InputFlowBlocker{owner, InputFlowBlockerHandle{handle}};
    }();
    m_state.m_blocker = blocker;
    return Result<FlowBlocker, Diagnostics>::success(std::move(blocker));
}

Result<FlowBlocker, Diagnostics> FlowExecutor::block_duration(DurationWait duration)
{
    auto blocker = block_top(FlowBlockerKind::Duration);
    auto* value = blocker.value_if();
    if (value == nullptr)
        return blocker;
    auto* typed = std::get_if<DurationFlowBlocker>(value);
    if (typed == nullptr) {
        m_state.m_blocker.reset();
        return Result<FlowBlocker, Diagnostics>::failure(execution_error(
            "execution.invalid_blocker", "Duration wait did not allocate a Duration blocker"));
    }
    typed->remaining = duration.duration();
    m_state.m_blocker = *typed;
    return blocker;
}

Result<bool, Diagnostics>
FlowExecutor::advance_duration_blocker(const FlowFrameId& owner,
                                       const DurationFlowBlockerHandle& handle,
                                       std::chrono::milliseconds elapsed)
{
    if (m_state.m_execution_fault)
        return Result<bool, Diagnostics>::failure(*m_state.m_execution_fault);
    if (elapsed.count() < 0)
        return Result<bool, Diagnostics>::failure(execution_error(
            "execution.invalid_wait_elapsed", "Duration wait elapsed time cannot be negative"));
    auto* blocker =
        m_state.m_blocker ? std::get_if<DurationFlowBlocker>(&*m_state.m_blocker) : nullptr;
    if (blocker == nullptr || blocker->owner != owner || blocker->handle != handle)
        return Result<bool, Diagnostics>::failure(execution_error(
            "execution.stale_blocker", "Duration wait update does not match the active blocker"));
    if (elapsed >= blocker->remaining) {
        m_state.m_blocker.reset();
        return Result<bool, Diagnostics>::success(true);
    }
    blocker->remaining -= elapsed;
    return Result<bool, Diagnostics>::success(false);
}

Result<void, Diagnostics> FlowExecutor::validate_blocker(const FlowFrameId& owner,
                                                         const AnyFlowBlockerHandle& handle) const
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    if (!m_state.m_blocker || flow_blocker_owner(*m_state.m_blocker) != owner ||
        flow_blocker_handle(*m_state.m_blocker) != handle)
        return Result<void, Diagnostics>::failure(execution_error(
            "execution.stale_blocker", "Blocker does not match the active frame and operation"));
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::resume_blocker(const FlowFrameId& owner,
                                                       const AnyFlowBlockerHandle& handle)
{
    auto valid = validate_blocker(owner, handle);
    if (!valid)
        return valid;
    m_state.m_blocker.reset();
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::cancel_blocker(const FlowFrameId& owner,
                                                       const AnyFlowBlockerHandle& handle)
{
    return resume_blocker(owner, handle);
}

} // namespace noveltea::core
