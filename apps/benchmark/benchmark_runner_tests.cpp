#include "benchmark_runner.hpp"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace {
using namespace noveltea::benchmark;

struct FakeClock final : Clock {
    double time = 0.0;
    double now_seconds() override { return time; }
};

struct FakeScenario final : Scenario {
    FakeClock& clock;
    int prepares = 0;
    int cleanups = 0;
    int completed_frames = 0;
    int fail_after_frames = -1;
    int ready_polls = 0;
    int pending_polls = 0;
    bool never_ready = false;
    bool fail_prepare = false;
    bool omit_prepare_reason = false;
    int fail_prepare_after = -1;
    bool fail_frame = false;
    bool fail_completion = false;
    bool fail_cleanup = false;
    bool graphics = false;
    int diagnostic_calls = 0;
    int diagnostic_completion_calls = 0;
    bool emit_diagnostics = false;
    uint32_t frame_number = 19;
    Interruption interruption_state = Interruption::None;
    Interruption injected_interruption = Interruption::None;
    int attempts_to_interrupt = 0;
    int attempts_interrupted = 0;
    int attempt_frames = 0;
    bool candidate_arm = false;
    double candidate_extra_seconds = 0.0;
    std::vector<std::string> arm_order;
    [[nodiscard]] Interruption interruption() const override { return interruption_state; }

    explicit FakeScenario(FakeClock& value) : clock(value) {}
    const char* id() const override { return "synthetic"; }
    const char* description() const override { return "controlled CPU-only frame"; }
    bool requires_graphics() const override { return graphics; }
    bool prepare(const Options& options, std::string& reason) override
    {
        candidate_arm = options.rect_count != 3;
        arm_order.push_back(candidate_arm ? "B" : "A");
        ++prepares;
        attempt_frames = 0;
        interruption_state = Interruption::None;
        if (fail_prepare || (fail_prepare_after >= 0 && prepares > fail_prepare_after)) {
            if (!omit_prepare_reason)
                reason = "preparation failed";
            return false;
        }
        return true;
    }
    Readiness readiness(std::string&) override
    {
        ++ready_polls;
        clock.time += 0.25;
        if (never_ready || ready_polls <= pending_polls)
            return Readiness::Pending;
        return Readiness::Ready;
    }
    bool frame(std::string& reason) override
    {
        clock.time += 0.01 + (candidate_arm ? candidate_extra_seconds : 0.0);
        ++attempt_frames;
        if (attempt_frames == 2 && attempts_interrupted < attempts_to_interrupt) {
            ++attempts_interrupted;
            interruption_state = injected_interruption;
            reason =
                injected_interruption == Interruption::Cancelled ? "cancelled" : "surface lost";
            return false;
        }
        if (fail_frame || (fail_after_frames >= 0 && completed_frames == fail_after_frames)) {
            reason = "frame failed";
            return false;
        }
        ++completed_frames;
        return true;
    }
    void diagnostic_frame(DiagnosticObservation& observation) override
    {
        ++diagnostic_calls;
        if (!emit_diagnostics)
            return;
        observation.cpu_submission_ms = 2.0;
        observation.rmlui_update_ms = 0.8;
        observation.rmlui_render_ms = 1.2;
        observation.engine_update_ms = 0.4;
        observation.engine_runtime_ms = 0.1;
        observation.engine_layout_ms = 0.2;
        observation.engine_render_ms = 2.4;
        observation.bgfx_frame_cpu_ms = 3.0;
        observation.bgfx_wait_render_ms = 0.5;
        observation.bgfx_wait_submit_ms = 0.25;
        observation.draw_calls = 4;
        observation.view_count = 2;
        observation.textures = 7;
        observation.submitted_frame = ++frame_number;
        observation.gpu_completed_frame = frame_number - 1;
        observation.gpu_execution_ms = 1.25;
    }
    void diagnostic_completion(std::vector<DiagnosticObservation>& late) override
    {
        ++diagnostic_completion_calls;
        if (emit_diagnostics)
            late.push_back({.gpu_execution_ms = 1.0, .gpu_completed_frame = frame_number});
    }
    bool complete(std::string& reason) override
    {
        clock.time += 100.0; // Deliberate asynchronous drain, never a sample.
        if (fail_completion) {
            reason = "completion failed";
            return false;
        }
        return true;
    }
    bool cleanup(std::string& reason) override
    {
        ++cleanups;
        if (fail_cleanup) {
            reason = "host shutdown failed";
            return false;
        }
        return true;
    }
};

bool check(bool condition, const char* message)
{
    if (!condition)
        std::fprintf(stderr, "runner test: %s\n", message);
    return condition;
}
} // namespace

int main()
{
    FakeClock clock;
    FakeScenario scenario(clock);
    Options options;
    options.scenario = "synthetic"; // The runner does not own the app's scenario registry.
    options.warmup_seconds = 0.03;
    options.measurement_frames = 5;
    options.repeats = 2;
    options.raw_samples = true;
    const auto results = run_suite(options, {&scenario}, clock);
    if (!check(!scenario.requires_graphics() && results.outcome == "complete" &&
                   results.scenarios.size() == 1,
               "CPU-only scenario does not require graphics initialization") ||
        !check(scenario.prepares == 2 && scenario.cleanups == 2, "cleanup per trial") ||
        !check(results.scenarios[0].trials.size() == 2, "repeat count"))
        return 1;
    for (const auto& trial : results.scenarios[0].trials) {
        if (!check(trial.outcome == "complete" && trial.measured_frames == 5 &&
                       trial.warmup_frames >= 3 && trial.raw_samples.size() == 5,
                   "warmup excluded from samples") ||
            !check(std::abs(trial.cpu_operation.p50_ms - 10.0) < 0.001 &&
                       std::abs(trial.wall_frame.p99_ms - 10.0) < 0.001,
                   "exact deterministic percentiles") ||
            !check(trial.measured_wall_seconds < 0.051 && trial.measured_wall_seconds > 0.049,
                   "completion excluded from elapsed") ||
            !check(trial.phases == std::vector<Phase>{Phase::Preparation, Phase::Ready,
                                                      Phase::Warmup, Phase::Measurement,
                                                      Phase::Completion, Phase::Results,
                                                      Phase::Cleanup},
                   "phase ordering"))
            return 1;
    }
    if (!check(results.scenarios[0].measured_frames == 10 &&
                   results.scenarios[0].cpu_operation.count == 10,
               "aggregate measured frames"))
        return 1;

    FakeClock recovery_clock;
    FakeScenario recoverable(recovery_clock);
    recoverable.injected_interruption = Interruption::Recoverable;
    recoverable.attempts_to_interrupt = 1;
    int graphics_rebuilds = 0;
    const auto recovered = run_suite(options, {&recoverable}, recovery_clock, [&](std::string&) {
        ++graphics_rebuilds;
        return RecoveryState::Ready;
    });
    if (!check(recovered.outcome == "complete" && graphics_rebuilds == 1 &&
                   recoverable.prepares == 3 && recoverable.cleanups == 3 &&
                   recovered.scenarios[0].trials.size() == 2 &&
                   recovered.scenarios[0].trials[0].interruption_retries == 1 &&
                   recovered.scenarios[0].trials[0].interrupted_attempts.size() == 1 &&
                   recovered.scenarios[0].trials[0].interrupted_attempts[0].reason ==
                       "surface lost" &&
                   recovered.scenarios[0].measured_frames == 10,
               "native interrupted attempt retries with fresh warmup and retains repeats"))
        return 1;

    FakeClock persistent_clock;
    FakeScenario persistent(persistent_clock);
    persistent.injected_interruption = Interruption::Recoverable;
    persistent.attempts_to_interrupt = 10;
    Options one_trial = options;
    one_trial.repeats = 1;
    const auto exhausted = run_suite(one_trial, {&persistent}, persistent_clock);
    if (!check(exhausted.outcome == "failed" &&
                   persistent.prepares == static_cast<int>(kMaxInterruptionRetries + 1) &&
                   exhausted.scenarios[0].trials[0].reason.find("retry limit") != std::string::npos,
               "native recovery retries bounded and failure reported"))
        return 1;

    FakeClock cancel_clock;
    FakeScenario cancel_scenario(cancel_clock);
    cancel_scenario.injected_interruption = Interruption::Cancelled;
    cancel_scenario.attempts_to_interrupt = 1;
    const auto cancelled_run = run_suite(options, {&cancel_scenario}, cancel_clock);
    if (!check(cancelled_run.outcome == "cancelled" && cancel_scenario.prepares == 1 &&
                   cancelled_run.scenarios[0].trials.size() == 1 &&
                   cancelled_run.scenarios[0].trials[0].outcome == "cancelled",
               "native cancellation exits collection without retries or subsequent repeats"))
        return 1;

    FakeClock timeout_clock;
    FakeScenario timeout(timeout_clock);
    timeout.never_ready = true;
    Options timeout_options = options;
    timeout_options.repeats = 1;
    timeout_options.ready_timeout_seconds = 0.5;
    const auto timed_out = run_suite(timeout_options, {&timeout}, timeout_clock);
    if (!check(timed_out.outcome == "failed" && timeout.cleanups == 1 &&
                   timed_out.scenarios[0].trials[0].outcome == "failed" &&
                   timed_out.scenarios[0].trials[0].reason == "readiness timeout" &&
                   timed_out.scenarios[0].trials[0].measured_frames == 0 &&
                   timed_out.scenarios[0].trials[0].phases ==
                       std::vector<Phase>{Phase::Preparation, Phase::Cleanup},
               "timeout and cleanup"))
        return 1;

    FakeClock duration_clock;
    FakeScenario duration_scenario(duration_clock);
    duration_scenario.pending_polls = 2;
    Options duration_options = options;
    duration_options.repeats = 1;
    duration_options.warmup_seconds = 0.0;
    duration_options.measurement_frames = 0;
    duration_options.duration_seconds = 0.025;
    const auto duration_run = run_suite(duration_options, {&duration_scenario}, duration_clock);
    if (!check(duration_run.outcome == "complete" && duration_scenario.ready_polls == 3 &&
                   duration_run.scenarios[0].trials[0].measured_frames == 3 &&
                   duration_run.scenarios[0].trials[0].measured_wall_seconds > 0.029 &&
                   duration_run.scenarios[0].trials[0].measured_wall_seconds < 0.031,
               "time-based measurement begins only after delayed readiness"))
        return 1;

    FakeClock late_clock;
    FakeScenario late_ready(late_clock);
    Options late_options = duration_options;
    late_options.ready_timeout_seconds = 0.1;
    const auto late_run = run_suite(late_options, {&late_ready}, late_clock);
    if (!check(late_run.outcome == "failed" && late_ready.cleanups == 1 &&
                   late_run.scenarios[0].trials[0].reason == "readiness timeout",
               "late readiness cannot pass its deadline"))
        return 1;

    FakeClock failure_clock;
    FakeScenario broken(failure_clock);
    broken.fail_prepare = true;
    FakeScenario good(failure_clock);
    Options fail_options = options;
    fail_options.repeats = 1;
    fail_options.measurement_frames = 2;
    fail_options.raw_samples = false;
    const auto partial = run_suite(fail_options, {&broken, &good}, failure_clock);
    if (!check(partial.outcome == "partial" && broken.cleanups == 1 && good.cleanups == 1 &&
                   partial.scenarios[0].outcome == "failed" &&
                   partial.scenarios[1].outcome == "complete" &&
                   partial.scenarios[1].trials[0].raw_samples.empty(),
               "continue independent scenario after failure"))
        return 1;

    FakeClock partial_repeats_clock;
    FakeScenario partial_repeats(partial_repeats_clock);
    partial_repeats.fail_prepare_after = 1;
    const auto mixed_repeats = run_suite(options, {&partial_repeats}, partial_repeats_clock);
    if (!check(mixed_repeats.outcome == "partial" &&
                   mixed_repeats.scenarios[0].outcome == "partial" &&
                   mixed_repeats.scenarios[0].trials.size() == 2 &&
                   mixed_repeats.scenarios[0].measured_frames == 5 && partial_repeats.cleanups == 2,
               "partly successful repeats retain complete measurements"))
        return 1;

    FakeClock frame_clock;
    FakeScenario frame_failure(frame_clock);
    frame_failure.fail_frame = true;
    const auto failed_frame = run_suite(fail_options, {&frame_failure}, frame_clock);
    if (!check(failed_frame.outcome == "failed" && frame_failure.cleanups == 1 &&
                   failed_frame.scenarios[0].trials[0].measured_frames == 0,
               "failed workload never fabricates measured frame"))
        return 1;

    FakeClock partial_clock;
    FakeScenario interrupted(partial_clock);
    interrupted.fail_after_frames = 1;
    Options partial_options = fail_options;
    partial_options.warmup_seconds = 0.0;
    const auto incomplete = run_suite(partial_options, {&interrupted}, partial_clock);
    if (!check(incomplete.outcome == "failed" && interrupted.cleanups == 1 &&
                   incomplete.scenarios[0].trials[0].measured_frames == 1 &&
                   incomplete.scenarios[0].trials[0].measured_wall_seconds > 0.0 &&
                   incomplete.scenarios[0].measured_frames == 0,
               "incomplete trials preserve observed frames but never enter aggregates"))
        return 1;

    const auto distribution = summarize(
        {{0.001, 0.001}, {0.002, 0.002}, {0.003, 0.003}, {0.004, 0.004}, {0.005, 0.005}}, true);
    if (!check(distribution.count == 5 && std::abs(distribution.mean_ms - 3.0) < 0.00001 &&
                   std::abs(distribution.p50_ms - 3.0) < 0.00001 &&
                   std::abs(distribution.p95_ms - 4.8) < 0.00001 &&
                   std::abs(distribution.p99_ms - 4.96) < 0.00001,
               "interpolated percentiles for varied samples"))
        return 1;

    FakeClock end_clock;
    FakeScenario completion_failure(end_clock);
    completion_failure.fail_completion = true;
    const auto failed_end = run_suite(fail_options, {&completion_failure}, end_clock);
    if (!check(failed_end.outcome == "failed" && completion_failure.cleanups == 1 &&
                   failed_end.scenarios[0].trials[0].outcome == "failed",
               "failed completion invalidates trial"))
        return 1;

    FakeClock cleanup_clock;
    FakeScenario cleanup_failure(cleanup_clock);
    cleanup_failure.fail_cleanup = true;
    const auto cleanup_run = run_suite(fail_options, {&cleanup_failure}, cleanup_clock);
    const auto& cleanup_trial = cleanup_run.scenarios[0].trials[0];
    if (!check(cleanup_run.outcome == "failed" && cleanup_failure.cleanups == 1 &&
                   cleanup_trial.outcome == "failed" &&
                   cleanup_trial.reason == "cleanup failed: host shutdown failed" &&
                   cleanup_trial.measured_frames == 2 && cleanup_trial.wall_frame.count == 0 &&
                   cleanup_run.scenarios[0].measured_frames == 0 &&
                   cleanup_trial.raw_samples.empty(),
               "cleanup failure invalidates otherwise successful measurement"))
        return 1;

    FakeClock multiple_failures_clock;
    FakeScenario multiple_failures(multiple_failures_clock);
    multiple_failures.fail_prepare = true;
    multiple_failures.fail_cleanup = true;
    FakeScenario independent(multiple_failures_clock);
    const auto failed_prepare_cleanup =
        run_suite(fail_options, {&multiple_failures, &independent}, multiple_failures_clock);
    if (!check(failed_prepare_cleanup.outcome == "partial" &&
                   failed_prepare_cleanup.scenarios[0].trials[0].reason ==
                       "preparation failed; cleanup failed: host shutdown failed" &&
                   failed_prepare_cleanup.scenarios[1].outcome == "complete" &&
                   multiple_failures.cleanups == 1 && independent.cleanups == 1,
               "primary failure retained alongside cleanup failure; suite continues"))
        return 1;

    FakeClock no_reason_clock;
    FakeScenario no_reason(no_reason_clock);
    no_reason.fail_prepare = true;
    no_reason.omit_prepare_reason = true;
    no_reason.fail_cleanup = true;
    const auto silent_failure = run_suite(fail_options, {&no_reason}, no_reason_clock);
    if (!check(silent_failure.scenarios[0].trials[0].reason ==
                   "scenario preparation failed; cleanup failed: host shutdown failed",
               "cleanup failure cannot hide an earlier undiagnosed preparation failure"))
        return 1;

    FakeClock diagnostic_clock;
    FakeScenario instrumented(diagnostic_clock);
    instrumented.emit_diagnostics = true;
    Options diagnostic_options = options;
    diagnostic_options.profile = "diagnostic";
    diagnostic_options.warmup_seconds = 0.0;
    diagnostic_options.measurement_frames = 4;
    diagnostic_options.repeats = 1;
    const auto diagnostic_run = run_suite(diagnostic_options, {&instrumented}, diagnostic_clock);
    const auto& measurements = diagnostic_run.scenarios[0].trials[0].diagnostic;
    if (!check(diagnostic_run.instrumentation_control.has_value() &&
                   diagnostic_run.instrumentation_control->iterations == 20000 &&
                   instrumented.diagnostic_calls == 4 && measurements.observations == 4 &&
                   measurements.cpu_submission_ms.count == 4 &&
                   measurements.rmlui_update_ms.count == 4 &&
                   measurements.rmlui_update_ms.p50_ms == 0.8 &&
                   measurements.rmlui_render_ms.p95_ms == 1.2 &&
                   measurements.engine_update_ms.mean_ms == 0.4 &&
                   measurements.engine_runtime_ms.count == 4 &&
                   measurements.engine_layout_ms.p99_ms == 0.2 &&
                   measurements.engine_render_ms.mean_ms == 2.4 &&
                   measurements.bgfx_frame_cpu_ms.mean_ms == 3.0 &&
                   measurements.bgfx_wait_render_ms.mean_ms == 0.5 &&
                   measurements.draw_calls.mean == 4.0 && measurements.textures.mean == 7.0 &&
                   measurements.gpu_execution_ms.count == 4 &&
                   instrumented.diagnostic_completion_calls == 1,
               "diagnostic tracks separate CPU stages and distinct completed GPU frames"))
        return 1;
    FakeClock clean_clock;
    FakeScenario clean_scenario(clean_clock);
    clean_scenario.emit_diagnostics = true;
    const auto clean_run = run_suite(options, {&clean_scenario}, clean_clock);
    if (!check(!clean_run.instrumentation_control && clean_scenario.diagnostic_calls == 0 &&
                   clean_scenario.diagnostic_completion_calls == 0 &&
                   clean_run.scenarios[0].trials[0].diagnostic.observations == 0 &&
                   clean_run.scenarios[0].trials[0].diagnostic.engine_runtime_ms.count == 0 &&
                   clean_run.scenarios[0].trials[0].diagnostic.rmlui_update_ms.count == 0 &&
                   clean_run.scenarios[0].trials[0].diagnostic.gpu_execution_ms.count == 0,
               "clean profile never invokes diagnostic observation"))
        return 1;
    FakeClock missing_clock;
    FakeScenario missing(missing_clock);
    const auto missing_run = run_suite(diagnostic_options, {&missing}, missing_clock);
    if (!check(missing.diagnostic_calls == 4 &&
                   missing_run.scenarios[0].trials[0].diagnostic.gpu_execution_ms.count == 0 &&
                   missing_run.scenarios[0].trials[0].diagnostic.bgfx_wait_render_ms.count == 0,
               "unsupported statistics remain unavailable"))
        return 1;

    const std::vector<DiagnosticObservation> asynchronous = {
        {.gpu_execution_ms = 4.0, .submitted_frame = 40, .gpu_completed_frame = 39},
        {.gpu_execution_ms = 2.0, .submitted_frame = 41, .gpu_completed_frame = 40},
        {.gpu_execution_ms = 9.0, .submitted_frame = 42, .gpu_completed_frame = 40},
    };
    const std::vector<DiagnosticObservation> delayed = {
        {.gpu_execution_ms = 3.0, .gpu_completed_frame = 41},
        {.gpu_execution_ms = 3.5, .gpu_completed_frame = 42},
        {.gpu_execution_ms = 9.0, .gpu_completed_frame = 43},
        {.gpu_execution_ms = 7.0}, // No identity: do not guess.
    };
    const auto asynchronously_completed = summarize_diagnostics(asynchronous, delayed);
    if (!check(asynchronously_completed.gpu_execution_ms.count == 3 &&
                   asynchronously_completed.gpu_execution_ms.min_ms == 2.0 &&
                   asynchronously_completed.gpu_execution_ms.max_ms == 3.5 &&
                   asynchronously_completed.observations == 3,
               "delayed GPU frames are deduplicated, bounded and not counted as CPU samples"))
        return 1;

    FakeClock aba_clock;
    FakeScenario alternating(aba_clock);
    alternating.candidate_extra_seconds = 0.01;
    Options aba_options = options;
    aba_options.repeats = 2;
    aba_options.alternate = std::make_shared<Options>(aba_options);
    aba_options.alternate->rect_count = 4;
    const auto aba = run_suite(aba_options, {&alternating}, aba_clock);
    const auto& aba_scenario = aba.scenarios.front();
    if (!check(
            aba.outcome == "complete" && alternating.prepares == 6 && alternating.cleanups == 6 &&
                alternating.arm_order == std::vector<std::string>{"A", "B", "A", "A", "B", "A"} &&
                aba_scenario.trials.size() == 6 && aba_scenario.measured_frames == 30 &&
                aba_scenario.alternating.has_value() &&
                aba_scenario.alternating->baseline.completed == 4 &&
                aba_scenario.alternating->candidate.completed == 2 &&
                std::abs(*aba_scenario.alternating->cpu_delta_percent - 100.0) < 0.001 &&
                std::abs(*aba_scenario.alternating->cpu_drift_percent) < 0.001,
            "A/B/A cycles independently warm, measure and cleanup every A and B trial"))
        return 1;
    FakeClock early_clock;
    FakeScenario early_cancel(early_clock);
    early_cancel.injected_interruption = Interruption::Cancelled;
    early_cancel.attempts_to_interrupt = 1;
    const auto early = run_suite(aba_options, {&early_cancel}, early_clock);
    if (!check(early.outcome == "cancelled" && early.scenarios[0].trials.size() == 1 &&
                   early.scenarios[0].alternating.has_value() &&
                   early.scenarios[0].alternating->candidate.completed == 0 &&
                   !early.scenarios[0].alternating->warnings.empty(),
               "A/B/A cancellation before B retains unfinished comparison metadata"))
        return 1;
    std::vector<TrialResult> noisy_trials(6);
    const double observations[] = {10.0, 20.0, 10.0, 30.0, 25.0, 40.0};
    for (size_t i = 0; i < noisy_trials.size(); ++i) {
        noisy_trials[i].arm = i % 3 == 1 ? "B" : "A";
        noisy_trials[i].outcome = "complete";
        noisy_trials[i].wall_frame.p50_ms = observations[i];
        noisy_trials[i].cpu_operation.p50_ms = observations[i];
    }
    const auto noisy = summarize_alternating(noisy_trials);
    if (!check(noisy && noisy->wall_drift_percent &&
                   std::abs(*noisy->wall_drift_percent - 300.0) < 0.001 &&
                   noisy->baseline.wall_medians.standard_deviation_ms > 0.0 &&
                   noisy->candidate.cpu_medians.p99_ms > noisy->candidate.cpu_medians.p50_ms &&
                   !noisy->warnings.empty(),
               "synthetic noisy trials flag variability and drift without wall-clock thresholds"))
        return 1;
    std::vector<TrialResult> ordinary_trials(5);
    for (size_t i = 0; i < ordinary_trials.size(); ++i) {
        ordinary_trials[i].arm = "A";
        ordinary_trials[i].outcome = "complete";
        ordinary_trials[i].wall_frame.p50_ms = 10.0 + i * 5.0;
        ordinary_trials[i].cpu_operation.p50_ms = 5.0 + i * 3.0;
    }
    const auto repeated = summarize_repeated(ordinary_trials);
    if (!check(repeated && repeated->trials.completed == 5 &&
                   repeated->trials.wall_medians.count == 5 &&
                   repeated->trials.wall_p95.count == 5 && repeated->trials.cpu_p99.count == 5 &&
                   repeated->wall_drift_percent &&
                   std::abs(*repeated->wall_drift_percent - 200.0) < 0.001 &&
                   !repeated->warnings.empty() && !summarize_repeated(ordinary_trials, true),
               "ordinary repeated trials report CV, endpoints, and tails without a B arm"))
        return 1;

    Options invalid = options;
    invalid.repeats = 0;
    std::string reason;
    if (!check(!validate_run_options(invalid, reason) && !reason.empty(),
               "reject invalid repeated configuration") ||
        !check(!validate_run_options(Options{.duration_seconds = 0.0}, reason),
               "reject empty duration"))
        return 1;
    return 0;
}
