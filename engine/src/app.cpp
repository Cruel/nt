#include "noveltea/app.hpp"

#include <cstdio>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif

namespace noveltea {

App::~App()
{
    m_engine.shutdown();
}

bool App::initialize(int argc, char* argv[])
{
    (void)argc;
    (void)argv;

    PlatformConfig config;
    config.title = "NovelTea Sandbox";

    if (!m_engine.initialize(config)) {
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
    return m_engine.run();
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
