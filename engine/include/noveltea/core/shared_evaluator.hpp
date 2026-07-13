#pragma once

#include "noveltea/core/flow_executor.hpp"

#include <chrono>
#include <string>
#include <string_view>
#include <variant>

namespace noveltea::core {

struct WaitCompleted {};
struct WaitBlocked {
    FlowBlocker blocker;
};
using WaitEvaluation = std::variant<WaitCompleted, WaitBlocked>;

// SharedPrimitiveEvaluator is the JSON-free execution boundary for primitives used by all typed
// feature programs. Lua variants are rejected here until the script-aware Phase 6D boundary is
// supplied; they are never interpreted or silently skipped.
class SharedPrimitiveEvaluator {
public:
    SharedPrimitiveEvaluator(const CompiledProject& project, SessionState& state,
                             FlowExecutor& executor) noexcept
        : m_project(project), m_state(state), m_executor(executor)
    {
    }

    [[nodiscard]] Result<bool, Diagnostics> evaluate(const Condition& condition) const;
    [[nodiscard]] Result<void, Diagnostics> apply(const Effect& effect);
    [[nodiscard]] Result<std::string, Diagnostics> resolve(const TextSource& source,
                                                           std::string_view runtime_locale) const;

    [[nodiscard]] Result<WaitEvaluation, Diagnostics> begin(const WaitSpec& wait);
    [[nodiscard]] Result<void, Diagnostics> complete(const FlowFrameId& owner,
                                                     const AnyFlowBlockerHandle& handle);
    [[nodiscard]] Result<void, Diagnostics> cancel(const FlowFrameId& owner,
                                                   const AnyFlowBlockerHandle& handle);
    [[nodiscard]] Result<bool, Diagnostics> advance(const FlowFrameId& owner,
                                                    const DurationFlowBlockerHandle& handle,
                                                    std::chrono::milliseconds elapsed);

private:
    const CompiledProject& m_project;
    SessionState& m_state;
    FlowExecutor& m_executor;
};

} // namespace noveltea::core
