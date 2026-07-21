#include "sandbox_app.hpp"
#include "noveltea/core/editor_runtime_protocol.hpp"
#include "noveltea/engine_tooling.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/runtime_preview_controller.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <exception>
#include <optional>
#include <string>
#include <vector>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#endif

namespace noveltea {

namespace {
Engine* g_preview_engine = nullptr;
sandbox::SandboxDemoHarness* g_demo_harness = nullptr;

void emit_preview_state()
{
    if (g_preview_engine && g_demo_harness) {
        preview_bridge::emit_state_changed(g_demo_harness->position(),
                                           EngineTooling::preview_running(*g_preview_engine));
    }
}

bool parse_surface_size(const std::string& token, HostSurfaceMetrics& surface)
{
    const size_t separator = token.find('x');
    if (separator == std::string::npos || separator == 0 || separator + 1 >= token.size()) {
        return false;
    }
    char* end = nullptr;
    const long width = std::strtol(token.c_str(), &end, 10);
    if (!end || *end != 'x') {
        return false;
    }
    const long height = std::strtol(end + 1, &end, 10);
    if (!end || *end != '\0' || width <= 0 || height <= 0) {
        return false;
    }
    surface = make_host_surface_metrics(int(width), int(height), int(width), int(height));
    return true;
}

bool parse_resize_sequence(const char* value, std::vector<HostSurfaceMetrics>& sequence)
{
    sequence.clear();
    std::string text = value ? value : "";
    size_t begin = 0;
    while (begin <= text.size()) {
        const size_t comma = text.find(',', begin);
        const size_t end = comma == std::string::npos ? text.size() : comma;
        const std::string token = text.substr(begin, end - begin);
        HostSurfaceMetrics surface;
        if (!parse_surface_size(token, surface)) {
            return false;
        }
        sequence.push_back(surface);
        if (comma == std::string::npos) {
            break;
        }
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
    if (const char* env_frames = std::getenv("NOVELTEA_SMOKE_FRAMES")) {
        options.frame_limit = static_cast<uint32_t>(std::strtoul(env_frames, nullptr, 10));
    }

    for (int i = 1; i < argc; ++i) {
        const char* arg = argv[i];
        if (std::strcmp(arg, "--frames") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --frames requires a number\n");
                return false;
            }
            options.frame_limit = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (std::strcmp(arg, "--fps-cap") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --fps-cap requires a number\n");
                return false;
            }
            options.fps_cap = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (std::strcmp(arg, "--fixed-delta-ms") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --fixed-delta-ms requires a number\n");
                return false;
            }
            options.fixed_delta_seconds = std::strtod(argv[++i], nullptr) / 1000.0;
            if (!(options.fixed_delta_seconds > 0.0)) {
                std::fprintf(stderr, "[app] --fixed-delta-ms must be positive\n");
                return false;
            }
        } else if (std::strcmp(arg, "--show-fps") == 0) {
            options.show_fps_counter = true;
        } else if (std::strcmp(arg, "--demo") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --demo requires none, render2d, rmlui, text, or all\n");
                return false;
            }
            const char* mode = argv[++i];
            if (std::strcmp(mode, "render2d") == 0) {
                options.demo_mode = sandbox::DemoMode::Render2D;
            } else if (std::strcmp(mode, "rmlui") == 0) {
                options.demo_mode = sandbox::DemoMode::RmlUi;
            } else if (std::strcmp(mode, "text") == 0) {
                options.demo_mode = sandbox::DemoMode::Text;
            } else if (std::strcmp(mode, "all") == 0) {
                options.demo_mode = sandbox::DemoMode::All;
            } else if (std::strcmp(mode, "none") == 0) {
                options.demo_mode = sandbox::DemoMode::None;
            } else {
                std::fprintf(stderr, "[app] unknown demo mode: %s\n", mode);
                return false;
            }
        } else if (std::strcmp(arg, "--system-assets") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --system-assets requires a path\n");
                return false;
            }
            options.system_asset_root = argv[++i];
        } else if (std::strcmp(arg, "--project-assets") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --project-assets requires a path\n");
                return false;
            }
            options.project_asset_root = argv[++i];
        } else if (std::strcmp(arg, "--cache-assets") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --cache-assets requires a path\n");
                return false;
            }
            options.cache_asset_root = argv[++i];
        } else if (std::strcmp(arg, "--rmlui-document") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --rmlui-document requires an asset path\n");
                return false;
            }
            options.runtime_ui_document = argv[++i];
        } else if (std::strcmp(arg, "--compiled-project") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --compiled-project requires an asset path\n");
                return false;
            }
            options.compiled_project = argv[++i];
        } else if (std::strcmp(arg, "--skip-title-screen") == 0) {
            options.skip_title_screen = true;
        } else if (std::strcmp(arg, "--run-runtime") == 0) {
            options.run_runtime = true;
        } else if (std::strcmp(arg, "--display-orientation") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr,
                             "[app] --display-orientation requires landscape or portrait\n");
                return false;
            }
            const char* orientation = argv[++i];
            if (std::strcmp(orientation, "landscape") == 0) {
                options.launch_orientation = ScreenOrientation::Landscape;
            } else if (std::strcmp(orientation, "portrait") == 0) {
                options.launch_orientation = ScreenOrientation::Portrait;
            } else {
                std::fprintf(stderr, "[app] invalid display orientation: %s\n", orientation);
                return false;
            }
        } else if (std::strcmp(arg, "--window-size") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --window-size requires WIDTHxHEIGHT\n");
                return false;
            }
            HostSurfaceMetrics surface;
            if (!parse_surface_size(argv[++i], surface)) {
                std::fprintf(stderr, "[app] invalid --window-size value\n");
                return false;
            }
            options.window_width = surface.logical_size.width;
            options.window_height = surface.logical_size.height;
        } else if (std::strcmp(arg, "--screenshot") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --screenshot requires an output path\n");
                return false;
            }
            options.screenshot_path = argv[++i];
        } else if (std::strcmp(arg, "--resize-sequence") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr,
                             "[app] --resize-sequence requires WIDTHxHEIGHT[,WIDTHxHEIGHT...]\n");
                return false;
            }
            if (!parse_resize_sequence(argv[++i], options.resize_sequence)) {
                std::fprintf(stderr, "[app] invalid --resize-sequence value\n");
                return false;
            }
        } else if (std::strcmp(arg, "--resize-interval-frames") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --resize-interval-frames requires a number\n");
                return false;
            }
            options.resize_interval_frames =
                std::max(1u, static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10)));
        } else if (std::strcmp(arg, "--readback-after-resize-frames") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --readback-after-resize-frames requires a number\n");
                return false;
            }
            options.readback_after_resize_frames =
                static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (std::strcmp(arg, "--no-imgui") == 0) {
            options.no_imgui = true;
        } else if (std::strcmp(arg, "--preview-widget") == 0) {
            options.preview_widget = true;
        } else if (std::strcmp(arg, "--render-perf") == 0) {
            options.perf_logging = true;
        } else if (std::strcmp(arg, "--rmlui-base-direct-compat") == 0) {
            options.rmlui_base_direct_compat = true;
        } else if (std::strcmp(arg, "--no-audio") == 0) {
            options.no_audio = true;
        } else if (std::strcmp(arg, "--audio-sfx") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --audio-sfx requires an asset path\n");
                return false;
            }
            options.audio_sfx_paths.push_back(argv[++i]);
        } else if (std::strcmp(arg, "--audio-track") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --audio-track requires TRACK_ID=asset/path\n");
                return false;
            }
            options.audio_track_specs.push_back(argv[++i]);
        }
    }
    return true;
}

bool App::initialize(int argc, char* argv[])
{
    Options options;
    if (!parse_options(argc, argv, options)) {
        return false;
    }

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
    tooling_config.preview_widget = options.preview_widget;
    tooling_config.render_perf_logging = options.perf_logging;
    tooling_config.rmlui_base_direct_compat = options.rmlui_base_direct_compat;
    tooling_config.show_fps_counter = options.show_fps_counter;
    if ((options.demo_mode == sandbox::DemoMode::RmlUi ||
         options.demo_mode == sandbox::DemoMode::All) &&
        tooling_config.runtime_ui_document.empty()) {
        tooling_config.runtime_ui_document = "project:/rmlui/demo.rml";
        if (engine_config.compiled_project.empty()) {
            engine_config.compiled_project = "project:/projects/runtime_phase9_package.ntpkg";
            engine_config.load_title_screen = false;
        }
    }

    if (!EngineTooling::initialize(m_engine, config, engine_config, tooling_config)) {
        std::fprintf(stderr, "[app] engine initialization failed\n");
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
    g_preview_engine = &m_engine;
    g_demo_harness = &m_demo_harness;
    return true;
}

int App::run(int argc, char* argv[])
{
    if (!initialize(argc, argv)) {
        return 1;
    }

#if defined(__EMSCRIPTEN__)
    std::printf("[app] registering Emscripten main loop\n");
    emscripten_set_main_loop_arg(&App::web_tick, this, 0, true);
    return 0;
#else
    const bool resize_readback_fixture =
        !m_options.resize_sequence.empty() && m_options.readback_after_resize_frames > 0;
    int result = 0;
    if (resize_readback_fixture) {
        result = run_resize_readback_fixture();
    } else {
        while (m_engine.is_running()) {
            tick_engine();
        }
    }
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
        if (!EngineTooling::request_screenshot(m_engine, m_options.screenshot_path)) {
            std::fprintf(stderr, "[app] screenshot request was rejected: %s\n",
                         m_options.screenshot_path.c_str());
        }
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
        if (g_preview_engine == &app->m_engine) {
            g_preview_engine = nullptr;
            g_demo_harness = nullptr;
        }
    }
}

} // namespace noveltea

extern "C" {

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_preview_set_demo_position(float x, float y)
{
    if (noveltea::g_demo_harness) {
        noveltea::g_demo_harness->set_position(x, y);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_preview_reset_demo()
{
    if (noveltea::g_demo_harness) {
        noveltea::g_demo_harness->reset_position();
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_preview_set_running(int running)
{
    if (noveltea::g_preview_engine) {
        noveltea::EngineTooling::set_preview_running(*noveltea::g_preview_engine, running != 0);
        noveltea::emit_preview_state();
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_engine_set_show_fps_counter(int show)
{
    if (noveltea::g_preview_engine) {
        noveltea::EngineTooling::set_show_fps_counter(*noveltea::g_preview_engine, show != 0);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_engine_set_fps_cap(int frames_per_second)
{
    if (noveltea::g_preview_engine) {
        noveltea::EngineTooling::set_fps_cap(
            *noveltea::g_preview_engine,
            frames_per_second > 0 ? static_cast<uint32_t>(frames_per_second) : 0u);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_preview_load_rml_document(const char* rml)
{
    if (!noveltea::g_preview_engine || !rml) {
        return 0;
    }
    return noveltea::EngineTooling::preview(*noveltea::g_preview_engine).load_document(rml) ? 1 : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_preview_execute_lua_script(const char* source)
{
    if (!noveltea::g_preview_engine || !source) {
        return 0;
    }
    return noveltea::EngineTooling::preview(*noveltea::g_preview_engine).execute_lua(source) ? 1
                                                                                             : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_preview_show_editor_document(const char* kind, const char* data_json)
{
    if (!noveltea::g_preview_engine || !kind || !data_json) {
        return 0;
    }
    auto decoded = noveltea::core::editor::decode_editor_preview_document_text(kind, data_json);
    if (!decoded) {
        noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
            .report_diagnostics(std::move(decoded).error());
        return 0;
    }
    return noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
                   .apply_editor_document(std::move(*decoded.value_if()))
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_load_project(const char* logical_path)
{
    if (!noveltea::g_preview_engine || !logical_path) {
        return 0;
    }
    return noveltea::EngineTooling::preview(*noveltea::g_preview_engine).load_project(logical_path)
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_reset()
{
    return noveltea::g_preview_engine &&
                   noveltea::EngineTooling::preview(*noveltea::g_preview_engine).reset()
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_start()
{
    if (!noveltea::g_preview_engine)
        return 0;
    const bool accepted = noveltea::EngineTooling::preview(*noveltea::g_preview_engine).start();
    noveltea::emit_preview_state();
    return accepted ? 1 : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_stop()
{
    if (!noveltea::g_preview_engine)
        return 0;
    const bool accepted = noveltea::EngineTooling::preview(*noveltea::g_preview_engine).stop();
    noveltea::emit_preview_state();
    return accepted ? 1 : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_step(double delta_seconds)
{
    return noveltea::g_preview_engine &&
                   noveltea::EngineTooling::preview(*noveltea::g_preview_engine).step(delta_seconds)
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_continue()
{
    return noveltea::g_preview_engine &&
                   noveltea::EngineTooling::preview(*noveltea::g_preview_engine).continue_dialogue()
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_dialogue_option(int option_index)
{
    return noveltea::g_preview_engine &&
                   noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
                       .select_dialogue_option(option_index)
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_navigate(int direction)
{
    return noveltea::g_preview_engine &&
                   noveltea::EngineTooling::preview(*noveltea::g_preview_engine).navigate(direction)
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_select_subjects(const char* subjects_json)
{
    if (!noveltea::g_preview_engine || !subjects_json)
        return 0;
    auto subjects = noveltea::core::editor::decode_editor_interaction_subjects_text(subjects_json);
    if (!subjects) {
        noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
            .report_diagnostics(std::move(subjects).error());
        return 0;
    }
    return noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
                   .select_subjects(std::move(*subjects.value_if()))
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_clear_subject_selection()
{
    return noveltea::g_preview_engine &&
                   noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
                       .clear_subject_selection()
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_run_interaction(const char* verb_id, const char* operands_json)
{
    if (!noveltea::g_preview_engine || !verb_id) {
        return 0;
    }
    auto operands = noveltea::core::editor::decode_editor_interaction_subjects_text(
        operands_json ? operands_json : "[]");
    if (!operands) {
        noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
            .report_diagnostics(std::move(operands).error());
        return 0;
    }
    return noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
                   .run_interaction(verb_id, std::move(*operands.value_if()))
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
const char* noveltea_runtime_set_variable(const char* variable_id, const char* value_json)
{
    static std::string event_json;
    event_json.clear();
    if (!noveltea::g_preview_engine || !variable_id || !value_json) {
        return event_json.c_str();
    }
    auto value = noveltea::core::editor::decode_editor_runtime_value_text(value_json);
    if (!value) {
        noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
            .report_diagnostics(std::move(value).error());
        return event_json.c_str();
    }
    event_json = noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
                     .set_variable(variable_id, std::move(*value.value_if()));
    return event_json.c_str();
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
const char* noveltea_runtime_reset_variable(const char* variable_id)
{
    static std::string event_json;
    event_json.clear();
    if (!noveltea::g_preview_engine || !variable_id) {
        return event_json.c_str();
    }
    event_json =
        noveltea::EngineTooling::preview(*noveltea::g_preview_engine).reset_variable(variable_id);
    return event_json.c_str();
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
const char* noveltea_runtime_give_object(const char* object_id)
{
    static std::string event_json;
    event_json.clear();
    if (!noveltea::g_preview_engine || !object_id) {
        return event_json.c_str();
    }
    event_json =
        noveltea::EngineTooling::preview(*noveltea::g_preview_engine).give_object(object_id);
    return event_json.c_str();
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
const char* noveltea_runtime_remove_inventory_object(const char* object_id)
{
    static std::string event_json;
    event_json.clear();
    if (!noveltea::g_preview_engine || !object_id) {
        return event_json.c_str();
    }
    event_json = noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
                     .remove_inventory_object(object_id);
    return event_json.c_str();
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
const char* noveltea_runtime_teleport_room(const char* room_id)
{
    static std::string event_json;
    event_json.clear();
    if (!noveltea::g_preview_engine || !room_id) {
        return event_json.c_str();
    }
    event_json =
        noveltea::EngineTooling::preview(*noveltea::g_preview_engine).teleport_room(room_id);
    return event_json.c_str();
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
const char* noveltea_runtime_debug_snapshot()
{
    static std::string snapshot;
    if (!noveltea::g_preview_engine) {
        snapshot.clear();
        return snapshot.c_str();
    }
    snapshot = noveltea::EngineTooling::preview(*noveltea::g_preview_engine).debug_snapshot();
    return snapshot.c_str();
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
const char* noveltea_runtime_fast_forward_to_input()
{
    static std::string result_json;
    if (!noveltea::g_preview_engine) {
        result_json.clear();
        return result_json.c_str();
    }
    result_json =
        noveltea::EngineTooling::preview(*noveltea::g_preview_engine).fast_forward_to_input();
    return result_json.c_str();
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_preview_resize(int logical_width, int logical_height, int framebuffer_width,
                             int framebuffer_height, float host_logical_to_framebuffer_scale_x,
                             float host_logical_to_framebuffer_scale_y)
{
    if (noveltea::g_preview_engine) {
        auto surface = noveltea::make_host_surface_metrics(logical_width, logical_height,
                                                           framebuffer_width, framebuffer_height);
        surface.logical_to_framebuffer_scale = {host_logical_to_framebuffer_scale_x,
                                                host_logical_to_framebuffer_scale_y};
        surface = noveltea::sanitize_host_surface_metrics(surface);
#if defined(__EMSCRIPTEN__)
        emscripten_set_canvas_element_size("#canvas", surface.framebuffer_size.width,
                                           surface.framebuffer_size.height);
#endif
        std::printf("[surface] web_resize host.logical=%dx%d host.framebuffer=%dx%d "
                    "host.logical_to_framebuffer=(%.3f,%.3f)\n",
                    surface.logical_size.width, surface.logical_size.height,
                    surface.framebuffer_size.width, surface.framebuffer_size.height,
                    surface.logical_to_framebuffer_scale.x, surface.logical_to_framebuffer_scale.y);
        noveltea::g_preview_engine->resize(surface);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_audio_play_sfx(const char* path, float volume, float pitch)
{
    if (noveltea::g_preview_engine && path) {
        (void)noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
            .play_audio_sfx(path, volume, pitch);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_audio_play_track(const char* track_id, const char* path, float volume, int loop)
{
    if (noveltea::g_preview_engine && track_id && path) {
        (void)noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
            .play_audio_track(track_id, path, volume, loop != 0);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_audio_stop_track(const char* track_id, float fade_seconds)
{
    if (noveltea::g_preview_engine && track_id) {
        noveltea::EngineTooling::preview(*noveltea::g_preview_engine)
            .stop_audio_track(track_id, fade_seconds);
    }
}
}
