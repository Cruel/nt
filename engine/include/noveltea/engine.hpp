#pragma once

#include "platform.hpp"
#include "preview_bridge.hpp"
#include "renderer.hpp"
#include "ui_debug.hpp"
#include "ui_runtime.hpp"
#include "noveltea/assets/asset_manager.hpp"

#include <cstdint>
#include <filesystem>
#include <string>

namespace noveltea {

enum class DemoMode {
    None,
    All,
    Render2D,
    RmlUi,
    Text,
};

struct EngineRunConfig {
    uint32_t frame_limit = 0;
    DemoMode demo_mode = DemoMode::All;
    std::filesystem::path system_asset_root;
    std::filesystem::path project_asset_root;
    std::filesystem::path cache_asset_root;
    std::string runtime_ui_document;
    std::string screenshot_path;
    bool enable_debug_ui = true;
};

class Engine {
public:
    Engine();
    ~Engine();

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    bool initialize(const PlatformConfig& config, const EngineRunConfig& run_config = {});
    int run();
    bool tick();
    void shutdown();
    void request_stop();
    void set_demo_position(float normalized_x, float normalized_y);
    void reset_demo_position();
    void set_preview_running(bool running);
    preview_bridge::NormalizedPosition demo_position() const { return m_demo_position; }
    bool preview_running() const { return m_preview_running; }

    bool is_running() const { return m_running; }

private:
    void handle_events();
    void handle_mouse_down(float x, float y, uint8_t button);
    void update(float dt);
    void render();
    void configure_assets(const EngineRunConfig& run_config);

    assets::AssetManager m_assets;
    Platform m_platform;
    Renderer m_renderer;
    RuntimeUI m_runtime_ui;
    DebugUI m_debug_ui;
    bool m_initialized = false;
    bool m_running = false;
    uint32_t m_frame_count = 0;
    uint32_t m_frame_limit = 0;
    std::string m_screenshot_path;
    DemoMode m_demo_mode = DemoMode::All;
    float m_elapsed_seconds = 0.0f;
    preview_bridge::NormalizedPosition m_demo_position{0.5f, 0.5f};
    bool m_preview_running = true;
    bool m_debug_ui_enabled = true;
};

} // namespace noveltea
