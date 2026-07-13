#pragma once

#include "noveltea/core/flow.hpp"

#include <string>
#include <variant>

namespace noveltea::script {

enum class ScriptErrorCode {
    NotInitialized,
    LoadFailed,
    RuntimeFailed,
    InvalidResult,
    YieldForbidden,
    StaleInvocation
};

struct ScriptError {
    ScriptErrorCode code = ScriptErrorCode::RuntimeFailed;
    std::string message;
    std::string chunk;
    std::string traceback;
};

struct ScriptInvocationCompleted {};
struct ScriptInvocationSuspended {
    core::FlowFrameId owner;
    core::ScriptInvocationHandle invocation;
};
using ScriptInvocationOutcome = std::variant<ScriptInvocationCompleted, ScriptInvocationSuspended>;

} // namespace noveltea::script
