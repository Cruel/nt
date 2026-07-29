#pragma once

#include <noveltea/engine.hpp>

namespace noveltea::editor_preview {

void set_host_active(bool active);

class App {
public:
    ~App();
    int run(int argc, char* argv[]);

private:
    bool initialize(int argc, char* argv[]);
    bool tick_engine();
    static void web_tick(void* user_data);

    Engine m_engine;
};

} // namespace noveltea::editor_preview
