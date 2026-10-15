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
    std::string scenario = "raw-bgfx-empty";
    std::string output_path;
    std::string config_path;
};

bool parse_options(int argc, const char* const argv[], Options& options, std::string& error);

} // namespace noveltea::benchmark
