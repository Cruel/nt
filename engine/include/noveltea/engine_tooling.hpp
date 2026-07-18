#pragma once

#include "noveltea/engine.hpp"

#include <cstdint>
#include <string>

namespace noveltea {

struct EngineToolingConfig {
    uint32_t frame_limit = 0;
    uint32_t fps_cap = 0;
    double fixed_delta_seconds = 0.0;
    std::string runtime_ui_document;
    bool keep_runtime_running = false;
    bool enable_debug_ui = false;
    bool preview_widget = false;
    bool render_perf_logging = false;
    bool rmlui_base_direct_compat = false;
    bool show_fps_counter = false;
};

class EngineTooling final {
public:
    [[nodiscard]] static bool initialize(Engine& engine, const PlatformConfig& platform_config,
                                         const EngineConfig& engine_config,
                                         const EngineToolingConfig& tooling_config = {});
};

} // namespace noveltea
