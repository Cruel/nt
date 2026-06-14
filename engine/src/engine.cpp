#include "noveltea/engine.hpp"

#include <SDL3/SDL.h>

#include <cstdio>
#include <cstdint>

namespace noveltea {

Engine::Engine() = default;
Engine::~Engine() { shutdown(); }

bool Engine::initialize(const PlatformConfig& config)
{
    SDL_Log("[engine] initializing...");

    if (!m_platform.initialize(config)) {
        std::fprintf(stderr, "[engine] platform init failed\n");
        return false;
    }

    const NativeWindowHandles handles = m_platform.native_window_handles();

    RendererConfig rcfg;
    rcfg.native_display = handles.display;
    rcfg.native_window = handles.window;
    rcfg.width = config.width;
    rcfg.height = config.height;
    rcfg.vsync = config.vsync;

    if (!m_renderer.initialize(rcfg)) {
        std::fprintf(stderr, "[engine] renderer init failed\n");
        m_platform.shutdown();
        return false;
    }

    if (!m_runtime_ui.initialize()) {
        std::fprintf(stderr, "[engine] runtime UI init failed (non-fatal scaffold)\n");
    }

    SDL_Log("[engine] initializing debug UI...");
    if (!m_debug_ui.initialize(m_platform.native_window())) {
        std::fprintf(stderr, "[engine] debug UI init failed (non-fatal)\n");
    } else {
        SDL_Log("[engine] debug UI initialized");
    }

    m_running = true;
    m_initialized = true;
    SDL_Log("[engine] initialized (renderer: %s, %dx%d)",
        m_renderer.renderer_name(),
        m_platform.width(),
        m_platform.height());
    std::printf("[engine] ready\n");

    return true;
}

int Engine::run()
{
    if (!m_running) {
        std::fprintf(stderr, "[engine] run() called but not initialized\n");
        return 1;
    }

    SDL_Log("[engine] entering main loop");

    while (m_running) {
        tick();
    }

    std::printf("[engine] exited main loop\n");
    return 0;
}

bool Engine::tick()
{
    if (!m_running) return false;

    handle_events();
    update(m_platform.delta_time());
    render();

    if (m_platform.should_quit()) {
        m_running = false;
    }

    return m_running;
}

void Engine::handle_events()
{
    m_platform.poll_events();

    for (const SDL_Event& event : m_platform.events()) {
        // SDL event -> devtools -> runtime UI -> game/platform handling.
        m_debug_ui.process_event(event);
        m_runtime_ui.process_event(event);

        switch (event.type) {
            case SDL_EVENT_QUIT:
                m_platform.request_quit();
                break;

            case SDL_EVENT_KEY_DOWN:
                if (event.key.key == SDLK_ESCAPE) {
                    m_platform.request_quit();
                }
                std::printf("[input] key_down: scancode=%d\n", event.key.scancode);
                break;

            case SDL_EVENT_MOUSE_BUTTON_DOWN:
                std::printf("[input] mouse_down: button=%d x=%f y=%f\n",
                    event.button.button, event.button.x, event.button.y);
                break;

            case SDL_EVENT_WINDOW_RESIZED:
            case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
                m_platform.refresh_pixel_size();
                m_renderer.resize(m_platform.width(), m_platform.height());
                m_runtime_ui.resize(m_platform.width(), m_platform.height());
                std::printf("[window] resized: %dx%d\n", m_platform.width(), m_platform.height());
                break;

            default:
                break;
        }
    }
}

void Engine::update(float dt)
{
    (void)dt;
}

void Engine::render()
{
    m_debug_ui.begin_frame(m_renderer.width(), m_renderer.height());
    m_runtime_ui.begin_frame(m_platform.delta_time());
    m_renderer.begin_frame();

    ++m_frame_count;

    // Engine debug text overlay (via renderer abstraction)
    m_renderer.debug_printf(0, 0, 0x0f, "NovelTea Engine");
    m_renderer.debug_printf(0, 1, 0x0f, "Renderer: %s", m_renderer.renderer_name());
    m_renderer.debug_printf(0, 2, 0x0f, "Size: %dx%d", m_platform.width(), m_platform.height());
    m_renderer.debug_printf(0, 3, 0x0f, "dt: %.2f ms", m_platform.delta_time() * 1000.0f);
    m_renderer.debug_printf(0, 4, 0x0f, "Runtime UI: %s", m_runtime_ui.backend_name());

    if (m_frame_count % 60 == 0) {
        SDL_Log("[engine] frame %u", m_frame_count);
    }

    m_runtime_ui.end_frame();
    m_debug_ui.end_frame();
    m_renderer.end_frame();
}

void Engine::shutdown()
{
    if (!m_initialized) return;

    m_running = false;

    m_debug_ui.shutdown();
    m_runtime_ui.shutdown();
    m_renderer.shutdown();
    m_platform.shutdown();

    m_initialized = false;
    std::printf("[engine] shutdown complete\n");
}

} // namespace noveltea
