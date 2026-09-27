#pragma once

#include "noveltea/core/diagnostic.hpp"

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
};

} // namespace noveltea::host
