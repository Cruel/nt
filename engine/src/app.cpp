#include "noveltea/app.hpp"

#include <cstdlib>
#include <cstdio>
#include <cstring>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#endif

namespace noveltea {

namespace {
Engine* g_preview_engine = nullptr;
}

App::~App()
{
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
        } else if (std::strcmp(arg, "--screenshot") == 0) {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "[app] --screenshot requires an output path\n");
                return false;
            }
            options.screenshot_path = argv[++i];
        } else if (std::strcmp(arg, "--no-imgui") == 0) {
            options.no_imgui = true;
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

    EngineRunConfig run_config;
    run_config.frame_limit = options.frame_limit;
    run_config.demo_mode = options.demo_mode;
    run_config.system_asset_root = options.system_asset_root;
    run_config.project_asset_root = options.project_asset_root;
    run_config.cache_asset_root = options.cache_asset_root;
    run_config.runtime_ui_document = options.runtime_ui_document;
    run_config.screenshot_path = options.screenshot_path;
    run_config.enable_debug_ui = !options.no_imgui;

    if (!m_engine.initialize(config, run_config)) {
        std::fprintf(stderr, "[app] engine initialization failed\n");
        return false;
    }

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
    const int result = m_engine.run();
    m_engine.shutdown();
    return result;
#endif
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
void noveltea_preview_resize(
    int logical_width,
    int logical_height,
    int framebuffer_width,
    int framebuffer_height,
    float scale_x,
    float scale_y)
{
    if (noveltea::g_preview_engine) {
        noveltea::SurfaceMetrics surface{
            logical_width,
            logical_height,
            framebuffer_width,
            framebuffer_height,
            scale_x,
            scale_y,
        };
        surface = noveltea::make_surface_metrics(
            logical_width,
            logical_height,
            framebuffer_width,
            framebuffer_height);
#if defined(__EMSCRIPTEN__)
        emscripten_set_canvas_element_size("#canvas", surface.framebuffer_width, surface.framebuffer_height);
#endif
        std::printf("[surface] web_resize logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
            surface.logical_width,
            surface.logical_height,
            surface.framebuffer_width,
            surface.framebuffer_height,
            surface.scale_x,
            surface.scale_y);
        noveltea::g_preview_engine->resize(surface);
    }
}

}
