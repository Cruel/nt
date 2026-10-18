#include "benchmark_runner.hpp"
#include "benchmark_options.hpp"

#include <cstdio>
#include <string>
#include <utility>
#include <vector>

using namespace noveltea::benchmark;

namespace {
struct FakeClock final : Clock {
    double time = 1.0;
    double now_seconds() override { return time; }
};

struct Synthetic final : Scenario {
    std::string name;
    FakeClock& clock;
    std::vector<std::string>& events;
    bool fail = false;
    Synthetic(std::string id, FakeClock& time, std::vector<std::string>& log, bool fails = false)
        : name(std::move(id)), clock(time), events(log), fail(fails)
    {
    }
    const char* id() const override { return name.c_str(); }
    const char* description() const override { return "controlled suite lifecycle"; }
    bool requires_graphics() const override { return false; }
    bool prepare(const Options&, std::string& reason) override
    {
        events.push_back(name + ".prepare");
        if (fail)
            reason = "synthetic startup failed";
        return !fail;
    }
    Readiness readiness(std::string&) override { return Readiness::Ready; }
    bool frame(std::string&) override
    {
        clock.time += 0.01;
        return true;
    }
    bool complete(std::string&) override { return true; }
    bool cleanup(std::string&) override
    {
        events.push_back(name + ".cleanup");
        return true;
    }
};

bool check(bool condition, const char* why)
{
    if (!condition)
        std::fprintf(stderr, "benchmark suite test failed: %s\n", why);
    return condition;
}
} // namespace

int main()
{
    const auto& manifest = quick_suite_scenarios();
    if (!check(manifest == std::vector<std::string>{"raw-bgfx-empty", "raw-bgfx-geometry",
                                                    "standalone-rmlui-simple", "engine-empty",
                                                    "integrated-rmlui-controlled",
                                                    "integrated-rmlui-production"},
               "fixed comparison order"))
        return 1;

    Options non_default;
    non_default.scenario = "raw-bgfx-composition";
    non_default.composition_path = "offscreen";
    non_default.composite_passes = 4;
    non_default.msaa_samples = 4;
    non_default.target_scale = 0.5;
    non_default.transparent_overlay = false;
    non_default.coverage = 0.375;
    non_default.texture_size = 64;
    non_default.quad_count = 11;
    non_default.draw_calls = 8;
    non_default.rect_count = 22;
    non_default.rect_scale = 0.75;
    non_default.repeats = 2;
    non_default.measurement_frames = 50;
    non_default.output_path = "reference.json";
    non_default.profile = "diagnostic";
    for (const auto& id : manifest) {
        const auto normalized = reference_scenario_options(non_default, id);
        std::string reason;
        if (!check(normalized.scenario == id && normalized.rect_count == 3 &&
                       normalized.rect_scale == 1.0 && normalized.draw_calls == 64 &&
                       normalized.quad_count == 1 && normalized.texture_size == 256 &&
                       normalized.coverage == 1.0 && normalized.composition_path == "direct" &&
                       normalized.composite_passes == 0 && normalized.msaa_samples == 0 &&
                       normalized.target_scale == 1.0 && normalized.transparent_overlay &&
                       normalized.repeats == 2 && normalized.measurement_frames == 50 &&
                       normalized.profile == "diagnostic" &&
                       normalized.output_path == "reference.json" &&
                       validate_reference_options(normalized, reason),
                   "all Quick Suite scenarios reset composition and preserve timing/output"))
            return 1;
    }

    FakeClock clock;
    std::vector<std::string> events;
    Synthetic raw("raw", clock, events);
    Synthetic broken("broken", clock, events, true);
    Synthetic independent("independent", clock, events);
    Options options;
    options.warmup_seconds = 0;
    options.measurement_frames = 3;
    SuiteResult combined;
    append_suite_result(combined, run_suite(options, {&raw}, clock));
    append_suite_result(combined, run_suite(options, {&broken}, clock));
    if (!check(combined.outcome == "partial" && combined.scenarios.size() == 2,
               "failure retains successful results"))
        return 1;
    append_suite_result(combined, run_suite(options, {&independent}, clock));
    append_failed_scenario(combined, "ownership", "backend unavailable");
    if (!check(combined.outcome == "partial" && combined.scenarios.size() == 4 &&
                   combined.scenarios[0].outcome == "complete" &&
                   combined.scenarios[0].measured_frames == 3 &&
                   combined.scenarios[1].outcome == "failed" &&
                   combined.scenarios[1].trials[0].reason == "synthetic startup failed" &&
                   combined.scenarios[2].outcome == "complete" &&
                   combined.scenarios[2].measured_frames == 3 &&
                   combined.scenarios[3].trials[0].reason == "backend unavailable",
               "sequential failure isolation and preserved outcomes") ||
        !check(events == std::vector<std::string>{"raw.prepare", "raw.cleanup", "broken.prepare",
                                                  "broken.cleanup", "independent.prepare",
                                                  "independent.cleanup"},
               "one owner released before next prepares"))
        return 1;
    return 0;
}
