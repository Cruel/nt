#include "noveltea/script/typed_execution_kernel.hpp"

#include "noveltea/script/script_runtime.hpp"

#include <type_traits>
#include <utility>

namespace noveltea::script {

TypedExecutionKernel::TypedExecutionKernel(const core::CompiledProject& project,
                                           ScriptRuntime& runtime,
                                           core::SessionState state) noexcept
    : m_project(project), m_state(std::move(state)), m_flow(m_project, m_state),
      m_primitives(m_project, m_state, m_flow), m_host(m_project, m_state),
      m_scripts(runtime, m_flow, m_host)
{
}

core::Result<std::unique_ptr<TypedExecutionKernel>, core::Diagnostics>
TypedExecutionKernel::create(const core::CompiledProject& project, ScriptRuntime& runtime)
{
    auto state = core::SessionState::create(project);
    auto* value = state.value_if();
    if (value == nullptr)
        return core::Result<std::unique_ptr<TypedExecutionKernel>, core::Diagnostics>::failure(
            state.error());
    return core::Result<std::unique_ptr<TypedExecutionKernel>, core::Diagnostics>::success(
        std::unique_ptr<TypedExecutionKernel>(
            new TypedExecutionKernel(project, runtime, std::move(*value))));
}

core::Result<bool, TypedExecutionError>
TypedExecutionKernel::evaluate(const core::Condition& condition)
{
    if (const auto* lua = std::get_if<core::LuaPredicate>(&condition)) {
        auto result = m_scripts.evaluate(*lua);
        const auto* value = result.value_if();
        return value ? core::Result<bool, TypedExecutionError>::success(*value)
                     : core::Result<bool, TypedExecutionError>::failure(result.error());
    }
    auto result = m_primitives.evaluate(condition);
    const auto* value = result.value_if();
    return value ? core::Result<bool, TypedExecutionError>::success(*value)
                 : core::Result<bool, TypedExecutionError>::failure(result.error());
}

core::Result<TypedEffectOutcome, TypedExecutionError>
TypedExecutionKernel::apply(const core::Effect& effect, std::string_view chunk_name)
{
    if (const auto* lua = std::get_if<core::RunLuaEffect>(&effect)) {
        auto result = m_scripts.invoke(*lua, chunk_name);
        const auto* outcome = result.value_if();
        if (outcome == nullptr)
            return core::Result<TypedEffectOutcome, TypedExecutionError>::failure(result.error());
        return std::visit(
            [](const auto& value) -> core::Result<TypedEffectOutcome, TypedExecutionError> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, ScriptInvocationCompleted>)
                    return core::Result<TypedEffectOutcome, TypedExecutionError>::success(
                        core::WaitCompleted{});
                else
                    return core::Result<TypedEffectOutcome, TypedExecutionError>::success(value);
            },
            *outcome);
    }
    auto result = m_primitives.apply(effect);
    if (!result)
        return core::Result<TypedEffectOutcome, TypedExecutionError>::failure(result.error());
    return core::Result<TypedEffectOutcome, TypedExecutionError>::success(core::WaitCompleted{});
}

core::Result<std::string, TypedExecutionError>
TypedExecutionKernel::resolve(const core::TextSource& source, std::string_view runtime_locale)
{
    if (const auto* lua = std::get_if<core::LuaTextExpression>(&source)) {
        auto result = m_scripts.resolve(*lua);
        const auto* value = result.value_if();
        return value ? core::Result<std::string, TypedExecutionError>::success(*value)
                     : core::Result<std::string, TypedExecutionError>::failure(result.error());
    }
    auto result = m_primitives.resolve(source, runtime_locale);
    const auto* value = result.value_if();
    return value ? core::Result<std::string, TypedExecutionError>::success(*value)
                 : core::Result<std::string, TypedExecutionError>::failure(result.error());
}

core::Result<core::WaitEvaluation, core::Diagnostics>
TypedExecutionKernel::begin(const core::WaitSpec& wait)
{
    return m_primitives.begin(wait);
}

core::Result<void, core::Diagnostics>
TypedExecutionKernel::complete(const core::FlowFrameId& owner,
                               const core::AnyFlowBlockerHandle& handle)
{
    return m_primitives.complete(owner, handle);
}

core::Result<void, core::Diagnostics>
TypedExecutionKernel::cancel(const core::FlowFrameId& owner,
                             const core::AnyFlowBlockerHandle& handle)
{
    return m_primitives.cancel(owner, handle);
}

core::Result<bool, core::Diagnostics>
TypedExecutionKernel::advance(const core::FlowFrameId& owner,
                              const core::DurationFlowBlockerHandle& handle,
                              std::chrono::milliseconds elapsed)
{
    return m_primitives.advance(owner, handle, elapsed);
}

core::Result<ScriptInvocationOutcome, ScriptError>
TypedExecutionKernel::resume_script(const core::FlowFrameId& owner,
                                    const core::ScriptInvocationHandle& invocation)
{
    return m_scripts.resume(owner, invocation);
}

core::Result<void, ScriptError>
TypedExecutionKernel::cancel_script(const core::FlowFrameId& owner,
                                    const core::ScriptInvocationHandle& invocation)
{
    return m_scripts.cancel(owner, invocation);
}

} // namespace noveltea::script
