#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/script/script_result.hpp"

#include <string_view>

namespace noveltea::core {
class FlowExecutor;
}

namespace noveltea::script {

class ScriptRuntime;

// Coordinates opaque Lua coroutine ownership with the session-owned Script blocker. It does not
// execute feature frames or expose Lua host services; those remain in their owning later slices.
class ScriptInvoker {
public:
    ScriptInvoker(ScriptRuntime& runtime, core::FlowExecutor& executor) noexcept
        : m_runtime(runtime), m_executor(executor)
    {
    }

    [[nodiscard]] core::Result<void, ScriptError>
    run_startup(const core::compiled::StartupHook& hook);
    [[nodiscard]] core::Result<bool, ScriptError> evaluate(const core::LuaPredicate& predicate);
    [[nodiscard]] core::Result<std::string, ScriptError>
    resolve(const core::LuaTextExpression& expression);
    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptError>
    invoke(const core::RunLuaEffect& effect, std::string_view chunk_name = "lua-effect");
    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptError>
    invoke(std::string_view source, std::string_view chunk_name = "script");
    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptError>
    resume(const core::FlowFrameId& owner, const core::ScriptInvocationHandle& invocation);
    [[nodiscard]] core::Result<void, ScriptError>
    cancel(const core::FlowFrameId& owner, const core::ScriptInvocationHandle& invocation);

private:
    ScriptRuntime& m_runtime;
    core::FlowExecutor& m_executor;
};

} // namespace noveltea::script
