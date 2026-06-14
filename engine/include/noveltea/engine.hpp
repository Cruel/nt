#pragma once

#include "platform.hpp"
#include "renderer.hpp"
#include "ui_debug.hpp"
#include "ui_runtime.hpp"

#include <cstdint>
#include <string>

namespace noveltea {

enum class DemoMode {
    All,
    Render2D,
    RmlUi,
    Text,
};

struct EngineRunConfig {
    uint32_t frame_limit = 0;
    DemoMode demo_mode = DemoMode::All;
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

    bool is_running() const { return m_running; }

private:
    void handle_events();
    void update(float dt);
    void render();

    Platform m_platform;
    Renderer m_renderer;
    RuntimeUI m_runtime_ui;
    DebugUI m_debug_ui;
    bool m_initialized = false;
    bool m_running = false;
    uint32_t m_frame_count = 0;
    uint32_t m_frame_limit = 0;
    DemoMode m_demo_mode = DemoMode::All;
    float m_elapsed_seconds = 0.0f;
};

} // namespace noveltea
