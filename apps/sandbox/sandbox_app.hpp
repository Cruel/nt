#pragma once

#include "sandbox_demo_harness.hpp"

#include <noveltea/engine.hpp>

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
        double fixed_delta_seconds = 0.0;
        sandbox::DemoMode demo_mode = sandbox::DemoMode::None;
        std::filesystem::path system_asset_root;
        std::filesystem::path project_asset_root;
        std::filesystem::path cache_asset_root;
        std::string runtime_ui_document;
        std::string compiled_project;
        std::string postprocess_material;
        bool skip_title_screen = false;
        bool run_runtime = false;
        ScreenOrientation launch_orientation = ScreenOrientation::Landscape;
        int window_width = 0;
        int window_height = 0;
        std::string screenshot_path;
        std::vector<HostSurfaceMetrics> resize_sequence;
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
    bool tick_engine();
    int run_resize_readback_fixture();
    static void web_tick(void* user_data);

    Engine m_engine;
    sandbox::SandboxDemoHarness m_demo_harness{m_engine};
    Options m_options;
    uint32_t m_submitted_frames = 0;
};

} // namespace noveltea
