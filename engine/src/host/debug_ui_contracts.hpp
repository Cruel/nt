#pragma once

#include "host/host_lifecycle_contracts.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/surface.hpp"

#include <compare>
#include <optional>
#include <span>
#include <string_view>
#include <variant>
#include <vector>

namespace noveltea::host {

struct DebugUiObservationSnapshot {
    SurfaceMetrics surface;
    std::string_view platform_name;
    std::string_view renderer_name;
    std::optional<HostGeneration> host_generation;
    bool runtime_loaded = false;
    bool gameplay_paused = false;
    bool render_perf_logging = false;
    std::span<const core::RuntimeObservation> runtime_observations;
    std::span<const runtime::RuntimeEvent> runtime_events;
    std::span<const core::Diagnostic> runtime_diagnostics;
};

struct SetRenderPerfLoggingDebugCommand {
    bool enabled = false;
    auto operator<=>(const SetRenderPerfLoggingDebugCommand&) const = default;
};

struct SetGameplayPausedDebugCommand {
    bool paused = false;
    auto operator<=>(const SetGameplayPausedDebugCommand&) const = default;
};

using DebugUiCommand =
    std::variant<SetRenderPerfLoggingDebugCommand, SetGameplayPausedDebugCommand>;

struct DebugUiFrameOutput {
    std::vector<DebugUiCommand> commands;
};

} // namespace noveltea::host
