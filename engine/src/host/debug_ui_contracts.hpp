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
    bool clear_console = false;
    bool clear_trace = false;
};

struct DebugUiWindowRect {
    Vec2 position{};
    Vec2 size{};
};

[[nodiscard]] constexpr DebugUiWindowRect debug_ui_reset_rect(Vec2 work_position,
                                                              Vec2 work_size) noexcept
{
    return {.position = work_position, .size = {work_size.x, work_size.y * 0.5f}};
}

} // namespace noveltea::host
