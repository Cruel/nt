#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/runtime/runtime_identity.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>
#include <variant>

namespace noveltea::host {

struct HostGenerationTag;
using HostGeneration = runtime::RuntimeMonotonicId<HostGenerationTag>;

struct BackendGenerationTag;
using BackendGeneration = runtime::RuntimeMonotonicId<BackendGenerationTag>;

enum class HostLifecycleState : std::uint8_t {
    Uninitialized,
    Initializing,
    Ready,
    Running,
    Suspended,
    Stopping,
    ShuttingDown,
    Shutdown,
    Failed,
};

enum class HostShutdownReason : std::uint8_t {
    ExplicitRequest,
    PlatformQuit,
    FrameLimitReached,
    InitializationFailed,
    RuntimeFailure,
    BackendFailure,
    HostDestroyed,
};

struct HostLifecycleStatus {
    HostLifecycleState state = HostLifecycleState::Uninitialized;
    std::optional<HostShutdownReason> shutdown_reason;

    [[nodiscard]] bool initialized() const noexcept
    {
        return state != HostLifecycleState::Uninitialized &&
               state != HostLifecycleState::Initializing && state != HostLifecycleState::Failed &&
               state != HostLifecycleState::Shutdown;
    }

    [[nodiscard]] bool terminal() const noexcept
    {
        return state == HostLifecycleState::Shutdown || state == HostLifecycleState::Failed;
    }

    auto operator<=>(const HostLifecycleStatus&) const = default;
};

enum class HostBackendDomain : std::uint8_t {
    Renderer,
    RuntimeUi,
    Audio,
    WorldPresentation,
};

enum class BackendResetPhase : std::uint8_t {
    BeforeReset,
    AfterReset,
};

enum class BackendResetReason : std::uint8_t {
    SurfaceRecreated,
    DeviceLost,
    HostResume,
    ExplicitRequest,
};

enum class BackendReloadReason : std::uint8_t {
    ProjectReload,
    AssetsChanged,
    DocumentsAndStylesChanged,
    ExplicitRequest,
};

struct BackendResetNotification {
    HostBackendDomain domain;
    BackendGeneration generation;
    BackendResetPhase phase;
    BackendResetReason reason;

    auto operator<=>(const BackendResetNotification&) const = default;
};

struct BackendReloadNotification {
    HostBackendDomain domain;
    BackendGeneration generation;
    BackendReloadReason reason;

    auto operator<=>(const BackendReloadNotification&) const = default;
};

using HostBackendNotification = std::variant<BackendResetNotification, BackendReloadNotification>;

class HostBackendNotificationSink {
public:
    virtual ~HostBackendNotificationSink() = default;

    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    notify_backend(const HostBackendNotification& notification) = 0;
};

enum class HostFrameStage : std::uint8_t {
    BeginFrame = 0,
    PollPlatformEvents,
    RouteInput,
    UpdateClocks,
    AdvanceRuntime,
    UpdatePresentation,
    RealizeLayouts,
    UpdateRuntimeUi,
    BeginRender,
    RenderWorld,
    RenderRuntimeUi,
    RenderDevtools,
    ProcessCaptures,
    Present,
    PaceFrame,
    Count,
};

[[nodiscard]] constexpr std::size_t frame_stage_index(HostFrameStage stage) noexcept
{
    return static_cast<std::size_t>(stage);
}

[[nodiscard]] constexpr std::string_view to_string(HostFrameStage stage) noexcept
{
    switch (stage) {
    case HostFrameStage::BeginFrame:
        return "begin-frame";
    case HostFrameStage::PollPlatformEvents:
        return "poll-platform-events";
    case HostFrameStage::RouteInput:
        return "route-input";
    case HostFrameStage::UpdateClocks:
        return "update-clocks";
    case HostFrameStage::AdvanceRuntime:
        return "advance-runtime";
    case HostFrameStage::UpdatePresentation:
        return "update-presentation";
    case HostFrameStage::RealizeLayouts:
        return "realize-layouts";
    case HostFrameStage::UpdateRuntimeUi:
        return "update-runtime-ui";
    case HostFrameStage::BeginRender:
        return "begin-render";
    case HostFrameStage::RenderWorld:
        return "render-world";
    case HostFrameStage::RenderRuntimeUi:
        return "render-runtime-ui";
    case HostFrameStage::RenderDevtools:
        return "render-devtools";
    case HostFrameStage::ProcessCaptures:
        return "process-captures";
    case HostFrameStage::Present:
        return "present";
    case HostFrameStage::PaceFrame:
        return "pace-frame";
    case HostFrameStage::Count:
        break;
    }
    return "unknown";
}

} // namespace noveltea::host
