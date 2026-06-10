#include "noveltea/app.hpp"

#include <cstdio>

namespace noveltea {

int App::run(int argc, char* argv[])
{
    (void)argc;
    (void)argv;

    PlatformConfig config;
    config.title = "NovelTea Sandbox";

    if (!m_engine.initialize(config)) {
        std::fprintf(stderr, "[app] engine initialization failed\n");
        return 1;
    }

    int exit_code = m_engine.run();
    m_engine.shutdown();
    return exit_code;
}

} // namespace noveltea
