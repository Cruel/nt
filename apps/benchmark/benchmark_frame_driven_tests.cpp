#include "benchmark_runner.hpp"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

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
    bool interrupt_first_attempt = false;
    bool always_interrupt = false;
    bool cancel_first_attempt = false;
    bool sent_interruption = false;
    int attempt_frames = 0;
    bool candidate_arm = false;
    std::vector<std::string> order;
    Interruption state = Interruption::None;
    [[nodiscard]] Interruption interruption() const override { return state; }
    const char* id() const override { return "frame-driven-test"; }
    const char* description() const override { return "synthetic rAF test"; }
    bool requires_graphics() const override { return false; }
    bool prepare(const Options& options, std::string& reason) override
    {
        candidate_arm = options.rect_count == 4;
        order.push_back(candidate_arm ? "B" : "A");
        ++prepared;
        attempt_frames = 0;
        state = Interruption::None;
        if (fail_prepare) {
            reason = "preparation failed";
            return false;
        }
        return true;
    }
    Readiness readiness(std::string&) override { return Readiness::Ready; }
    bool frame(std::string& reason) override
    {
        ++frames;
        ++attempt_frames;
        clock.time += candidate_arm ? 0.006 : 0.003;
        if (attempt_frames == 2 &&
            (always_interrupt || (!sent_interruption && interrupt_first_attempt))) {
            state = Interruption::Recoverable;
            reason = "graphics interrupted";
            sent_interruption = true;
            return false;
        }
        if (attempt_frames == 2 && !sent_interruption && cancel_first_attempt) {
            state = Interruption::Cancelled;
            reason = "Escape";
            sent_interruption = true;
            return false;
        }
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

    ClockStub alternating_clock;
    ScenarioStub alternating_scenario(alternating_clock);
    Options alternating_options = options;
    alternating_options.alternate = std::make_shared<Options>(alternating_options);
    alternating_options.alternate->rect_count = 4;
    FrameDrivenSuite alternating_runner(alternating_options, alternating_scenario,
                                        alternating_clock);
    advance(alternating_runner, alternating_clock);
    const auto& alternating = alternating_runner.result().scenarios.front();
    if (!verify(alternating_runner.result().outcome == "complete" &&
                    alternating_scenario.prepared == 6 && alternating_scenario.cleaned == 6 &&
                    alternating_scenario.order ==
                        std::vector<std::string>{"A", "B", "A", "A", "B", "A"} &&
                    alternating.trials.size() == 6 && alternating.alternating &&
                    alternating.alternating->baseline.completed == 4 &&
                    alternating.alternating->candidate.completed == 2 &&
                    std::abs(*alternating.alternating->cpu_delta_percent - 100.0) < 0.001,
                "browser A/B/A works with one frame per callback and independent trials"))
        return 1;

    ClockStub early_clock;
    ScenarioStub early_scenario(early_clock);
    FrameDrivenSuite early_runner(alternating_options, early_scenario, early_clock);
    (void)early_runner.step(); // A preparation; no B trial started yet.
    early_runner.cancel("backgrounded before candidate");
    advance(early_runner, early_clock);
    if (!verify(early_runner.result().outcome == "cancelled" &&
                    early_runner.result().scenarios[0].trials.size() == 1 &&
                    early_runner.result().scenarios[0].alternating.has_value() &&
                    early_runner.result().scenarios[0].alternating->candidate.completed == 0,
                "browser interruption before B retains an incomplete A/B/A summary"))
        return 1;

    ClockStub interrupt_clock;
    ScenarioStub interrupted(interrupt_clock);
    Options single = options;
    single.repeats = 1;
    int recovery_calls = 0;
    FrameDrivenSuite interrupt_runner(single, interrupted, interrupt_clock, [&](std::string&) {
        return ++recovery_calls == 1 ? RecoveryState::Pending : RecoveryState::Ready;
    });
    (void)interrupt_runner.step(); // prepare
    interrupt_runner.interrupt("page hidden");
    advance(interrupt_runner, interrupt_clock);
    if (!verify(
            interrupt_runner.result().outcome == "complete" && interrupted.cleaned == 2 &&
                interrupted.prepared == 2 && recovery_calls == 2 &&
                interrupt_runner.result().scenarios[0].trials[0].interruption_retries == 1 &&
                interrupt_runner.result().scenarios[0].trials[0].interrupted_attempts.size() == 1 &&
                interrupt_runner.result().scenarios[0].trials[0].interrupted_attempts[0].reason ==
                    "page hidden",
            "interrupted attempt cleaned up, pending recovery, fresh warmup and retry"))
        return 1;

    ClockStub pending_clock;
    ScenarioStub pending(pending_clock);
    FrameDrivenSuite pending_runner(single, pending, pending_clock,
                                    [](std::string&) { return RecoveryState::Pending; });
    (void)pending_runner.step();
    pending_runner.interrupt("surface unavailable");
    (void)pending_runner.step(); // cleanup once
    (void)pending_runner.step(); // recovery remains pending
    pending_runner.cancel("Escape while awaiting recovery");
    (void)pending_runner.step();
    if (!verify(pending_runner.result().outcome == "cancelled" && pending.cleaned == 1 &&
                    pending_runner.result().scenarios[0].trials.size() == 1,
                "cancelling pending recovery must not double-cleanup the graphics host"))
        return 1;

    // Lost graphics contexts cannot safely execute GPU cleanup, but Escape
    // must still finalize immediately. The host retains the scenario until
    // context restoration, then performs the deferred resource destruction.
    ClockStub lost_clock;
    ScenarioStub lost_scenario(lost_clock);
    FrameDrivenSuite lost_runner(single, lost_scenario, lost_clock);
    (void)lost_runner.step(); // prepare
    lost_runner.interrupt("WebGL context lost");
    lost_runner.cancel_without_cleanup("Escape during context loss");
    const bool cancelled_without_context = lost_runner.step();
    if (!verify(cancelled_without_context && lost_runner.result().outcome == "cancelled" &&
                    lost_runner.result().scenarios[0].trials[0].reason ==
                        "Escape during context loss" &&
                    lost_scenario.cleaned == 0,
                "terminal cancellation publishes results without GPU cleanup or recovery"))
        return 1;

    ClockStub sample_clock;
    ScenarioStub sample_scenario(sample_clock);
    sample_scenario.interrupt_first_attempt = true;
    FrameDrivenSuite sample_runner(options, sample_scenario, sample_clock);
    advance(sample_runner, sample_clock);
    const auto& sample_result = sample_runner.result().scenarios[0];
    if (!verify(sample_result.outcome == "complete" && sample_result.trials.size() == 2 &&
                    sample_result.trials[0].interruption_retries == 1 &&
                    sample_result.trials[0].measured_frames == 3 &&
                    sample_result.measured_frames == 6 && sample_scenario.cleaned == 3,
                "partial samples discarded; completed repeats retained"))
        return 1;

    ClockStub bounded_clock;
    ScenarioStub bounded(bounded_clock);
    bounded.always_interrupt = true;
    FrameDrivenSuite bounded_runner(single, bounded, bounded_clock);
    advance(bounded_runner, bounded_clock);
    if (!verify(bounded_runner.result().outcome == "failed" &&
                    bounded.prepared == static_cast<int>(kMaxInterruptionRetries + 1) &&
                    bounded_runner.result().scenarios[0].trials[0].reason.find("retry limit") !=
                        std::string::npos,
                "persistent graphics interruption exhausts a bounded retry policy"))
        return 1;

    ClockStub cancel_clock;
    ScenarioStub cancelled(cancel_clock);
    cancelled.cancel_first_attempt = true;
    FrameDrivenSuite cancel_runner(options, cancelled, cancel_clock);
    advance(cancel_runner, cancel_clock);
    if (!verify(cancel_runner.result().outcome == "cancelled" && cancelled.cleaned == 1 &&
                    cancel_runner.result().scenarios[0].trials.size() == 1,
                "Escape cancellation terminates repeats without retry"))
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
