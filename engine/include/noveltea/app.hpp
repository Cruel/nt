#pragma once

#include "engine.hpp"

#include <filesystem>
#include <string>
#include <vector>

namespace noveltea {

class App {
public:
    App() = default;
    ~App();

    int run(int argc, char* argv[]);

private:
    struct Options {
        uint32_t frame_limit = 0;
        uint32_t fps_cap = 0;
        DemoMode demo_mode = DemoMode::None;
        std::filesystem::path system_asset_root;
        std::filesystem::path project_asset_root;
        std::filesystem::path cache_asset_root;
        std::string runtime_ui_document;
        std::string runtime_project;
        ScreenOrientation launch_orientation = ScreenOrientation::Landscape;
        std::string screenshot_path;
        std::vector<SurfaceMetrics> resize_sequence;
        uint32_t resize_interval_frames = 1;
        uint32_t readback_after_resize_frames = 0;
        bool no_imgui = false;
        bool preview_widget = false;
        bool perf_logging = false;
        bool rmlui_base_direct_compat = false;
        bool no_audio = false;
        bool show_fps_counter = false;
        std::vector<std::string> audio_sfx_paths;
        std::vector<std::string> audio_track_specs;
    };

    bool initialize(int argc, char* argv[]);
    bool parse_options(int argc, char* argv[], Options& options) const;
    int run_resize_readback_fixture();
    static void web_tick(void* user_data);

    Engine m_engine;
    Options m_options;
};

} // namespace noveltea
