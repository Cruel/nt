#pragma once

#include "noveltea/surface.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>

namespace noveltea {

struct PlatformConfig;
class RuntimePreviewController;

namespace sandbox {
class SandboxDemoHarness;
}

namespace core {
class TypedSaveSlotStore;
}

struct EngineRunConfig {
    uint32_t frame_limit = 0;
    uint32_t fps_cap = 0;
    double fixed_delta_seconds = 0.0;
    std::filesystem::path system_asset_root;
    std::filesystem::path project_asset_root;
    std::filesystem::path cache_asset_root;
    std::string runtime_ui_document;
    std::string compiled_project;
    bool load_title_screen = true;
    bool keep_runtime_running = false;
    bool enable_debug_ui = true;
    bool preview_widget = false;
    bool render_perf_logging = false;
    bool rmlui_base_direct_compat = false;
    bool enable_audio = true;
    bool show_fps_counter = false;
    core::TypedSaveSlotStore* save_slot_store = nullptr;
};

class Engine final {
public:
    Engine();
    ~Engine();

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    bool initialize(const PlatformConfig& config, const EngineRunConfig& run_config = {});
    int run();
    bool tick();
    void resize(const SurfaceMetrics& surface);
    void resize_host(const SurfaceMetrics& surface);
    const PresentationMetrics& presentation() const;
    void shutdown();
    void request_stop();
    [[nodiscard]] bool request_screenshot(std::string path);
    void set_preview_running(bool running);
    void set_show_fps_counter(bool show);
    void set_fps_cap(uint32_t frames_per_second);
    bool show_fps_counter() const;
    uint32_t fps_cap() const;
    RuntimePreviewController& runtime_preview() noexcept;
    const RuntimePreviewController& runtime_preview() const noexcept;
    bool preview_running() const;
    bool is_running() const;

private:
    friend class sandbox::SandboxDemoHarness;
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea
