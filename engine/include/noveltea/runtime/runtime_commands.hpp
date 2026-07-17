#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/flow.hpp"
#include "noveltea/core/feature_state.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_diagnostic_context.hpp"
#include "noveltea/runtime/runtime_identity.hpp"

#include <compare>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <limits>
#include <optional>
#include <string>
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

struct SetInteractableWorldStateCommand {
    core::InteractableId interactable;
    std::optional<core::compiled::InteractableLocation> location;
    std::optional<bool> enabled;
    std::optional<bool> visible;
    bool operator==(const SetInteractableWorldStateCommand&) const = default;
};

struct SetCharacterWorldStateCommand {
    core::CharacterId character;
    std::optional<core::CharacterWorldLocation> location;
    std::optional<bool> enabled;
    std::optional<bool> visible;
    bool operator==(const SetCharacterWorldStateCommand&) const = default;
};

struct NavigateRoomCommand {
    core::compiled::RoomExitRef exit;
    core::RoomId target;
    [[nodiscard]] bool operator==(const NavigateRoomCommand& other) const
    {
        return exit.room == other.exit.room && exit.exit_id == other.exit.exit_id &&
               target == other.target;
    }
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

struct UpsertBackgroundOverrideCommand {
    core::DesiredBackgroundOverride value;
    bool operator==(const UpsertBackgroundOverrideCommand&) const = default;
};
struct RemoveBackgroundOverrideCommand {
    core::PresentationOwner owner;
    bool operator==(const RemoveBackgroundOverrideCommand&) const = default;
};
struct UpsertActorPresentationCommand {
    core::DesiredActorPresentation value;
    bool operator==(const UpsertActorPresentationCommand&) const = default;
};
struct RemoveActorPresentationCommand {
    core::ActorPresentationKey key;
    core::PresentationOwner owner;
    bool operator==(const RemoveActorPresentationCommand&) const = default;
};
struct UpsertPresentationPropCommand {
    core::DesiredPresentationProp value;
    bool operator==(const UpsertPresentationPropCommand&) const = default;
};
struct RemovePresentationPropCommand {
    core::PresentationPropInstanceId instance;
    core::PresentationOwner owner;
    bool operator==(const RemovePresentationPropCommand&) const = default;
};
struct UpsertPresentationEnvironmentCommand {
    core::DesiredPresentationEnvironment value;
    bool operator==(const UpsertPresentationEnvironmentCommand&) const = default;
};
struct RemovePresentationEnvironmentCommand {
    core::PresentationEnvironmentInstanceId instance;
    core::PresentationOwner owner;
    bool operator==(const RemovePresentationEnvironmentCommand&) const = default;
};
struct RemovePresentationEnvironmentsByStopKeyCommand {
    core::PresentationEnvironmentStopKey stop_key;
    core::PresentationOwner owner;
    bool operator==(const RemovePresentationEnvironmentsByStopKeyCommand&) const = default;
};
struct UpsertDesiredAudioCommand {
    core::DesiredAudioInstance value;
    bool operator==(const UpsertDesiredAudioCommand&) const = default;
};
struct RemoveDesiredAudioCommand {
    core::DesiredAudioInstanceId instance;
    core::PresentationOwner owner;
    bool operator==(const RemoveDesiredAudioCommand&) const = default;
};
struct RemoveDesiredAudioBusCommand {
    core::compiled::AudioChannel bus;
    core::PresentationOwner owner;
    bool operator==(const RemoveDesiredAudioBusCommand&) const = default;
};
struct UpsertMountedLayoutCommand {
    core::DesiredMountedLayout value;
    bool operator==(const UpsertMountedLayoutCommand&) const = default;
};
struct RemoveMountedLayoutCommand {
    core::MountedLayoutPresentationKey key;
    core::PresentationOwner owner;
    bool operator==(const RemoveMountedLayoutCommand&) const = default;
};
struct SetReservedLayoutCommand {
    core::PresentationOwner owner;
    core::compiled::LayoutSlot slot;
    core::LayoutId layout;
    bool operator==(const SetReservedLayoutCommand&) const = default;
};

using DeferredRuntimeCommandPayload = std::variant<
    MoveInteractableCommand, SetInteractableWorldStateCommand, SetCharacterWorldStateCommand,
    NavigateRoomCommand, StartTransientSceneCommand, StartTransientDialogueCommand,
    CallChildSceneCommand, CallChildDialogueCommand, TailReplaceFlowCommand, RequestAutosaveCommand,
    UpsertBackgroundOverrideCommand, RemoveBackgroundOverrideCommand,
    UpsertActorPresentationCommand, RemoveActorPresentationCommand, UpsertPresentationPropCommand,
    RemovePresentationPropCommand, UpsertPresentationEnvironmentCommand,
    RemovePresentationEnvironmentCommand, RemovePresentationEnvironmentsByStopKeyCommand,
    UpsertDesiredAudioCommand, RemoveDesiredAudioCommand, RemoveDesiredAudioBusCommand,
    UpsertMountedLayoutCommand, RemoveMountedLayoutCommand, SetReservedLayoutCommand>;

struct DeferredRuntimeCommand {
    RuntimeCommandSequence sequence;
    RuntimeSourceContext source;
    DeferredRuntimeCommandPayload payload;
    bool operator==(const DeferredRuntimeCommand&) const = default;
};

struct DeferredRuntimeCommandRequest {
    RuntimeSourceContext source;
    DeferredRuntimeCommandPayload payload;
    bool operator==(const DeferredRuntimeCommandRequest&) const = default;
};

class DeferredRuntimeCommandQueue final {
public:
    [[nodiscard]] core::Result<RuntimeCommandSequence, core::Diagnostics>
    enqueue(DeferredRuntimeCommandRequest request)
    {
        if (m_sequence_exhausted) {
            return core::Result<RuntimeCommandSequence, core::Diagnostics>::failure(
                {core::Diagnostic{.code = "runtime.command_sequence_exhausted",
                                  .message =
                                      "Deferred runtime command identity space is exhausted"}});
        }
        const auto sequence = RuntimeCommandSequence::from_number(m_next_sequence);
        if (!sequence) {
            return core::Result<RuntimeCommandSequence, core::Diagnostics>::failure(
                {core::Diagnostic{.code = "runtime.command_sequence_exhausted",
                                  .message =
                                      "Deferred runtime command identity space is exhausted"}});
        }
        if (m_next_sequence == std::numeric_limits<std::uint64_t>::max()) {
            m_sequence_exhausted = true;
        } else {
            ++m_next_sequence;
        }
        m_commands.push_back(DeferredRuntimeCommand{*sequence, std::move(request.source),
                                                    std::move(request.payload)});
        return core::Result<RuntimeCommandSequence, core::Diagnostics>::success(*sequence);
    }

    [[nodiscard]] std::optional<DeferredRuntimeCommand> pop_front() noexcept
    {
        if (m_commands.empty()) {
            return std::nullopt;
        }
        auto command = std::move(m_commands.front());
        m_commands.pop_front();
        return command;
    }

    [[nodiscard]] bool empty() const noexcept { return m_commands.empty(); }
    [[nodiscard]] std::size_t size() const noexcept { return m_commands.size(); }
    [[nodiscard]] bool sequence_exhausted() const noexcept { return m_sequence_exhausted; }

    void clear() noexcept { m_commands.clear(); }

private:
    std::deque<DeferredRuntimeCommand> m_commands;
    std::uint64_t m_next_sequence = 1;
    bool m_sequence_exhausted = false;
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
