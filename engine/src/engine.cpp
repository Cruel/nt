#include "noveltea/engine.hpp"

#include "noveltea/math/geometry.hpp"
#include "noveltea/preview_bridge.hpp"
#include "platform/sdl/sdl_platform.hpp"

#include <SDL3/SDL.h>

#include <cstdio>
#include <cstdint>
#include <memory>

namespace noveltea {

Engine::Engine() = default;
Engine::~Engine() { shutdown(); }

namespace {

bool demo_enabled(DemoMode selected, DemoMode queried)
{
    return selected == DemoMode::All || selected == queried;
}

std::filesystem::path default_system_asset_root()
{
#if defined(NOVELTEA_PLATFORM_DESKTOP)
    return NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT;
#elif defined(NOVELTEA_PLATFORM_WEB)
    return "/assets";
#else
    return {};
#endif
}

std::filesystem::path default_project_asset_root()
{
#if defined(NOVELTEA_PLATFORM_DESKTOP)
#if defined(NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT)
    return NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT;
#else
    return NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT;
#endif
#elif defined(NOVELTEA_PLATFORM_WEB)
    return "/assets";
#else
    return {};
#endif
}

#if !defined(NOVELTEA_PLATFORM_DESKTOP)
std::filesystem::path sdl_pref_path()
{
    char* pref = SDL_GetPrefPath("Cruel", "NovelTea");
    if (!pref) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] SDL_GetPrefPath failed: %s", SDL_GetError());
        return {};
    }
    std::filesystem::path result(pref);
    SDL_free(pref);
    return result;
}
#endif

std::filesystem::path default_cache_asset_root()
{
#if defined(NOVELTEA_PLATFORM_DESKTOP)
    return NOVELTEA_DEFAULT_CACHE_ASSET_ROOT;
#else
    return sdl_pref_path() / "cache";
#endif
}

void mount_default_source(
    assets::AssetManager& assets,
    const char* ns,
    const std::filesystem::path& override_root,
    const std::filesystem::path& default_root,
    bool writable)
{
#if defined(NOVELTEA_PLATFORM_ANDROID)
    if (!override_root.empty()) {
        assets.mount_directory(ns, override_root, writable);
    } else if (writable) {
        assets.mount_directory(ns, default_root, true);
    } else {
        assets.mount(ns, std::make_shared<assets::SdlPackagedAssetSource>());
    }
#else
    assets.mount_directory(ns, override_root.empty() ? default_root : override_root, writable);
#endif
}

} // namespace

void Engine::configure_assets(const EngineRunConfig& run_config)
{
    const auto system_root = run_config.system_asset_root.empty()
        ? default_system_asset_root()
        : run_config.system_asset_root;
    const auto project_root = run_config.project_asset_root.empty()
        ? default_project_asset_root()
        : run_config.project_asset_root;
    const auto cache_root = run_config.cache_asset_root.empty()
        ? default_cache_asset_root()
        : run_config.cache_asset_root;

    mount_default_source(m_assets, "system", run_config.system_asset_root, system_root, false);
    mount_default_source(m_assets, "project", run_config.project_asset_root, project_root, false);
    m_assets.mount_directory("cache", cache_root, true);

    for (const auto& mount : m_assets.describe_mounts()) {
        SDL_Log("[assets] %s", mount.c_str());
    }

#if defined(NOVELTEA_PLATFORM_ANDROID)
    auto smoke = m_assets.read_binary("system:/shaders/bgfx/essl-300/triangle.vs.bin");
    if (smoke) {
        SDL_Log("[assets] Android smoke read system:/shaders/bgfx/essl-300/triangle.vs.bin: %zu bytes",
            smoke.value->bytes.size());
    } else {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] Android smoke read failed: %s", smoke.error.c_str());
    }
#endif
}

bool Engine::initialize(const PlatformConfig& config, const EngineRunConfig& run_config)
{
    SDL_Log("[engine] initializing...");
    m_frame_limit = run_config.frame_limit;
    m_demo_mode = run_config.demo_mode;

    if (!m_platform.initialize(config)) {
        std::fprintf(stderr, "[engine] platform init failed\n");
        return false;
    }

    configure_assets(run_config);

    const NativeWindowHandles handles = m_platform.native_window_handles();

    RendererConfig rcfg;
    rcfg.native_display = handles.display;
    rcfg.native_window = handles.window;
    rcfg.width = config.width;
    rcfg.height = config.height;
    rcfg.vsync = config.vsync;
    rcfg.assets = &m_assets;

    if (!m_renderer.initialize(rcfg)) {
        std::fprintf(stderr, "[engine] renderer init failed\n");
        m_platform.shutdown();
        return false;
    }

    if (!m_runtime_ui.initialize(&m_assets)) {
        std::fprintf(stderr, "[engine] runtime UI init failed (non-fatal scaffold)\n");
    }

    SDL_Log("[engine] initializing debug UI...");
    if (!m_debug_ui.initialize(sdl_platform::native_window(m_platform), &m_assets)) {
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
