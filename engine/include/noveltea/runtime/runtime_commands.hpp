#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/flow.hpp"
#include "noveltea/core/runtime_diagnostic_context.hpp"
#include "noveltea/runtime/runtime_identity.hpp"

#include <compare>
#include <cstdint>
#include <optional>
#include <utility>
#include <variant>

namespace noveltea::runtime {

struct RuntimeCommandSequenceTag;
using RuntimeCommandSequence = RuntimeMonotonicId<RuntimeCommandSequenceTag>;

struct RuntimeSourceContext {
    std::optional<core::FlowFrameId> frame;
    std::optional<core::RuntimeDiagnosticContext> diagnostic;
    bool operator==(const RuntimeSourceContext&) const = default;
};

struct MoveInteractableCommand {
    core::InteractableId interactable;
    core::compiled::InteractableLocation target;
    bool operator==(const MoveInteractableCommand&) const = default;
};

struct NavigateRoomCommand {
    core::compiled::RoomExitRef exit;
    core::RoomId target;
    bool operator==(const NavigateRoomCommand&) const = default;
};

struct StartTransientSceneCommand {
    core::SceneId scene;
    auto operator<=>(const StartTransientSceneCommand&) const = default;
};

struct StartTransientDialogueCommand {
    core::DialogueId dialogue;
    auto operator<=>(const StartTransientDialogueCommand&) const = default;
};

struct CallChildSceneCommand {
    core::SceneId scene;
    auto operator<=>(const CallChildSceneCommand&) const = default;
};

struct CallChildDialogueCommand {
    core::DialogueId dialogue;
    std::optional<core::DialogueBlockId> start_block;
    auto operator<=>(const CallChildDialogueCommand&) const = default;
};

struct TailReplaceFlowCommand {
    core::FlowTarget target;
    bool operator==(const TailReplaceFlowCommand&) const = default;
};

struct RequestAutosaveCommand {
    auto operator<=>(const RequestAutosaveCommand&) const = default;
};

using DeferredRuntimeCommandPayload =
    std::variant<MoveInteractableCommand, NavigateRoomCommand, StartTransientSceneCommand,
                 StartTransientDialogueCommand, CallChildSceneCommand, CallChildDialogueCommand,
                 TailReplaceFlowCommand, RequestAutosaveCommand>;

struct DeferredRuntimeCommand {
    RuntimeCommandSequence sequence;
    RuntimeSourceContext source;
    DeferredRuntimeCommandPayload payload;
    bool operator==(const DeferredRuntimeCommand&) const = default;
};

enum class RuntimeCancellationReason : std::uint8_t {
    RuntimeStop,
    RuntimeReset,
    CheckpointLoad,
    ProjectReload,
    RunningGameDestroyed
};

struct ExternalRequestIdTag;
using ExternalRequestId = RuntimeMonotonicId<ExternalRequestIdTag>;

enum class ExternalRequestCheckpointPolicy : std::uint8_t {
    Barrier,
    NonBlocking
};

enum class ExternalRequestState : std::uint8_t {
    Pending,
    Succeeded,
    Failed,
    Cancelled
};

class ExternalRequestLifecycle {
public:
    ExternalRequestLifecycle(ExternalRequestId id, RuntimeSourceContext source,
                             ExternalRequestCheckpointPolicy checkpoint_policy) noexcept
        : m_id(id), m_source(std::move(source)), m_checkpoint_policy(checkpoint_policy)
    {
    }

    [[nodiscard]] ExternalRequestId id() const noexcept { return m_id; }
    [[nodiscard]] const RuntimeSourceContext& source() const noexcept { return m_source; }
    [[nodiscard]] ExternalRequestCheckpointPolicy checkpoint_policy() const noexcept
    {
        return m_checkpoint_policy;
    }
    [[nodiscard]] ExternalRequestState state() const noexcept { return m_state; }
    [[nodiscard]] std::optional<RuntimeCancellationReason> cancellation_reason() const noexcept
    {
        return m_cancellation_reason;
    }
    [[nodiscard]] bool is_terminal() const noexcept
    {
        return m_state != ExternalRequestState::Pending;
    }

    [[nodiscard]] bool succeed() noexcept { return complete(ExternalRequestState::Succeeded); }
    [[nodiscard]] bool fail() noexcept { return complete(ExternalRequestState::Failed); }
    [[nodiscard]] bool cancel(RuntimeCancellationReason reason) noexcept
    {
        if (!complete(ExternalRequestState::Cancelled)) {
            return false;
        }
        m_cancellation_reason = reason;
        return true;
    }

private:
    [[nodiscard]] bool complete(ExternalRequestState state) noexcept
    {
        if (is_terminal() || state == ExternalRequestState::Pending) {
            return false;
        }
        m_state = state;
        return true;
    }

    ExternalRequestId m_id;
    RuntimeSourceContext m_source;
    ExternalRequestCheckpointPolicy m_checkpoint_policy;
    ExternalRequestState m_state = ExternalRequestState::Pending;
    std::optional<RuntimeCancellationReason> m_cancellation_reason;
};

} // namespace noveltea::runtime
