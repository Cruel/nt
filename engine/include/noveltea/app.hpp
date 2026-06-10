#pragma once

#include "engine.hpp"

namespace noveltea {

class App {
public:
    App() = default;
    ~App();

    int run(int argc, char* argv[]);

private:
    bool initialize(int argc, char* argv[]);
    static void web_tick(void* user_data);

    Engine m_engine;
};

} // namespace noveltea
