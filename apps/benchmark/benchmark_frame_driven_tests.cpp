#include "benchmark_runner.hpp"

#include <cmath>
#include <cstdio>
#include <string>

using namespace noveltea::benchmark;

namespace {
struct ClockStub : Clock {
    double time = 0;
    double now_seconds() override { return time; }
};
struct ScenarioStub : Scenario {
    explicit ScenarioStub(ClockStub& clock) : clock(clock) {}
    ClockStub& clock;
    int prepared = 0;
    int cleaned = 0;
    int frames = 0;
    bool fail_prepare = false;
    bool fail_cleanup = false;
    const char* id() const override { return "frame-driven-test"; }
    const char* description() const override { return "synthetic rAF test"; }
    bool requires_graphics() const override { return false; }
    bool prepare(const Options&, std::string& reason) override
    {
        ++prepared;
        if (fail_prepare) {
            reason = "preparation failed";
            return false;
        }
        return true;
    }
    Readiness readiness(std::string&) override { return Readiness::Ready; }
    bool frame(std::string&) override
    {
        ++frames;
        clock.time += 0.003;
        return true;
    }
    bool complete(std::string&) override
    {
        clock.time += 2.0; // Late completion time must not enter samples.
        return true;
    }
    bool cleanup(std::string& reason) override
    {
        ++cleaned;
        if (fail_cleanup)
            reason = "shutdown failed";
        return !fail_cleanup;
    }
};

bool verify(bool value, const char* message)
{
    if (!value)
        std::fprintf(stderr, "frame-driven test: %s\n", message);
    return value;
}

void advance(FrameDrivenSuite& runner, ClockStub& clock)
{
    for (int callback = 0; callback < 100; ++callback) {
        clock.time += 0.016; // Simulated browser rAF callback cadence.
        if (runner.step())
            return;
    }
}

} // namespace

int main()
{
    Options options;
    options.measurement_frames = 3;
    options.warmup_seconds = 0;
    options.repeats = 2;
    options.raw_samples = true;
    ClockStub clock;
    ScenarioStub scenario(clock);
    FrameDrivenSuite runner(options, scenario, clock);
    advance(runner, clock);
    const auto& suite = runner.result();
    if (!verify(suite.outcome == "complete" && suite.scenarios.size() == 1,
                "browser runner finishes without blocking") ||
        !verify(scenario.prepared == 2 && scenario.cleaned == 2 && scenario.frames == 6,
                "repeats and exactly one workload frame per callback") ||
        !verify(suite.scenarios[0].trials.size() == 2, "two completed trials"))
        return 1;
    for (const auto& trial : suite.scenarios[0].trials) {
        if (!verify(trial.measured_frames == 3 && trial.warmup_frames == 0 &&
                        trial.raw_samples.size() == 3,
                    "warmup excluded; fixed sample count") ||
            !verify(std::abs(trial.cpu_operation.mean_ms - 3.0) < 0.0001,
                    "CPU frame operation excludes rAF waiting") ||
            !verify(trial.wall_frame.mean_ms >= 19.0 && trial.wall_frame.mean_ms < 20.0,
                    "wall cadence includes browser callback interval") ||
            !verify(trial.measured_wall_seconds < 0.07,
                    "completion drain is not in measured wall time"))
            return 1;
    }

    ClockStub interrupt_clock;
    ScenarioStub interrupted(interrupt_clock);
    Options single = options;
    single.repeats = 1;
    FrameDrivenSuite interrupt_runner(single, interrupted, interrupt_clock);
    (void)interrupt_runner.step(); // prepare
    interrupt_runner.interrupt("page hidden");
    advance(interrupt_runner, interrupt_clock);
    if (!verify(interrupt_runner.result().outcome == "failed" && interrupted.cleaned == 1 &&
                    interrupt_runner.result().scenarios[0].trials[0].reason == "page hidden",
                "page interruption fails trial and cleans up"))
        return 1;

    ClockStub failure_clock;
    ScenarioStub failure(failure_clock);
    failure.fail_prepare = true;
    failure.fail_cleanup = true;
    FrameDrivenSuite failed_runner(single, failure, failure_clock);
    advance(failed_runner, failure_clock);
    const auto& failed = failed_runner.result().scenarios[0].trials[0];
    if (!verify(failed.outcome == "failed" &&
                    failed.reason.find("preparation failed") != std::string::npos &&
                    failed.reason.find("shutdown failed") != std::string::npos,
                "preparation and cleanup failure remain visible"))
        return 1;
    std::puts("frame-driven runner tests passed");
    return 0;
}
