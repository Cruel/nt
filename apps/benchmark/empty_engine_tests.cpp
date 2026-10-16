#include "empty_engine.hpp"
#include "integrated_rmlui.hpp"

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

// Inject a real SDL Escape event after the production Engine has initialized.
// The Engine itself must request shutdown, and the benchmark adapter must
// distinguish that from an unexpected frame/renderer failure.
struct EscapeDuringRun final : noveltea::benchmark::Scenario {
    noveltea::benchmark::Scenario& delegate;
    int escape_frame = 1;
    int frames = 0;
    int prepares = 0;
    EscapeDuringRun(noveltea::benchmark::Scenario& target, int inject_at)
        : delegate(target), escape_frame(inject_at)
    {
    }

    const char* id() const override { return delegate.id(); }
    const char* description() const override { return delegate.description(); }
    bool requires_graphics() const override { return delegate.requires_graphics(); }
    bool prepare(const noveltea::benchmark::Options& options, std::string& reason) override
    {
        ++prepares;
        frames = 0;
        return delegate.prepare(options, reason);
    }
    noveltea::benchmark::Readiness readiness(std::string& reason) override
    {
        return delegate.readiness(reason);
    }
    bool frame(std::string& reason) override
    {
        if (++frames == escape_frame) {
            SDL_Event escape{};
            escape.type = SDL_EVENT_KEY_DOWN;
            escape.key.key = SDLK_ESCAPE;
            escape.key.scancode = SDL_SCANCODE_ESCAPE;
            if (!SDL_PushEvent(&escape)) {
                reason = "cannot inject Escape into Engine";
                return false;
            }
        }
        return delegate.frame(reason);
    }
    bool complete(std::string& reason) override { return delegate.complete(reason); }
    bool cleanup(std::string& reason) override { return delegate.cleanup(reason); }
    noveltea::benchmark::Interruption interruption() const override
    {
        return delegate.interruption();
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
                   failed.scenarios.front().trials[0].outcome == "failed" &&
                   broken.interruption() == Interruption::None,
               "missing system bootstrap must fail before timing, not fabricate samples"))
        return 1;

    auto recovered = run_suite(options, {&healthy}, clock);
    if (!check(recovered.outcome == "complete" && recovered.scenarios.front().measured_frames == 3,
               "Engine must recover from failed preparation in the same process"))
        return 1;

    // Escape during both warmup and measurement must cancel all repeats and
    // never start the next Quick Suite scenario. Exercise both real adapters.
    for (const char* id :
         {"engine-empty", "integrated-rmlui-controlled", "integrated-rmlui-production"}) {
        for (const bool during_warmup : {true, false}) {
            EmptyEngine empty;
            IntegratedRmlUi controlled(true);
            IntegratedRmlUi production(false);
            Scenario& target = std::string(id) == "engine-empty" ? static_cast<Scenario&>(empty)
                               : std::string(id) == "integrated-rmlui-controlled"
                                   ? static_cast<Scenario&>(controlled)
                                   : static_cast<Scenario&>(production);
            EscapeDuringRun interrupt{target, during_warmup ? 1 : 2};
            Options cancel_options = options;
            cancel_options.scenario = id;
            cancel_options.repeats = 2;
            cancel_options.warmup_seconds = during_warmup ? 0.2 : 0.0;
            cancel_options.measurement_frames = 20;
            EmptyEngine next_scenario;
            const auto cancelled = run_suite(cancel_options, {&interrupt, &next_scenario}, clock);
            if (!check(cancelled.outcome == "cancelled" && cancelled.scenarios.size() == 1 &&
                           interrupt.prepares == 1 && cancelled.scenarios[0].trials.size() == 1 &&
                           cancelled.scenarios[0].trials[0].outcome == "cancelled" &&
                           cancelled.scenarios[0].trials[0].reason.find("host quit") !=
                               std::string::npos &&
                           cancelled.scenarios[0].measured_frames == 0 &&
                           target.interruption() == Interruption::Cancelled,
                       "Escape must cancel real Engine, not start another trial or scenario"))
                return 1;
        }
    }
    return 0;
}
