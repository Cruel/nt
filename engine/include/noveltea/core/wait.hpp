#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"

#include <chrono>
#include <compare>
#include <cstdint>
#include <variant>

namespace noveltea::core {

class FlowExecutor;

// WaitSpec is immutable compiled intent. Runtime handles exist only in ActiveWait.
struct ImmediateWait {};
struct InputWait {};
class DurationWait {
public:
    DurationWait() = delete;
    [[nodiscard]] static Result<DurationWait, Diagnostics>
    create(std::chrono::milliseconds duration)
    {
        if (duration.count() < 0)
            return Result<DurationWait, Diagnostics>::failure(Diagnostics{Diagnostic{
                .code = "domain.invalid_wait", .message = "Wait duration cannot be negative"}});
        return Result<DurationWait, Diagnostics>::success(DurationWait(duration));
    }
    [[nodiscard]] std::chrono::milliseconds duration() const noexcept { return m_duration; }

private:
    explicit DurationWait(std::chrono::milliseconds duration) : m_duration(duration) {}
    std::chrono::milliseconds m_duration;
};
struct PresentationCompletionWait {};
struct AudioCompletionWait {};
struct ChildFlowCompletionWait {};
struct ScriptCompletionWait {};
using WaitSpec = std::variant<ImmediateWait, InputWait, DurationWait, PresentationCompletionWait,
                              AudioCompletionWait, ChildFlowCompletionWait, ScriptCompletionWait>;

template<class Tag> class CorrelationHandle {
public:
    CorrelationHandle() = delete;
    [[nodiscard]] static Result<CorrelationHandle, Diagnostics> create(std::uint64_t value)
    {
        if (value == 0)
            return Result<CorrelationHandle, Diagnostics>::failure(
                Diagnostics{Diagnostic{.code = "domain.invalid_correlation",
                                       .message = "Correlation handle cannot be zero"}});
        return Result<CorrelationHandle, Diagnostics>::success(CorrelationHandle(value));
    }
    [[nodiscard]] std::uint64_t number() const noexcept { return m_value; }
    auto operator<=>(const CorrelationHandle&) const = default;

private:
    friend class FlowExecutor;
    explicit CorrelationHandle(std::uint64_t value) : m_value(value) {}
    std::uint64_t m_value;
};
struct PresentationHandleTag;
struct AudioHandleTag;
struct FlowHandleTag;
struct ScriptInvocationHandleTag;
using PresentationHandle = CorrelationHandle<PresentationHandleTag>;
using AudioHandle = CorrelationHandle<AudioHandleTag>;
using FlowHandle = CorrelationHandle<FlowHandleTag>;
using ScriptInvocationHandle = CorrelationHandle<ScriptInvocationHandleTag>;

struct InputWaitState {};
struct DurationWaitState {
    DurationWait remaining;
};
struct PresentationWaitState {
    PresentationHandle handle;
};
struct AudioWaitState {
    AudioHandle handle;
};
struct ChildFlowWaitState {
    FlowHandle handle;
};
struct ScriptWaitState {
    ScriptInvocationHandle handle;
};
using ActiveWait = std::variant<InputWaitState, DurationWaitState, PresentationWaitState,
                                AudioWaitState, ChildFlowWaitState, ScriptWaitState>;

// Instruction schemas use these aliases instead of unconstrained WaitSpec fields.
using ImmediateInstructionWait = std::variant<ImmediateWait>;
using InputInstructionWait = std::variant<ImmediateWait, InputWait>;
using DurationInstructionWait = std::variant<ImmediateWait, DurationWait>;
using PresentationInstructionWait = std::variant<ImmediateWait, PresentationCompletionWait>;
using AudioInstructionWait = std::variant<ImmediateWait, AudioCompletionWait>;
using ChildFlowInstructionWait = std::variant<ImmediateWait, ChildFlowCompletionWait>;
using ScriptInstructionWait = std::variant<ImmediateWait, ScriptCompletionWait>;

} // namespace noveltea::core
