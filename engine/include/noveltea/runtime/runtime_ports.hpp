#pragma once

#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/wait.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_commands.hpp"

#include <compare>
#include <optional>
#include <string>
#include <string_view>
#include <variant>

namespace noveltea::runtime {

enum class ScriptInvocationResultKind : std::uint8_t {
    None,
    Boolean,
    String
};

struct ScriptInvocationRequest {
    std::string source;
    std::string chunk_name;
    std::optional<core::FlowFrameId> owner;
    std::optional<core::ScriptInvocationHandle> invocation;
    RuntimeSourceContext source_context;
    ScriptInvocationResultKind result_kind = ScriptInvocationResultKind::None;
    bool operator==(const ScriptInvocationRequest&) const = default;
};

using ScriptInvocationValue = std::variant<std::monostate, bool, std::string>;

struct ScriptInvocationCompleted {
    ScriptInvocationValue value = std::monostate{};
    bool operator==(const ScriptInvocationCompleted&) const = default;
};

struct ScriptInvocationSuspended {
    core::FlowFrameId owner;
    core::ScriptInvocationHandle invocation;
    bool operator==(const ScriptInvocationSuspended&) const = default;
};

using ScriptInvocationOutcome = std::variant<ScriptInvocationCompleted, ScriptInvocationSuspended>;

enum class ScriptInvocationErrorCode : std::uint8_t {
    NotInitialized,
    LoadFailed,
    RuntimeFailed,
    InvalidResult,
    YieldForbidden,
    StaleInvocation
};

struct ScriptInvocationError {
    ScriptInvocationErrorCode code = ScriptInvocationErrorCode::RuntimeFailed;
    std::string message;
    std::string chunk;
    std::string traceback;
    bool operator==(const ScriptInvocationError&) const = default;
};

enum class ScriptCancellationReason : std::uint8_t {
    OwnerEnded,
    RuntimeStop,
    RuntimeReset,
    CheckpointLoad,
    ProjectReload,
    RunningGameDestroyed
};

class ScriptInvocationPort {
public:
    virtual ~ScriptInvocationPort() = default;

    [[nodiscard]] virtual core::Result<ScriptInvocationOutcome, ScriptInvocationError>
    invoke(const ScriptInvocationRequest& request, const RuntimeCapabilitySet& capabilities) = 0;
    [[nodiscard]] virtual core::Result<ScriptInvocationOutcome, ScriptInvocationError>
    resume(const core::ScriptInvocationHandle& invocation,
           const RuntimeCapabilitySet& capabilities) = 0;
    virtual void cancel(const core::ScriptInvocationHandle& invocation,
                        ScriptCancellationReason reason) = 0;
    virtual void invalidate_capabilities(CapabilityGeneration generation) noexcept = 0;
};

struct PresentationAcceptance {
    bool accepted = false;
    auto operator<=>(const PresentationAcceptance&) const = default;
};

class PresentationRuntimePort {
public:
    virtual ~PresentationRuntimePort() = default;

    [[nodiscard]] virtual core::Result<PresentationAcceptance, core::Diagnostics>
    accept(const core::PresentationOperation& operation) = 0;
    [[nodiscard]] virtual core::Result<PresentationAcceptance, core::Diagnostics>
    accept(const core::AudioOperation& operation) = 0;
    [[nodiscard]] virtual const core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept = 0;
    virtual void terminate(core::PresentationCancellationReason reason) = 0;
};

class ExternalRequestSink {
public:
    virtual ~ExternalRequestSink() = default;
    virtual void cancel_all(RuntimeCancellationReason reason) = 0;
};

} // namespace noveltea::runtime
