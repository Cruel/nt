#pragma once

#include "engine.hpp"

#include <filesystem>
#include <string>

namespace noveltea {

class App {
public:
    App() = default;
    ~App();

    int run(int argc, char* argv[]);

private:
    struct Options {
        uint32_t frame_limit = 0;
        DemoMode demo_mode = DemoMode::All;
        std::filesystem::path system_asset_root;
        std::filesystem::path project_asset_root;
        std::filesystem::path cache_asset_root;
        std::string runtime_ui_document;
        std::string screenshot_path;
        bool no_imgui = false;
    };

    bool initialize(int argc, char* argv[]);
    bool parse_options(int argc, char* argv[], Options& options) const;
    static void web_tick(void* user_data);

    Engine m_engine;
};

} // namespace noveltea
