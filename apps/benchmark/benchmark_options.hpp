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
    bool vsync = false;
    bool help = false;
    std::string output_path;
};

bool parse_options(int argc, const char* const argv[], Options& options, std::string& error);

struct FrameSummary {
    uint64_t frames = 0;
    double total_bgfx_call_seconds = 0.0;
    double min_bgfx_call_seconds = 0.0;
    double max_bgfx_call_seconds = 0.0;

    void record(double bgfx_call_seconds);
    [[nodiscard]] double mean_bgfx_call_ms() const;
};

} // namespace noveltea::benchmark
