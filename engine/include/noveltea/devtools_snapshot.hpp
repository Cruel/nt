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
    std::string document_id;
    std::string tag;
    std::string id;
    std::string classes;
    std::string pointer_events;
};

struct DevtoolsRmlUiContextSnapshot {
    std::string name;
    std::string lifecycle_identity;
    std::string plane;
    std::string clock;
    std::string input_mode;
    std::string owner;
    std::string scale_domain;
    std::uint32_t composition_group = 0;
    std::uint32_t compatibility_group = 0;
    std::int32_t width = 0;
    std::int32_t height = 0;
    std::int32_t media_query_width = 0;
    std::int32_t media_query_height = 0;
    float requested_ui_scale = 1.0f;
    float text_scale_factor = 1.0f;
    float reference_to_context_scale_x = 1.0f;
    float reference_to_context_scale_y = 1.0f;
    float ui_raster_scale_x = 1.0f;
    float ui_raster_scale_y = 1.0f;
    float font_raster_scale = 1.0f;
    bool mouse_interacting = false;
    bool recent_event_processed = false;
    bool recent_event_consumed = false;
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
    bool prepared_hit_target = false;
    std::optional<std::uint32_t> hit_test_order;
    std::optional<std::int32_t> input_order;
    std::string hit_shape = "none";
    std::optional<double> hit_shape_x;
    std::optional<double> hit_shape_y;
    std::optional<double> hit_shape_width;
    std::optional<double> hit_shape_height;
    std::optional<float> hit_bounds_x;
    std::optional<float> hit_bounds_y;
    std::optional<float> hit_bounds_width;
    std::optional<float> hit_bounds_height;
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
