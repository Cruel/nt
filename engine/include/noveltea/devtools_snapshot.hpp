#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/surface.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::devtools {

struct RuntimeDebugSnapshot {
    runtime::RuntimePublication publication;
    core::Diagnostics diagnostics;
    bool preview_running = false;
};

struct DevtoolsHostSnapshot {
    HostSurfaceMetrics surface{};
    std::string platform;
    std::string renderer;
    std::optional<std::uint64_t> host_generation;
};

struct DevtoolsInputSnapshot {
    Vec2 reference_pointer{};
    bool pointer_valid = false;
    std::string last_event;
    bool debug_processed = false;
    bool debug_consumed = false;
    bool runtime_ui_processed = false;
    bool runtime_ui_consumed = false;
    bool runtime_ui_wants_pointer = false;
    bool gameplay_event = false;
    bool gameplay_admitted = false;
    std::string gameplay_block_reason = "none";
    std::optional<std::string> governing_layout;
    std::string governing_layout_mode = "none";
};

struct DevtoolsRmlUiElementSnapshot {
    std::string tag;
    std::string id;
    std::string classes;
    std::string pointer_events;
};

struct DevtoolsRmlUiContextSnapshot {
    std::string name;
    std::int32_t width = 0;
    std::int32_t height = 0;
    bool mouse_interacting = false;
    std::optional<DevtoolsRmlUiElementSnapshot> hover;
    std::optional<DevtoolsRmlUiElementSnapshot> focus;
};

struct RmlUiDebuggerSnapshot {
    bool available = false;
    bool visible = false;
    std::string context;
};

struct RmlUiDebuggerCommand {
    bool visible = false;
    std::string context;
};

struct DevtoolsWorldHotspotSnapshot {
    std::string identity;
    std::string label;
    bool condition_eligible = false;
    bool target_available = false;
    std::string target;
    std::string highlight;
    std::optional<std::string> cursor;
    bool under_pointer = false;
    bool hovered = false;
    bool pressed = false;
};

struct DevtoolsWorldSnapshot {
    Vec2 reference_pointer{};
    bool pointer_valid = false;
    bool capture_active = false;
    std::optional<std::string> under_pointer;
    std::optional<std::string> hovered;
    std::optional<std::string> pressed;
    std::vector<DevtoolsWorldHotspotSnapshot> hotspots;
};

struct DevtoolsToolingSnapshot {
    bool preview_running = false;
    bool render_perf_logging = false;
    bool native_debug_ui_available = false;
    bool native_debug_ui_enabled = false;
};

struct DevtoolsSnapshot {
    DevtoolsHostSnapshot host;
    DevtoolsInputSnapshot input;
    std::vector<DevtoolsRmlUiContextSnapshot> rmlui;
    RmlUiDebuggerSnapshot rmlui_debugger;
    DevtoolsWorldSnapshot world;
    DevtoolsToolingSnapshot tooling;
    std::optional<RuntimeDebugSnapshot> runtime;
};

} // namespace noveltea::devtools
