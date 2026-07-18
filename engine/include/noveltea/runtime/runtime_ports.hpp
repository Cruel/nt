#pragma once

#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"
#include "noveltea/core/room_presentation_contracts.hpp"
#include "noveltea/core/wait.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_commands.hpp"

#include <compare>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

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
    std::optional<std::string> asset_path;
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

struct ScriptSourceError {
    std::string message;
    bool operator==(const ScriptSourceError&) const = default;
};

class ScriptSourcePort {
public:
    virtual ~ScriptSourcePort() = default;
    [[nodiscard]] virtual core::Result<std::string, ScriptSourceError>
    read_script_source(std::string_view logical_path) const = 0;
};

class ScriptCertificationPort {
public:
    virtual ~ScriptCertificationPort() = default;
    [[nodiscard]] virtual core::Result<void, ScriptInvocationError>
    certify_source(std::string_view source, std::string_view chunk_name) = 0;
    [[nodiscard]] virtual core::Result<void, ScriptInvocationError>
    certify_asset_source(std::string_view logical_path) = 0;
};

class ScriptRuntimePort : public ScriptInvocationPort, public ScriptCertificationPort {
public:
    ~ScriptRuntimePort() override = default;
};

class PresentationModelPort {
public:
    virtual ~PresentationModelPort() = default;

    [[nodiscard]] virtual core::Result<core::PresentationTargetDraft, core::Diagnostics>
    build_transition_target(
        const core::PresentationTargetDraft& source,
        const std::vector<core::TransitionGroupTargetMutation>& mutations) const = 0;
    [[nodiscard]] virtual core::Result<core::PreparedRoomNavigationTarget, core::Diagnostics>
    prepare_room_navigation(
        const core::CompiledProject& project, const core::SessionState& settled_state,
        const core::RoomNavigationPreparationInput& input,
        core::RoomPresentationConditionEvaluator evaluate,
        core::RoomPresentationTextResolver resolve_text,
        core::RoomCompositionCallback* composition = nullptr) const = 0;
    [[nodiscard]] virtual core::Result<core::RoomPresentationResolution, core::Diagnostics>
    resolve_room(const core::CompiledProject& project, const core::SessionState& state,
                 const core::RoomVisitContext& visit,
                 core::RoomPresentationConditionEvaluator evaluate,
                 core::RoomPresentationTextResolver resolve_text,
                 core::RoomCompositionCallback* composition = nullptr) const = 0;
    [[nodiscard]] virtual core::Result<core::RuntimePresentationSnapshot, core::Diagnostics>
    project(const core::CompiledProject& project, const core::SessionState& state,
            const core::ResolvedRoomPresentation* room_presentation = nullptr) const = 0;
};

struct PresentationAcceptance {
    bool accepted = false;
    auto operator<=>(const PresentationAcceptance&) const = default;
};

class PresentationRuntimePort {
public:
    virtual ~PresentationRuntimePort() = default;

    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    reconcile_snapshot(const core::RuntimePresentationSnapshot& snapshot) = 0;
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
