#pragma once

#include "platform.hpp"
#include "renderer.hpp"
#include "ui_debug.hpp"
#include "ui_runtime.hpp"

namespace noveltea {

class Engine {
public:
    Engine();
    ~Engine();

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    bool initialize(const PlatformConfig& config);
    int run();
    bool tick();
    void shutdown();

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
};

} // namespace noveltea
