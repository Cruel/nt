#include "noveltea/app.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <exception>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#endif

namespace noveltea {

namespace {
Engine* g_preview_engine = nullptr;

bool parse_surface_size(const std::string& token, SurfaceMetrics& surface)
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
    surface.logical_width = int(width);
    surface.logical_height = int(height);
    surface.framebuffer_width = int(width);
    surface.framebuffer_height = int(height);
    surface.scale_x = 1.0f;
    surface.scale_y = 1.0f;
    return true;
}

bool parse_resize_sequence(const char* value, std::vector<SurfaceMetrics>& sequence)
{
    sequence.clear();
    std::string text = value ? value : "";
    size_t begin = 0;
    while (begin <= text.size()) {
        const size_t comma = text.find(',', begin);
        const size_t end = comma == std::string::npos ? text.size() : comma;
        const std::string token = text.substr(begin, end - begin);
        SurfaceMetrics surface;
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

App::~App() { m_engine.shutdown(); }

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
        } else if (std::strcmp(arg, "--show-fps") == 0) {
            options.show_fps_counter = true;
        } else if (std::strcmp(arg, "--demo") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --demo requires none, render2d, rmlui, text, or all\n");
                return false;
            }
            const char* mode = argv[++i];
            if (std::strcmp(mode, "render2d") == 0) {
                options.demo_mode = DemoMode::Render2D;
            } else if (std::strcmp(mode, "rmlui") == 0) {
                options.demo_mode = DemoMode::RmlUi;
            } else if (std::strcmp(mode, "text") == 0) {
                options.demo_mode = DemoMode::Text;
            } else if (std::strcmp(mode, "all") == 0) {
                options.demo_mode = DemoMode::All;
            } else if (std::strcmp(mode, "none") == 0) {
                options.demo_mode = DemoMode::None;
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
        } else if (std::strcmp(arg, "--runtime-project") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --runtime-project requires an asset path\n");
                return false;
            }
            options.runtime_project = argv[++i];
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

    EngineRunConfig run_config;
    run_config.frame_limit = options.frame_limit;
    run_config.fps_cap = options.fps_cap;
    run_config.demo_mode = options.demo_mode;
    run_config.system_asset_root = options.system_asset_root;
    run_config.project_asset_root = options.project_asset_root;
    run_config.cache_asset_root = options.cache_asset_root;
    run_config.runtime_ui_document = options.runtime_ui_document;
    run_config.runtime_project = options.runtime_project;
    const bool resize_readback_fixture =
        !options.resize_sequence.empty() && options.readback_after_resize_frames > 0;
    if (resize_readback_fixture && options.frame_limit == 0) {
        const uint32_t interval = std::max(1u, options.resize_interval_frames);
        const uint32_t resize_frame_count =
            uint32_t((options.resize_sequence.size() - 1u) * interval + 1u);
        run_config.frame_limit = resize_frame_count + options.readback_after_resize_frames;
    }
    run_config.screenshot_path = options.screenshot_path;
    run_config.enable_debug_ui = !options.no_imgui;
    run_config.preview_widget = options.preview_widget;
    run_config.render_perf_logging = options.perf_logging;
    run_config.rmlui_base_direct_compat = options.rmlui_base_direct_compat;
    run_config.enable_audio = !options.no_audio;
    run_config.show_fps_counter = options.show_fps_counter;
    run_config.audio_sfx_paths = options.audio_sfx_paths;
    run_config.audio_track_specs = options.audio_track_specs;

    if (!m_engine.initialize(config, run_config)) {
        std::fprintf(stderr, "[app] engine initialization failed\n");
        return false;
    }

    m_options = std::move(options);
    g_preview_engine = &m_engine;
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
    const int result = resize_readback_fixture ? run_resize_readback_fixture() : m_engine.run();
    m_engine.shutdown();
    return result;
#endif
}

int App::run_resize_readback_fixture()
{
    const uint32_t interval = std::max(1u, m_options.resize_interval_frames);
    uint32_t countdown = 0;
    size_t resize_index = 0;
    while (m_engine.is_running()) {
        if (resize_index < m_options.resize_sequence.size()) {
            if (countdown == 0) {
                SurfaceMetrics scheduled =
                    sanitize_surface_metrics(m_options.resize_sequence[resize_index++]);
                std::printf("[app] applying resize-readback fixture resize %zu/%zu: logical=%dx%d "
                            "framebuffer=%dx%d\n",
                            resize_index, m_options.resize_sequence.size(), scheduled.logical_width,
                            scheduled.logical_height, scheduled.framebuffer_width,
                            scheduled.framebuffer_height);
                m_engine.resize(scheduled);
                countdown = interval - 1u;
            } else {
                --countdown;
            }
        }
        m_engine.tick();
    }
    return 0;
}

void App::web_tick(void* user_data)
{
    auto* app = static_cast<App*>(user_data);
    if (!app->m_engine.tick()) {
#if defined(__EMSCRIPTEN__)
        emscripten_cancel_main_loop();
#endif
        app->m_engine.shutdown();
        if (g_preview_engine == &app->m_engine) {
            g_preview_engine = nullptr;
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
    if (noveltea::g_preview_engine) {
        noveltea::g_preview_engine->set_demo_position(x, y);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_preview_reset_demo()
{
    if (noveltea::g_preview_engine) {
        noveltea::g_preview_engine->reset_demo_position();
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_preview_set_running(int running)
{
    if (noveltea::g_preview_engine) {
        noveltea::g_preview_engine->set_preview_running(running != 0);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_engine_set_show_fps_counter(int show)
{
    if (noveltea::g_preview_engine) {
        noveltea::g_preview_engine->set_show_fps_counter(show != 0);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_engine_set_fps_cap(int frames_per_second)
{
    if (noveltea::g_preview_engine) {
        noveltea::g_preview_engine->set_fps_cap(
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
    return noveltea::g_preview_engine->load_preview_rml_document(rml) ? 1 : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_preview_execute_lua_script(const char* source)
{
    if (!noveltea::g_preview_engine || !source) {
        return 0;
    }
    return noveltea::g_preview_engine->execute_preview_lua_script(source) ? 1 : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_preview_show_editor_document(const char* kind, const char* data_json)
{
    if (!noveltea::g_preview_engine || !kind || !data_json) {
        return 0;
    }
    return noveltea::g_preview_engine->apply_editor_preview_document(kind, data_json) ? 1 : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_preview_set_display_profile(int width, int height, int portrait,
                                         unsigned int bar_color_rgba, int clear_override)
{
    if (!noveltea::g_preview_engine) {
        return 0;
    }
    if (clear_override) {
        noveltea::g_preview_engine->set_preview_display_override(std::nullopt);
        return 1;
    }
    if (width <= 0 || height <= 0 || width > 10000 || height > 10000) {
        return 0;
    }
    noveltea::DisplayProfile profile;
    profile.aspect_ratio = noveltea::normalize_aspect_ratio(
        {static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height)});
    profile.orientation =
        portrait ? noveltea::ScreenOrientation::Portrait : noveltea::ScreenOrientation::Landscape;
    profile.bar_color_rgba = bar_color_rgba;
    noveltea::g_preview_engine->set_preview_display_override(profile);
    return 1;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_load_project(const char* logical_path)
{
    if (!noveltea::g_preview_engine || !logical_path) {
        return 0;
    }
    return noveltea::g_preview_engine->runtime_preview().load_project(logical_path) ? 1 : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_reset()
{
    return noveltea::g_preview_engine && noveltea::g_preview_engine->runtime_preview().reset() ? 1
                                                                                               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_start()
{
    return noveltea::g_preview_engine && noveltea::g_preview_engine->runtime_preview().start() ? 1
                                                                                               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_stop()
{
    return noveltea::g_preview_engine && noveltea::g_preview_engine->runtime_preview().stop() ? 1
                                                                                              : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_step(double delta_seconds)
{
    return noveltea::g_preview_engine &&
                   noveltea::g_preview_engine->runtime_preview().step(delta_seconds)
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_continue()
{
    return noveltea::g_preview_engine &&
                   noveltea::g_preview_engine->runtime_preview().continue_dialogue()
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_dialogue_option(int option_index)
{
    return noveltea::g_preview_engine &&
                   noveltea::g_preview_engine->runtime_preview().select_dialogue_option(
                       option_index)
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_navigate(int direction)
{
    return noveltea::g_preview_engine &&
                   noveltea::g_preview_engine->runtime_preview().navigate(direction)
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_select_object(const char* object_id)
{
    return noveltea::g_preview_engine && object_id &&
                   noveltea::g_preview_engine->runtime_preview().select_object(object_id)
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_clear_object_selection()
{
    return noveltea::g_preview_engine &&
                   noveltea::g_preview_engine->runtime_preview().clear_object_selection()
               ? 1
               : 0;
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
int noveltea_runtime_run_action(const char* verb_id, const char* object_ids_json)
{
    if (!noveltea::g_preview_engine || !verb_id || !object_ids_json) {
        return 0;
    }
    std::vector<std::string> object_ids;
    try {
        const auto parsed = nlohmann::json::parse(object_ids_json);
        if (!parsed.is_array()) {
            return 0;
        }
        for (const auto& value : parsed) {
            if (!value.is_string()) {
                return 0;
            }
            object_ids.push_back(value.get<std::string>());
        }
    } catch (const std::exception&) {
        return 0;
    }
    return noveltea::g_preview_engine->runtime_preview().run_action(verb_id, object_ids) ? 1 : 0;
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
    event_json =
        noveltea::g_preview_engine->runtime_preview().set_variable(variable_id, value_json);
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
    event_json = noveltea::g_preview_engine->runtime_preview().reset_variable(variable_id);
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
    event_json = noveltea::g_preview_engine->runtime_preview().give_object(object_id);
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
    event_json = noveltea::g_preview_engine->runtime_preview().remove_inventory_object(object_id);
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
    event_json = noveltea::g_preview_engine->runtime_preview().teleport_room(room_id);
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
    snapshot = noveltea::g_preview_engine->runtime_preview().debug_snapshot();
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
    result_json = noveltea::g_preview_engine->runtime_preview().fast_forward_to_input();
    return result_json.c_str();
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_preview_resize(int logical_width, int logical_height, int framebuffer_width,
                             int framebuffer_height, float scale_x, float scale_y)
{
    if (noveltea::g_preview_engine) {
        noveltea::SurfaceMetrics surface{
            logical_width, logical_height, framebuffer_width, framebuffer_height, scale_x, scale_y,
        };
        surface = noveltea::make_surface_metrics(logical_width, logical_height, framebuffer_width,
                                                 framebuffer_height);
#if defined(__EMSCRIPTEN__)
        emscripten_set_canvas_element_size("#canvas", surface.framebuffer_width,
                                           surface.framebuffer_height);
#endif
        std::printf("[surface] web_resize logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
                    surface.logical_width, surface.logical_height, surface.framebuffer_width,
                    surface.framebuffer_height, surface.scale_x, surface.scale_y);
        noveltea::g_preview_engine->resize(surface);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_audio_play_sfx(const char* path, float volume, float pitch)
{
    if (noveltea::g_preview_engine && path) {
        (void)noveltea::g_preview_engine->play_audio_sfx(path, volume, pitch);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_audio_play_track(const char* track_id, const char* path, float volume, int loop)
{
    if (noveltea::g_preview_engine && track_id && path) {
        (void)noveltea::g_preview_engine->play_audio_track(track_id, path, volume, loop != 0);
    }
}

#if defined(__EMSCRIPTEN__)
EMSCRIPTEN_KEEPALIVE
#endif
void noveltea_audio_stop_track(const char* track_id, float fade_seconds)
{
    if (noveltea::g_preview_engine && track_id) {
        noveltea::g_preview_engine->stop_audio_track(track_id, fade_seconds);
    }
}
}
