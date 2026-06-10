#include "noveltea/engine.hpp"

#include <cstdio>
#include <cstdint>

namespace noveltea {

Engine::Engine() = default;
Engine::~Engine() { shutdown(); }

bool Engine::initialize(const PlatformConfig& config)
{
    std::printf("[engine] initializing...\n");

    if (!m_platform.initialize(config)) {
        std::fprintf(stderr, "[engine] platform init failed\n");
        return false;
    }

    RendererConfig rcfg;
    rcfg.native_window = m_platform.native_window();
    rcfg.width = config.width;
    rcfg.height = config.height;
    rcfg.vsync = config.vsync;

    if (!m_renderer.initialize(rcfg)) {
        std::fprintf(stderr, "[engine] renderer init failed\n");
        m_platform.shutdown();
        return false;
    }

    if (!m_debug_ui.initialize(m_platform.native_window())) {
        std::fprintf(stderr, "[engine] debug UI init failed (non-fatal)\n");
    }

    m_running = true;
    std::printf("[engine] initialized (renderer: %s, %dx%d)\n",
        m_renderer.renderer_name(),
        m_platform.width(),
        m_platform.height());

    return true;
}

int Engine::run()
{
    if (!m_running) {
        std::fprintf(stderr, "[engine] run() called but not initialized\n");
        return 1;
    }

    std::printf("[engine] entering main loop\n");

    while (m_running) {
        handle_events();
        update(m_platform.delta_time());
        render();

        if (m_platform.should_quit()) {
            m_running = false;
        }
    }

    std::printf("[engine] exited main loop\n");
    return 0;
}

void Engine::handle_events()
{
    m_platform.poll_events();
}

void Engine::update(float dt)
{
    (void)dt;
}

void Engine::render()
{
    m_debug_ui.begin_frame();
    m_renderer.begin_frame();

    // Engine debug text overlay (via renderer abstraction)
    m_renderer.debug_printf(0, 0, 0x0f, "NovelTea Engine");
    m_renderer.debug_printf(0, 1, 0x0f, "Renderer: %s", m_renderer.renderer_name());
    m_renderer.debug_printf(0, 2, 0x0f, "Size: %dx%d", m_platform.width(), m_platform.height());
    m_renderer.debug_printf(0, 3, 0x0f, "dt: %.2f ms", m_platform.delta_time() * 1000.0f);

    m_debug_ui.end_frame();
    m_renderer.end_frame();
}

void Engine::shutdown()
{
    if (!m_running) return;
    m_running = false;

    m_debug_ui.shutdown();
    m_renderer.shutdown();
    m_platform.shutdown();

    std::printf("[engine] shutdown complete\n");
}

} // namespace noveltea
