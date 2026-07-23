#pragma once

#include "noveltea/audio/audio_backend.hpp"
#include "noveltea/engine.hpp"

#include <cstdint>
#include <string>

namespace noveltea {

class RuntimePreviewController;
class Renderer;

namespace assets {
class AssetManager;
}

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
    [[nodiscard]] static bool request_screenshot(Engine& engine, std::string path);
    static void set_preview_running(Engine& engine, bool running);
    static void set_show_fps_counter(Engine& engine, bool show);
    static void set_fps_cap(Engine& engine, uint32_t frames_per_second);
    [[nodiscard]] static bool set_runtime_ui_scale(Engine& engine, double scale);
    [[nodiscard]] static RuntimePreviewController& preview(Engine& engine) noexcept;
    [[nodiscard]] static const RuntimePreviewController& preview(const Engine& engine) noexcept;
    [[nodiscard]] static bool preview_running(const Engine& engine) noexcept;
    [[nodiscard]] static Renderer& renderer(Engine& engine) noexcept;
    [[nodiscard]] static assets::AssetManager& assets(Engine& engine) noexcept;
    [[nodiscard]] static AudioBackendInfo audio_backend_info(const Engine& engine) noexcept;
    [[nodiscard]] static AudioBackendStats audio_backend_stats(const Engine& engine) noexcept;
};

} // namespace noveltea
