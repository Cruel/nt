#pragma once

#include <cstdint>
#include <string>

namespace noveltea::benchmark {

struct Options {
    int width = 1280;
    int height = 720;
    double warmup_seconds = 3.0;
    double duration_seconds = 10.0;
    uint64_t measurement_frames = 0; // Zero selects duration-based measurement.
    uint32_t repeats = 1;
    double ready_timeout_seconds = 5.0;
    bool raw_samples = false;
    bool no_ui = true;
    std::string profile = "clean";
    bool vsync = false;
    bool help = false;
    bool dashboard_smoke = false;
    bool quick_suite = false;
    bool dashboard_visual_smoke = false;
    std::string scenario = "raw-bgfx-empty";
    uint32_t rect_count = 3;
    double rect_scale = 1.0;
    std::string output_path;
    std::string config_path;
};

bool parse_options(int argc, const char* const argv[], Options& options, std::string& error);
// App-specific reference selection; the portable runner accepts other Scenario IDs.
[[nodiscard]] bool validate_reference_options(const Options& options, std::string& reason);

} // namespace noveltea::benchmark
