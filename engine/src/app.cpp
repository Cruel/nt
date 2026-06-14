#include "noveltea/app.hpp"

#include <cstdlib>
#include <cstdio>
#include <cstring>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif

namespace noveltea {

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
                std::fprintf(stderr, "[app] --demo requires render2d, rmlui, text, or all\n");
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
            } else {
                std::fprintf(stderr, "[app] unknown demo mode: %s\n", mode);
                return false;
            }
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

    if (!m_engine.initialize(config, run_config)) {
        std::fprintf(stderr, "[app] engine initialization failed\n");
        return false;
    }

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
    }
}

} // namespace noveltea
