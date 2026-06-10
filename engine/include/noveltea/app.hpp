#pragma once

#include "engine.hpp"

namespace noveltea {

class App {
public:
    App() = default;
    ~App() = default;

    int run(int argc, char* argv[]);

private:
    Engine m_engine;
};

} // namespace noveltea
