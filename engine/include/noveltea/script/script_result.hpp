#pragma once

#include "noveltea/runtime/runtime_ports.hpp"

namespace noveltea::script {

using ScriptErrorCode = runtime::ScriptInvocationErrorCode;
using ScriptError = runtime::ScriptInvocationError;
using ScriptInvocationCompleted = runtime::ScriptInvocationCompleted;
using ScriptInvocationSuspended = runtime::ScriptInvocationSuspended;
using ScriptInvocationOutcome = runtime::ScriptInvocationOutcome;

} // namespace noveltea::script
