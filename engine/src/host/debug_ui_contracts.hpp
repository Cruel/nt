#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/devtools_snapshot.hpp"
#include <optional>

#include <compare>
#include <variant>
#include <vector>

namespace noveltea::host {

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
    std::optional<devtools::RmlUiDebuggerCommand> rmlui_debugger;
};

} // namespace noveltea::host
