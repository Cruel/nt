#include "noveltea/engine.hpp"

#include "noveltea/core/legacy/project_package_reader.hpp"
#include "noveltea/math/geometry.hpp"
#include "noveltea/preview_bridge.hpp"
#include "platform/sdl/sdl_platform.hpp"

#include <SDL3/SDL.h>

#include <cstdio>
#include <cstdint>
#include <memory>
#include <span>
#include <stdexcept>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea {

Engine::Engine() = default;
Engine::~Engine() { shutdown(); }

namespace {

bool demo_enabled(DemoMode selected, DemoMode queried)
{
    if (selected == DemoMode::None)
        return false;
    return selected == DemoMode::All || selected == queried;
}

std::filesystem::path default_system_asset_root()
{
#if defined(NOVELTEA_PLATFORM_DESKTOP)
    if (const char* base = SDL_GetBasePath()) {
        std::filesystem::path packaged = std::filesystem::path(base) / "assets";
        if (std::filesystem::exists(packaged / "system")) {
            return packaged / "system";
        }
    }
    return NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT;
#elif defined(NOVELTEA_PLATFORM_WEB)
    return "/assets/system";
#else
    return {};
#endif
}

std::filesystem::path default_project_asset_root()
{
#if defined(NOVELTEA_PLATFORM_DESKTOP)
    if (const char* base = SDL_GetBasePath()) {
        std::filesystem::path packaged = std::filesystem::path(base) / "assets";
        if (std::filesystem::exists(packaged / "project")) {
            return packaged / "project";
        }
    }
#if defined(NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT)
    return NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT;
#else
    return NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT;
#endif
#elif defined(NOVELTEA_PLATFORM_WEB)
    return "/assets/project";
#else
    return {};
#endif
}

#if !defined(NOVELTEA_PLATFORM_DESKTOP)
std::filesystem::path sdl_pref_path()
{
    char* pref = SDL_GetPrefPath("Cruel", "NovelTea");
    if (!pref) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] SDL_GetPrefPath failed: %s",
                     SDL_GetError());
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

void mount_default_source(assets::AssetManager& assets, const char* ns,
                          const std::filesystem::path& override_root,
                          const std::filesystem::path& default_root, bool writable)
{
#if defined(NOVELTEA_PLATFORM_ANDROID)
    if (!override_root.empty()) {
        assets.mount_directory(ns, override_root, writable);
    } else if (writable) {
        assets.mount_directory(ns, default_root, true);
    } else {
        assets.mount(ns, std::make_shared<assets::SdlPackagedAssetSource>(ns));
    }
#else
    assets.mount_directory(ns, override_root.empty() ? default_root : override_root, writable);
#endif
}

} // namespace

void Engine::configure_assets(const EngineRunConfig& run_config)
{
    const auto system_root = run_config.system_asset_root.empty() ? default_system_asset_root()
                                                                  : run_config.system_asset_root;
    const auto project_root = run_config.project_asset_root.empty() ? default_project_asset_root()
                                                                    : run_config.project_asset_root;
    const auto cache_root = run_config.cache_asset_root.empty() ? default_cache_asset_root()
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
        SDL_Log(
            "[assets] Android smoke read system:/shaders/bgfx/essl-300/triangle.vs.bin: %zu bytes",
            smoke.value->bytes.size());
    } else {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] Android smoke read failed: %s",
                     smoke.error.c_str());
        throw std::runtime_error(smoke.error);
    }
#endif
}

bool Engine::load_runtime_project(const std::string& logical_path)
{
    auto blob = m_assets.read_binary(logical_path);
    if (!blob) {
        std::fprintf(stderr, "[engine] failed to read runtime project %s: %s\n",
                     logical_path.c_str(), blob.error.c_str());
        return false;
    }

    auto load_document = [&](core::ProjectDocument document) {
        auto result = m_runtime_host.load(std::move(document));
        for (const auto& diagnostic : result.diagnostics) {
            const char* severity = "info";
            if (diagnostic.severity == core::SessionDiagnosticSeverity::Warning)
                severity = "warning";
            if (diagnostic.severity == core::SessionDiagnosticSeverity::Error)
                severity = "error";
            SDL_Log("[runtime] %s %s %s", severity, diagnostic.path.c_str(),
                    diagnostic.message.c_str());
        }
        if (!result.success) {
            std::fprintf(stderr, "[engine] runtime project failed validation: %s\n",
                         logical_path.c_str());
            return false;
        }
#if defined(NOVELTEA_HAS_LUA)
        m_script_executor.initialize(&m_scripts, &m_runtime_host);
#endif
        return true;
    };

    const auto& bytes = blob.value->bytes;
    const std::string text(bytes.begin(), bytes.end());
    try {
        auto json = nlohmann::json::parse(text);
        if (!load_document(core::ProjectDocument(std::move(json)))) {
            return false;
        }
    } catch (const std::exception& ex) {
        std::vector<core::legacy::PackageError> errors;
        auto package = core::legacy::ProjectPackageReader::read(
            std::span<const std::uint8_t>(bytes.data(), bytes.size()), errors);
        if (!package) {
            std::fprintf(stderr, "[engine] runtime project parse failed: %s: %s\n",
                         logical_path.c_str(), ex.what());
            for (const auto& error : errors) {
                std::fprintf(stderr, "[engine] legacy package import failed: %s\n",
                             error.message.c_str());
            }
            return false;
        }
        m_assets.mount_legacy_package("project", *package);
        if (!load_document(std::move(package->imported_project.document))) {
            return false;
        }
        SDL_Log("[engine] mounted legacy runtime package assets: %s", logical_path.c_str());
    }

    m_runtime_ui.bind_runtime_host(m_runtime_host.loaded() ? &m_runtime_host : nullptr);
    SDL_Log("[engine] loaded runtime project: %s", logical_path.c_str());
    return true;
}

bool Engine::initialize(const PlatformConfig& config, const EngineRunConfig& run_config)
{
    SDL_Log("[engine] initializing...");
    m_frame_limit = run_config.frame_limit;
    m_demo_mode = run_config.demo_mode;
    m_screenshot_path = run_config.screenshot_path;
    m_debug_ui_enabled = run_config.enable_debug_ui;
    bool platform_initialized = false;
    bool renderer_initialized = false;
    bool scripts_initialized = false;
    bool runtime_ui_initialized = false;
    bool debug_ui_initialized = false;

    auto rollback = [&]() {
        if (debug_ui_initialized) {
            m_debug_ui.shutdown();
            debug_ui_initialized = false;
        }
        if (runtime_ui_initialized) {
            m_runtime_ui.shutdown();
            runtime_ui_initialized = false;
        }
#if defined(NOVELTEA_HAS_LUA)
        if (scripts_initialized) {
            m_scripts.shutdown();
            scripts_initialized = false;
        }
#endif
        if (renderer_initialized) {
            m_renderer.shutdown();
            renderer_initialized = false;
        }
        if (platform_initialized) {
            m_platform.shutdown();
            platform_initialized = false;
        }
        m_running = false;
        m_initialized = false;
        std::printf("[engine] initialization rollback complete\n");
    };

    if (!m_platform.initialize(config)) {
        std::fprintf(stderr, "[engine] platform init failed\n");
        return false;
    }
    platform_initialized = true;

    try {
        configure_assets(run_config);
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "[engine] asset configuration failed: %s\n", ex.what());
        rollback();
        return false;
    }

    const NativeWindowHandles handles = m_platform.native_window_handles();

    RendererConfig rcfg;
    rcfg.native_display = handles.display;
    rcfg.native_window = handles.window;
    rcfg.surface = m_platform.surface();
    rcfg.vsync = config.vsync;
    rcfg.assets = &m_assets;

    if (!m_renderer.initialize(rcfg)) {
        std::fprintf(stderr, "[engine] renderer init failed\n");
        rollback();
        return false;
    }
    renderer_initialized = true;

#if defined(NOVELTEA_HAS_LUA)
    auto script_init = m_scripts.initialize({&m_assets});
    if (!script_init) {
        std::fprintf(stderr, "[engine] script runtime init failed: %s\n",
                     script_init.error ? script_init.error->message.c_str() : "unknown error");
        rollback();
        return false;
    }
    scripts_initialized = true;
#endif

    const bool load_demo = demo_enabled(run_config.demo_mode, DemoMode::RmlUi);
    m_runtime_ui.resize(m_platform.surface());
    if (!m_runtime_ui.initialize(&m_assets, sdl_platform::native_window(m_platform), load_demo,
#if defined(NOVELTEA_HAS_LUA)
                                 &m_scripts
#else
                                 nullptr
#endif
                                 )) {
        std::fprintf(stderr, "[engine] runtime UI init failed (non-fatal scaffold)\n");
    } else if (!run_config.runtime_ui_document.empty()) {
        runtime_ui_initialized = true;
        if (m_runtime_ui.load_document("runtime-acceptance", run_config.runtime_ui_document,
                                       true)) {
            SDL_Log("[engine] loaded RmlUi document: %s", run_config.runtime_ui_document.c_str());
        } else {
            std::fprintf(stderr, "[engine] failed to load RmlUi document: %s\n",
                         run_config.runtime_ui_document.c_str());
            rollback();
            return false;
        }
    } else {
        runtime_ui_initialized = true;
    }

    if (m_debug_ui_enabled) {
        SDL_Log("[engine] initializing debug UI...");
        if (!m_debug_ui.initialize(sdl_platform::native_window(m_platform), &m_assets)) {
            std::fprintf(stderr, "[engine] debug UI init failed (non-fatal)\n");
        } else {
            debug_ui_initialized = true;
            SDL_Log("[engine] debug UI initialized");
        }
    }

    if (!run_config.runtime_project.empty() && !load_runtime_project(run_config.runtime_project)) {
        rollback();
        return false;
    }

    m_running = true;
    m_initialized = true;
    SDL_Log("[engine] initialized (renderer: %s, logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f)",
            m_renderer.renderer_name(), m_platform.logical_width(), m_platform.logical_height(),
            m_platform.framebuffer_width(), m_platform.framebuffer_height(), m_platform.scale_x(),
            m_platform.scale_y());
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
    if (!m_running)
        return false;

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

void Engine::resize(const SurfaceMetrics& surface)
{
    const SurfaceMetrics sanitized = sanitize_surface_metrics(surface);
    const SurfaceMetrics previous = m_renderer.surface();
    if (previous.logical_width == sanitized.logical_width &&
        previous.logical_height == sanitized.logical_height &&
        previous.framebuffer_width == sanitized.framebuffer_width &&
        previous.framebuffer_height == sanitized.framebuffer_height &&
        previous.scale_x == sanitized.scale_x && previous.scale_y == sanitized.scale_y) {
        return;
    }

    m_platform.set_surface_metrics(sanitized);
    m_renderer.resize(sanitized);
    m_runtime_ui.resize(sanitized);
    SDL_Log("[surface] logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f", sanitized.logical_width,
            sanitized.logical_height, sanitized.framebuffer_width, sanitized.framebuffer_height,
            sanitized.scale_x, sanitized.scale_y);
}

void Engine::handle_events()
{
    m_platform.poll_events();

    for (const SDL_Event& event : sdl_platform::events(m_platform)) {
        // SDL event -> devtools -> runtime UI -> game/platform handling.
        if (m_debug_ui_enabled) {
            m_debug_ui.process_event(event, m_platform.surface());
        }
        const bool ui_consumed = m_runtime_ui.process_event(event);

        switch (event.type) {
        case SDL_EVENT_QUIT:
            m_platform.request_quit();
            break;

        case SDL_EVENT_KEY_DOWN:
            if (ui_consumed)
                break;
            if (event.key.key == SDLK_ESCAPE) {
                m_platform.request_quit();
            }
            std::printf("[input] key_down: scancode=%d\n", event.key.scancode);
            break;

        case SDL_EVENT_MOUSE_BUTTON_DOWN:
            if (ui_consumed)
                break;
            std::printf(
                "[input] mouse_down: button=%d logical=(%.2f,%.2f) surface=%dx%d scale=%.3fx%.3f\n",
                event.button.button, event.button.x, event.button.y, m_platform.logical_width(),
                m_platform.logical_height(), m_platform.scale_x(), m_platform.scale_y());
            handle_mouse_down(event.button.x, event.button.y, event.button.button);
            break;

        case SDL_EVENT_MOUSE_BUTTON_UP:
        case SDL_EVENT_MOUSE_MOTION:
        case SDL_EVENT_MOUSE_WHEEL:
        case SDL_EVENT_TEXT_INPUT:
        case SDL_EVENT_KEY_UP:
        case SDL_EVENT_FINGER_DOWN:
        case SDL_EVENT_FINGER_UP:
        case SDL_EVENT_FINGER_MOTION:
        case SDL_EVENT_FINGER_CANCELED:
            if (ui_consumed)
                break;
            break;

        case SDL_EVENT_WINDOW_RESIZED:
        case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
        case SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED:
            m_platform.refresh_surface_metrics();
            resize(m_platform.surface());
            break;

        default:
            break;
        }
    }
}

void Engine::handle_mouse_down(float x, float y, uint8_t button)
{
    if (button != SDL_BUTTON_LEFT || m_platform.logical_width() <= 0 ||
        m_platform.logical_height() <= 0) {
        return;
    }

    constexpr float half_width = 48.0f;
    constexpr float half_height = 42.0f;
    const float width = static_cast<float>(m_platform.logical_width());
    const float height = static_cast<float>(m_platform.logical_height());
    const float usable_width = width - half_width * 2.0f;
    const float usable_height = height - half_height * 2.0f;
    const float center_x =
        half_width + m_demo_position.x * (usable_width > 0.0f ? usable_width : 0.0f);
    const float center_y =
        half_height + m_demo_position.y * (usable_height > 0.0f ? usable_height : 0.0f);

    const Vec2 point{x, y};
    const Vec2 top{center_x, center_y - half_height};
    const Vec2 left{center_x - half_width, center_y + half_height};
    const Vec2 right{center_x + half_width, center_y + half_height};
    if (!point_in_triangle(point, top, left, right)) {
        return;
    }

    preview_bridge::emit_object_clicked(
        "demo-triangle", m_demo_position,
        preview_bridge::NormalizedPosition{clamp01(x / width), clamp01(y / height)});
}

void Engine::update(float dt)
{
    if (!m_preview_running)
        return;
    m_elapsed_seconds += dt;
    if (m_runtime_host.loaded()) {
        core::RuntimeInput input;
        input.type = core::RuntimeInputType::Tick;
        input.delta_seconds = dt;
        auto result = m_runtime_host.apply_input(input);
        m_runtime_ui.apply_controller_commands(m_runtime_host.last_commands());
#if defined(NOVELTEA_HAS_LUA)
        bool has_script_request = false;
        for (const auto& output : result.outputs) {
            if (output.type == core::RuntimeOutputType::ScriptRequest) {
                has_script_request = true;
                break;
            }
        }
        m_script_executor.process(result);
        if (has_script_request) {
            m_runtime_ui.apply_controller_commands(m_runtime_host.last_commands());
        }
#endif
    }
}

void Engine::render()
{
    if (m_debug_ui_enabled) {
        m_debug_ui.begin_frame(m_renderer.surface());
    }
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
    if (m_debug_ui_enabled) {
        m_debug_ui.end_frame();
    }
    if (!m_screenshot_path.empty() && (m_frame_limit == 0 || m_frame_count >= m_frame_limit)) {
        m_renderer.request_screenshot(m_screenshot_path);
        m_screenshot_path.clear();
    }
    m_renderer.end_frame();
}

void Engine::shutdown()
{
    if (!m_initialized)
        return;

    m_running = false;

    if (m_debug_ui_enabled) {
        m_debug_ui.shutdown();
    }
    m_runtime_ui.shutdown();
#if defined(NOVELTEA_HAS_LUA)
    m_script_executor.shutdown();
    m_scripts.shutdown();
#endif
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

void Engine::reset_demo_position() { set_demo_position(0.5f, 0.5f); }

void Engine::set_preview_running(bool running)
{
    m_preview_running = running;
    preview_bridge::emit_state_changed(m_demo_position, m_preview_running);
}

} // namespace noveltea
