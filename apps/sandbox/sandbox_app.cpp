#include "sandbox_app.hpp"

#include "noveltea/engine_tooling.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif

namespace noveltea {

namespace {
bool parse_surface_size(const std::string& token, HostSurfaceMetrics& surface)
{
    const size_t separator = token.find('x');
    if (separator == std::string::npos || separator == 0 || separator + 1 >= token.size())
        return false;
    char* end = nullptr;
    const long width = std::strtol(token.c_str(), &end, 10);
    if (!end || *end != 'x')
        return false;
    const long height = std::strtol(end + 1, &end, 10);
    if (!end || *end != '\0' || width <= 0 || height <= 0)
        return false;
    surface = make_host_surface_metrics(int(width), int(height), int(width), int(height));
    return true;
}

bool parse_resize_sequence(const char* value, std::vector<HostSurfaceMetrics>& sequence)
{
    sequence.clear();
    const std::string text = value ? value : "";
    size_t begin = 0;
    while (begin <= text.size()) {
        const size_t comma = text.find(',', begin);
        const size_t end = comma == std::string::npos ? text.size() : comma;
        HostSurfaceMetrics surface;
        if (!parse_surface_size(text.substr(begin, end - begin), surface))
            return false;
        sequence.push_back(surface);
        if (comma == std::string::npos)
            break;
        begin = comma + 1;
    }
    return !sequence.empty();
}
} // namespace

App::~App()
{
    m_demo_harness.shutdown();
    m_engine.shutdown();
}

bool App::parse_options(int argc, char* argv[], Options& options) const
{
    if (const char* env_frames = std::getenv("NOVELTEA_SMOKE_FRAMES"))
        options.frame_limit = static_cast<uint32_t>(std::strtoul(env_frames, nullptr, 10));

    for (int i = 1; i < argc; ++i) {
        const char* arg = argv[i];
        auto require_value = [&](const char* option) -> const char* {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] %s requires a value\n", option);
                return nullptr;
            }
            return argv[++i];
        };

        if (std::strcmp(arg, "--frames") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.frame_limit = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
        } else if (std::strcmp(arg, "--fps-cap") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.fps_cap = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
        } else if (std::strcmp(arg, "--fixed-delta-ms") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.fixed_delta_seconds = std::strtod(value, nullptr) / 1000.0;
            if (!(options.fixed_delta_seconds > 0.0)) {
                std::fprintf(stderr, "[app] --fixed-delta-ms must be positive\n");
                return false;
            }
        } else if (std::strcmp(arg, "--show-fps") == 0) {
            options.show_fps_counter = true;
        } else if (std::strcmp(arg, "--demo") == 0) {
            const char* mode = require_value(arg);
            if (!mode)
                return false;
            if (std::strcmp(mode, "render2d") == 0)
                options.demo_mode = sandbox::DemoMode::Render2D;
            else if (std::strcmp(mode, "texture-sampling") == 0)
                options.demo_mode = sandbox::DemoMode::TextureSampling;
            else if (std::strcmp(mode, "rmlui") == 0)
                options.demo_mode = sandbox::DemoMode::RmlUi;
            else if (std::strcmp(mode, "text") == 0)
                options.demo_mode = sandbox::DemoMode::Text;
            else if (std::strcmp(mode, "all") == 0)
                options.demo_mode = sandbox::DemoMode::All;
            else if (std::strcmp(mode, "none") == 0)
                options.demo_mode = sandbox::DemoMode::None;
            else {
                std::fprintf(stderr, "[app] unknown demo mode: %s\n", mode);
                return false;
            }
        } else if (std::strcmp(arg, "--system-assets") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.system_asset_root = value;
        } else if (std::strcmp(arg, "--project-assets") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.project_asset_root = value;
        } else if (std::strcmp(arg, "--cache-assets") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.cache_asset_root = value;
        } else if (std::strcmp(arg, "--rmlui-document") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.runtime_ui_document = value;
        } else if (std::strcmp(arg, "--compiled-project") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.compiled_project = value;
        } else if (std::strcmp(arg, "--postprocess-material") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.postprocess_material = value;
        } else if (std::strcmp(arg, "--skip-title-screen") == 0) {
            options.skip_title_screen = true;
        } else if (std::strcmp(arg, "--run-runtime") == 0) {
            options.run_runtime = true;
        } else if (std::strcmp(arg, "--display-orientation") == 0) {
            const char* orientation = require_value(arg);
            if (!orientation)
                return false;
            if (std::strcmp(orientation, "landscape") == 0)
                options.launch_orientation = ScreenOrientation::Landscape;
            else if (std::strcmp(orientation, "portrait") == 0)
                options.launch_orientation = ScreenOrientation::Portrait;
            else {
                std::fprintf(stderr, "[app] invalid display orientation: %s\n", orientation);
                return false;
            }
        } else if (std::strcmp(arg, "--window-size") == 0) {
            const char* value = require_value(arg);
            HostSurfaceMetrics surface;
            if (!value || !parse_surface_size(value, surface)) {
                std::fprintf(stderr, "[app] invalid --window-size value\n");
                return false;
            }
            options.window_width = surface.logical_size.width;
            options.window_height = surface.logical_size.height;
        } else if (std::strcmp(arg, "--screenshot") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.screenshot_path = value;
        } else if (std::strcmp(arg, "--resize-sequence") == 0) {
            const char* value = require_value(arg);
            if (!value || !parse_resize_sequence(value, options.resize_sequence)) {
                std::fprintf(stderr, "[app] invalid --resize-sequence value\n");
                return false;
            }
        } else if (std::strcmp(arg, "--resize-interval-frames") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.resize_interval_frames =
                std::max(1u, static_cast<uint32_t>(std::strtoul(value, nullptr, 10)));
        } else if (std::strcmp(arg, "--readback-after-resize-frames") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.readback_after_resize_frames =
                static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
        } else if (std::strcmp(arg, "--runtime-ui-scale") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            const double scale = std::strtod(value, nullptr);
            if (!std::isfinite(scale) || scale <= 0.0) {
                std::fprintf(stderr, "[app] --runtime-ui-scale must be finite and positive\n");
                return false;
            }
            options.runtime_ui_scale = scale;
        } else if (std::strcmp(arg, "--no-imgui") == 0) {
            options.no_imgui = true;
        } else if (std::strcmp(arg, "--render-perf") == 0) {
            options.perf_logging = true;
        } else if (std::strcmp(arg, "--rmlui-base-direct-compat") == 0) {
            options.rmlui_base_direct_compat = true;
        } else if (std::strcmp(arg, "--no-audio") == 0) {
            options.no_audio = true;
        } else if (std::strcmp(arg, "--audio-sfx") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.audio_sfx_paths.emplace_back(value);
        } else if (std::strcmp(arg, "--audio-track") == 0) {
            const char* value = require_value(arg);
            if (!value)
                return false;
            options.audio_track_specs.emplace_back(value);
        } else {
            std::fprintf(stderr, "[app] unknown option: %s\n", arg);
            return false;
        }
    }
    return true;
}

bool App::initialize(int argc, char* argv[])
{
    Options options;
    if (!parse_options(argc, argv, options))
        return false;

    PlatformConfig config;
    config.title = "NovelTea Sandbox";
    if (options.launch_orientation == ScreenOrientation::Portrait) {
        config.width = 720;
        config.height = 1280;
    }
    if (options.window_width > 0 && options.window_height > 0) {
        config.width = options.window_width;
        config.height = options.window_height;
    }

    EngineConfig engine_config;
    engine_config.system_asset_root = options.system_asset_root;
    engine_config.project_asset_root = options.project_asset_root;
    engine_config.cache_asset_root = options.cache_asset_root;
    engine_config.compiled_project = options.compiled_project;
    engine_config.load_title_screen = !options.skip_title_screen;
    engine_config.enable_audio = !options.no_audio;

    EngineToolingConfig tooling_config;
    tooling_config.frame_limit = options.frame_limit;
    tooling_config.fps_cap = options.fps_cap;
    tooling_config.fixed_delta_seconds = options.fixed_delta_seconds;
    tooling_config.runtime_ui_document = options.runtime_ui_document;
    tooling_config.keep_runtime_running = options.run_runtime;
    const bool resize_readback_fixture =
        !options.resize_sequence.empty() && options.readback_after_resize_frames > 0;
    if (resize_readback_fixture && options.frame_limit == 0) {
        const uint32_t interval = std::max(1u, options.resize_interval_frames);
        const uint32_t resize_frame_count =
            uint32_t((options.resize_sequence.size() - 1u) * interval + 1u);
        tooling_config.frame_limit = resize_frame_count + options.readback_after_resize_frames;
    }
    tooling_config.enable_debug_ui = !options.no_imgui;
    tooling_config.render_perf_logging = options.perf_logging;
    tooling_config.rmlui_base_direct_compat = options.rmlui_base_direct_compat;
    tooling_config.show_fps_counter = options.show_fps_counter;
    if ((options.demo_mode == sandbox::DemoMode::RmlUi ||
         options.demo_mode == sandbox::DemoMode::All) &&
        tooling_config.runtime_ui_document.empty()) {
        tooling_config.runtime_ui_document = "project:/rmlui/demo.rml";
        if (engine_config.compiled_project.empty()) {
            engine_config.compiled_project = "project:/projects/runtime_presentation_package.ntpkg";
            engine_config.load_title_screen = false;
        }
    }

    if (!EngineTooling::initialize(m_engine, config, engine_config, tooling_config)) {
        std::fprintf(stderr, "[app] engine initialization failed\n");
        return false;
    }
    if (options.runtime_ui_scale &&
        !EngineTooling::set_runtime_ui_scale(m_engine, *options.runtime_ui_scale)) {
        std::fprintf(stderr, "[app] runtime UI scale was rejected: %.3f\n",
                     *options.runtime_ui_scale);
        m_engine.shutdown();
        return false;
    }
    if (!options.postprocess_material.empty() &&
        !EngineTooling::set_postprocess_material(m_engine, options.postprocess_material)) {
        std::fprintf(stderr, "[app] postprocess material request was rejected: %s\n",
                     options.postprocess_material.c_str());
        m_engine.shutdown();
        return false;
    }
    if (!m_demo_harness.initialize({.mode = options.demo_mode,
                                    .audio_sfx_paths = options.audio_sfx_paths,
                                    .audio_track_specs = options.audio_track_specs})) {
        std::fprintf(stderr, "[app] sandbox demo harness initialization failed\n");
        m_engine.shutdown();
        return false;
    }

    options.frame_limit = tooling_config.frame_limit;
    m_options = std::move(options);
    m_submitted_frames = 0;
    return true;
}

int App::run(int argc, char* argv[])
{
    if (!initialize(argc, argv))
        return 1;
#if defined(__EMSCRIPTEN__)
    std::printf("[app] registering Emscripten main loop\n");
    emscripten_set_main_loop_arg(&App::web_tick, this, 0, true);
    return 0;
#else
    const bool resize_readback_fixture =
        !m_options.resize_sequence.empty() && m_options.readback_after_resize_frames > 0;
    int result = 0;
    if (resize_readback_fixture)
        result = run_resize_readback_fixture();
    else
        while (m_engine.is_running())
            tick_engine();
    m_demo_harness.shutdown();
    m_engine.shutdown();
    return result;
#endif
}

bool App::tick_engine()
{
    m_demo_harness.submit_frame();
    const uint32_t next_frame = m_submitted_frames + 1u;
    const bool screenshot_due = !m_options.screenshot_path.empty() &&
                                (m_options.frame_limit == 0 || next_frame >= m_options.frame_limit);
    if (screenshot_due) {
        if (!EngineTooling::request_screenshot(m_engine, m_options.screenshot_path))
            std::fprintf(stderr, "[app] screenshot request was rejected: %s\n",
                         m_options.screenshot_path.c_str());
        m_options.screenshot_path.clear();
    }
    ++m_submitted_frames;
    return m_engine.tick();
}

int App::run_resize_readback_fixture()
{
    const uint32_t interval = std::max(1u, m_options.resize_interval_frames);
    uint32_t countdown = 0;
    size_t resize_index = 0;
    while (m_engine.is_running()) {
        if (resize_index < m_options.resize_sequence.size()) {
            if (countdown == 0) {
                HostSurfaceMetrics scheduled =
                    sanitize_host_surface_metrics(m_options.resize_sequence[resize_index++]);
                std::printf("[app] applying resize-readback fixture resize %zu/%zu: logical=%dx%d "
                            "framebuffer=%dx%d\n",
                            resize_index, m_options.resize_sequence.size(),
                            scheduled.logical_size.width, scheduled.logical_size.height,
                            scheduled.framebuffer_size.width, scheduled.framebuffer_size.height);
                m_engine.resize(scheduled);
                countdown = interval - 1u;
            } else {
                --countdown;
            }
        }
        tick_engine();
    }
    return 0;
}

void App::web_tick(void* user_data)
{
    auto* app = static_cast<App*>(user_data);
    if (!app->tick_engine()) {
#if defined(__EMSCRIPTEN__)
        emscripten_cancel_main_loop();
#endif
        app->m_demo_harness.shutdown();
        app->m_engine.shutdown();
    }
}

} // namespace noveltea
