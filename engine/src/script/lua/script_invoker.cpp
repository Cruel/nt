#include "noveltea/script/script_invoker.hpp"

#include "noveltea/core/flow_executor.hpp"
#include "noveltea/script/script_runtime.hpp"

#include <string>

namespace noveltea::script {
namespace {

ScriptError blocker_error(const core::Diagnostics& diagnostics, std::string operation)
{
    const std::string message =
        diagnostics.empty() ? "Script invocation blocker is invalid" : diagnostics.front().message;
    return ScriptError{ScriptErrorCode::StaleInvocation, message, std::move(operation), message};
}

} // namespace

core::Result<void, ScriptError> ScriptInvoker::run_startup(const core::compiled::StartupHook& hook)
{
    return m_runtime.execute(hook.source, "startup-hook");
}

core::Result<bool, ScriptError> ScriptInvoker::evaluate(const core::LuaPredicate& predicate)
{
    return m_runtime.evaluate_bool(predicate.source, "lua-condition");
}

core::Result<std::string, ScriptError>
ScriptInvoker::resolve(const core::LuaTextExpression& expression)
{
    return m_runtime.evaluate_string(expression.source, "lua-text-expression");
}

core::Result<ScriptInvocationOutcome, ScriptError>
ScriptInvoker::invoke(const core::RunLuaEffect& effect, std::string_view chunk_name)
{
    return invoke(effect.source, chunk_name);
}

core::Result<ScriptInvocationOutcome, ScriptError>
ScriptInvoker::invoke(std::string_view source, std::string_view chunk_name)
{
    using Result = core::Result<ScriptInvocationOutcome, ScriptError>;
    auto allocated = m_executor.block_top(core::FlowBlockerKind::Script);
    const auto* blocker = allocated.value_if();
    if (blocker == nullptr)
        return Result::failure(blocker_error(allocated.error(), std::string(chunk_name)));
    const auto* script_blocker = std::get_if<core::ScriptFlowBlocker>(blocker);
    if (script_blocker == nullptr) {
        return Result::failure(ScriptError{ScriptErrorCode::StaleInvocation,
                                           "FlowExecutor allocated a non-script blocker",
                                           std::string(chunk_name),
                                           {}});
    }

    auto invoked = m_runtime.begin_invocation(source, chunk_name, script_blocker->owner,
                                              script_blocker->handle);
    if (!invoked) {
        (void)m_executor.cancel_blocker(script_blocker->owner, script_blocker->handle);
        return Result::failure(invoked.error());
    }
    const auto* outcome = invoked.value_if();
    if (outcome != nullptr && std::holds_alternative<ScriptInvocationCompleted>(*outcome)) {
        auto completed = m_executor.resume_blocker(script_blocker->owner, script_blocker->handle);
        if (!completed)
            return Result::failure(blocker_error(completed.error(), std::string(chunk_name)));
    }
    return invoked;
}

core::Result<ScriptInvocationOutcome, ScriptError>
ScriptInvoker::resume(const core::FlowFrameId& owner,
                      const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<ScriptInvocationOutcome, ScriptError>;
    auto valid = m_executor.validate_blocker(owner, invocation);
    if (!valid)
        return Result::failure(blocker_error(valid.error(), "resume"));

    auto resumed = m_runtime.resume_invocation(owner, invocation);
    if (!resumed) {
        (void)m_executor.cancel_blocker(owner, invocation);
        return Result::failure(resumed.error());
    }
    const auto* outcome = resumed.value_if();
    if (outcome != nullptr && std::holds_alternative<ScriptInvocationCompleted>(*outcome)) {
        auto completed = m_executor.resume_blocker(owner, invocation);
        if (!completed)
            return Result::failure(blocker_error(completed.error(), "resume"));
    }
    return resumed;
}

core::Result<void, ScriptError>
ScriptInvoker::cancel(const core::FlowFrameId& owner,
                      const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<void, ScriptError>;
    auto valid = m_executor.validate_blocker(owner, invocation);
    if (!valid)
        return Result::failure(blocker_error(valid.error(), "cancel"));
    auto cancelled = m_runtime.cancel_invocation(owner, invocation);
    if (!cancelled)
        return cancelled;
    auto released = m_executor.cancel_blocker(owner, invocation);
    return released ? Result::success()
                    : Result::failure(blocker_error(released.error(), "cancel"));
}

} // namespace noveltea::script
