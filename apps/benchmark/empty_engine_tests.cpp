#include "empty_engine.hpp"

#include "benchmark_runner.hpp"

#include <SDL3/SDL.h>

#include <cstdio>
#include <filesystem>
#include <string>

namespace {

struct SteadyClock final : noveltea::benchmark::Clock {
    double now_seconds() override
    {
        return static_cast<double>(SDL_GetPerformanceCounter()) /
               static_cast<double>(SDL_GetPerformanceFrequency());
    }
};

bool check(bool value, const char* message)
{
    if (!value)
        std::fprintf(stderr, "empty Engine integration: %s\n", message);
    return value;
}

} // namespace

int main()
{
    using namespace noveltea::benchmark;

    Options options;
    options.scenario = "engine-empty";
    options.warmup_seconds = 0;
    options.measurement_frames = 3;
    options.repeats = 2;
    SteadyClock clock;

    // Real Engine lifetimes in one process, followed by an intentional
    // failed initialization and another successful owner acquisition.
    EmptyEngine healthy;
    auto initial = run_suite(options, {&healthy}, clock);
    if (!check(initial.outcome == "complete" && initial.scenarios.front().measured_frames == 6 &&
                   initial.scenarios.front().trials.size() == 2 &&
                   initial.scenarios.front().trials[0].outcome == "complete" &&
                   initial.scenarios.front().trials[1].outcome == "complete" &&
                   healthy.environment().frame_path == "engine-tick" &&
                   !healthy.environment().renderer.empty() &&
                   healthy.environment().width_pixels > 0 &&
                   healthy.environment().height_pixels > 0 &&
                   healthy.environment().engine_postprocess_active.has_value(),
               "two real Engine trials must fully initialize, frame and release"))
        return 1;

    EmptyEngine broken(std::filesystem::path("/nonexistent/noveltea-benchmark-system-assets"));
    options.repeats = 1;
    auto failed = run_suite(options, {&broken}, clock);
    if (!check(failed.outcome == "failed" && !failed.scenarios.front().trials[0].reason.empty() &&
                   failed.scenarios.front().trials[0].measured_frames == 0 &&
                   failed.scenarios.front().trials[0].outcome == "failed",
               "missing system bootstrap must fail before timing, not fabricate samples"))
        return 1;

    auto recovered = run_suite(options, {&healthy}, clock);
    return check(recovered.outcome == "complete" &&
                     recovered.scenarios.front().measured_frames == 3,
                 "Engine must recover from failed preparation in the same process")
               ? 0
               : 1;
}
