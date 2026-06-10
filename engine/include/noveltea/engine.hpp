#pragma once

#include "platform.hpp"
#include "renderer.hpp"
#include "ui_debug.hpp"

namespace noveltea {

class Engine {
public:
    Engine();
    ~Engine();

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    bool initialize(const PlatformConfig& config);
    int run();
    void shutdown();

private:
    void handle_events();
    void update(float dt);
    void render();

    Platform m_platform;
    Renderer m_renderer;
    DebugUI m_debug_ui;
    bool m_running = false;
};

} // namespace noveltea
