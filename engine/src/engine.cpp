#include "noveltea/engine.hpp"

#include "noveltea/math/geometry.hpp"
#include "noveltea/preview_bridge.hpp"
#include "platform/sdl/sdl_platform.hpp"

#include <SDL3/SDL.h>

#include <cstdio>
#include <cstdint>

namespace noveltea {

Engine::Engine() = default;
Engine::~Engine() { shutdown(); }

namespace {

bool demo_enabled(DemoMode selected, DemoMode queried)
{
    return selected == DemoMode::All || selected == queried;
}

} // namespace

bool Engine::initialize(const PlatformConfig& config, const EngineRunConfig& run_config)
{
    SDL_Log("[engine] initializing...");
    m_frame_limit = run_config.frame_limit;
    m_demo_mode = run_config.demo_mode;

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
    if (!m_debug_ui.initialize(sdl_platform::native_window(m_platform))) {
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
    if (m_frame_limit > 0) {
        SDL_Log("[engine] frame-limited smoke run: %u frames", m_frame_limit);
    }
    std::printf("[engine] ready\n");
    preview_bridge::emit_ready(m_demo_position, m_preview_running);

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

    if (m_frame_limit > 0 && m_frame_count >= m_frame_limit) {
        SDL_Log("[engine] frame limit reached: %u", m_frame_count);
        m_running = false;
    }

    return m_running;
}

void Engine::handle_events()
{
    m_platform.poll_events();

    for (const SDL_Event& event : sdl_platform::events(m_platform)) {
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
                handle_mouse_down(event.button.x, event.button.y, event.button.button);
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

void Engine::handle_mouse_down(float x, float y, uint8_t button)
{
    if (button != SDL_BUTTON_LEFT || m_platform.width() <= 0 || m_platform.height() <= 0) {
        return;
    }

    constexpr float half_width = 48.0f;
    constexpr float half_height = 42.0f;
    const float width = static_cast<float>(m_platform.width());
    const float height = static_cast<float>(m_platform.height());
    const float usable_width = width - half_width * 2.0f;
    const float usable_height = height - half_height * 2.0f;
    const float center_x = half_width + m_demo_position.x * (usable_width > 0.0f ? usable_width : 0.0f);
    const float center_y = half_height + m_demo_position.y * (usable_height > 0.0f ? usable_height : 0.0f);

    const Vec2 point{x, y};
    const Vec2 top{center_x, center_y - half_height};
    const Vec2 left{center_x - half_width, center_y + half_height};
    const Vec2 right{center_x + half_width, center_y + half_height};
    if (!point_in_triangle(point, top, left, right)) {
        return;
    }

    preview_bridge::emit_object_clicked(
        "demo-triangle",
        m_demo_position,
        preview_bridge::NormalizedPosition{clamp01(x / width), clamp01(y / height)});
}

void Engine::update(float dt)
{
    if (!m_preview_running) return;
    m_elapsed_seconds += dt;
}

void Engine::render()
{
    m_debug_ui.begin_frame(m_renderer.width(), m_renderer.height());
    m_runtime_ui.begin_frame(m_platform.delta_time());
    m_renderer.begin_frame();
    m_renderer.draw_preview_triangle(m_demo_position);
#if defined(NOVELTEA_HAS_RENDER2D)
    if (demo_enabled(m_demo_mode, DemoMode::Render2D)) {
        m_renderer.draw_demo_2d(m_elapsed_seconds);
    }
#endif
#if defined(NOVELTEA_HAS_BGFX)
    if (demo_enabled(m_demo_mode, DemoMode::Text)) {
        m_renderer.draw_demo_text(m_elapsed_seconds);
    }
#endif

    ++m_frame_count;

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

void Engine::request_stop()
{
    m_running = false;
    m_platform.request_quit();
}

void Engine::set_demo_position(float normalized_x, float normalized_y)
{
    m_demo_position = {clamp01(normalized_x), clamp01(normalized_y)};
    preview_bridge::emit_state_changed(m_demo_position, m_preview_running);
}

void Engine::reset_demo_position()
{
    set_demo_position(0.5f, 0.5f);
}

void Engine::set_preview_running(bool running)
{
    m_preview_running = running;
    preview_bridge::emit_state_changed(m_demo_position, m_preview_running);
}

} // namespace noveltea
