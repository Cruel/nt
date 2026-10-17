#include "benchmark_runner.hpp"
#include "benchmark_capacity.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <numeric>
#include <thread>
#include <unordered_set>
#include <utility>

namespace noveltea::benchmark {
namespace {

constexpr uint64_t kMaxSamplesPerTrial = 300000;

double percentile(const std::vector<double>& values, double fraction)
{
    const double index = fraction * static_cast<double>(values.size() - 1);
    const auto lower = static_cast<size_t>(index);
    const auto upper = std::min(lower + 1, values.size() - 1);
    return values[lower] + (values[upper] - values[lower]) * (index - static_cast<double>(lower));
}

bool sample_valid(double value) { return std::isfinite(value) && value >= 0.0; }

Distribution summarize_milliseconds(std::vector<double>& values)
{
    Distribution result;
    if (values.empty())
        return result;
    std::sort(values.begin(), values.end());
    result.count = values.size();
    result.min_ms = values.front();
    result.max_ms = values.back();
    result.mean_ms =
        std::accumulate(values.begin(), values.end(), 0.0) / static_cast<double>(values.size());
    double squared_deviation = 0.0;
    for (const double value : values)
        squared_deviation += (value - result.mean_ms) * (value - result.mean_ms);
    result.standard_deviation_ms =
        std::sqrt(squared_deviation / static_cast<double>(values.size()));
    result.p50_ms = percentile(values, 0.50);
    result.p95_ms = percentile(values, 0.95);
    result.p99_ms = percentile(values, 0.99);
    return result;
}

Distribution diagnostic_times(const std::vector<DiagnosticObservation>& observations,
                              std::optional<double> DiagnosticObservation::*member)
{
    std::vector<double> values;
    for (const auto& observation : observations) {
        const auto& value = observation.*member;
        if (value && sample_valid(*value))
            values.push_back(*value);
    }
    return summarize_milliseconds(values);
}

InstrumentationControl measure_timer_overhead()
{
    constexpr uint64_t iterations = 20000;
    const auto batch = [](bool extra) {
        using Clock = std::chrono::steady_clock;
        const auto start = Clock::now();
        for (uint64_t i = 0; i < iterations; ++i) {
            (void)Clock::now();
            (void)Clock::now();
            if (extra) {
                (void)Clock::now();
                (void)Clock::now();
            }
        }
        const auto end = Clock::now();
        return std::chrono::duration<double, std::nano>(end - start).count() /
               static_cast<double>(iterations);
    };
    // An isolated lower-bound clock-read control, not a GPU-query or full
    // diagnostic instrumentation cost measurement.
    (void)batch(false);
    (void)batch(true);
    const double two = batch(false);
    const double four = batch(true);
    return {iterations, two, four, four - two};
}

CounterSummary diagnostic_counts(const std::vector<DiagnosticObservation>& observations,
                                 std::optional<uint32_t> DiagnosticObservation::*member)
{
    CounterSummary result;
    uint64_t total = 0;
    for (const auto& observation : observations) {
        const auto& value = observation.*member;
        if (!value)
            continue;
        if (!result.count) {
            result.min = *value;
            result.max = *value;
        }
        result.min = std::min(result.min, *value);
        result.max = std::max(result.max, *value);
        total += *value;
        ++result.count;
    }
    if (result.count)
        result.mean = static_cast<double>(total) / static_cast<double>(result.count);
    return result;
}

TrialResult run_trial(const Options& options, Scenario& scenario, Clock& clock,
                      std::vector<FrameSample>& samples,
                      std::vector<DiagnosticObservation>& observations)
{
    TrialResult trial;
    std::string reason;
    bool results_ready = false;
    std::vector<DiagnosticObservation> late_observations;
    const bool diagnostic = options.profile == "diagnostic";
    trial.phases.push_back(Phase::Preparation);
    // Even failed preparation may have acquired partial scenario resources.
    const bool prepared = scenario.prepare(options, reason);
    if (prepared) {
        const double readiness_start = clock.now_seconds();
        bool ready = false;
        while (true) {
            const auto state = scenario.readiness(reason);
            if (state == Readiness::Ready &&
                clock.now_seconds() - readiness_start <= options.ready_timeout_seconds) {
                ready = true;
                break;
            }
            if (state == Readiness::Failed) {
                if (reason.empty())
                    reason = "scenario readiness failed";
                break;
            }
            if (clock.now_seconds() - readiness_start >= options.ready_timeout_seconds) {
                reason = "readiness timeout";
                break;
            }
        }
        if (ready) {
            trial.phases.push_back(Phase::Ready);
            trial.phases.push_back(Phase::Warmup);
            const double start = clock.now_seconds();
            bool worked = true;
            while (clock.now_seconds() - start < options.warmup_seconds) {
                if (!scenario.prepare_frame(reason) || !scenario.frame(reason)) {
                    worked = false;
                    if (reason.empty())
                        reason = "warmup frame failed";
                    break;
                }
                ++trial.warmup_frames;
            }
            if (worked) {
                trial.phases.push_back(Phase::Measurement);
                const double measured_start = clock.now_seconds();
                double previous_end = measured_start;
                bool measured = true;
                const bool active_timing = scenario.active_operation_timing();
                while (true) {
                    if (trial.measured_frames == samples.size()) {
                        measured = false;
                        reason = "sample capacity exceeded";
                        break;
                    }
                    if (!scenario.prepare_frame(reason)) {
                        measured = false;
                        if (reason.empty())
                            reason = "measurement preparation failed";
                        break;
                    }
                    const double frame_start = clock.now_seconds();
                    if (!scenario.frame(reason)) {
                        measured = false;
                        if (reason.empty())
                            reason = "measurement frame failed";
                        break;
                    }
                    const double frame_end = clock.now_seconds();
                    const double operation = frame_end - frame_start;
                    const FrameSample sample{active_timing ? operation : frame_end - previous_end,
                                             operation};
                    if (!sample_valid(sample.wall_seconds) ||
                        !sample_valid(sample.operation_seconds) || frame_end <= measured_start) {
                        measured = false;
                        reason = "non-monotonic or invalid frame timing";
                        break;
                    }
                    samples[static_cast<size_t>(trial.measured_frames)] = sample;
                    if (diagnostic) {
                        auto& observation =
                            observations[static_cast<size_t>(trial.measured_frames)];
                        scenario.diagnostic_frame(observation);
                    }
                    ++trial.measured_frames;
                    previous_end = frame_end;
                    if (active_timing)
                        trial.measured_wall_seconds += operation;
                    else
                        trial.measured_wall_seconds = frame_end - measured_start;
                    if (options.measurement_frames != 0
                            ? trial.measured_frames >= options.measurement_frames
                            : trial.measured_wall_seconds >= options.duration_seconds)
                        break;
                }
                if (measured) {
                    trial.phases.push_back(Phase::Completion);
                    if (!scenario.complete(reason)) {
                        measured = false;
                        if (reason.empty())
                            reason = "scenario completion failed";
                    } else if (diagnostic) {
                        // Collect pending completed-frame IDs after timing has
                        // ended; never fence the GPU on each measured frame.
                        scenario.diagnostic_completion(late_observations);
                    }
                }
                if (measured) {
                    trial.phases.push_back(Phase::Results);
                    results_ready = true;
                }
            }
        }
    }
    trial.phases.push_back(Phase::Cleanup);
    if (results_ready)
        reason.clear(); // A successful scenario may have returned readiness progress text.
    else if (reason.empty())
        reason = "scenario preparation failed";
    std::string cleanup_reason;
    if (!scenario.cleanup(cleanup_reason)) {
        const std::string error =
            cleanup_reason.empty() ? "cleanup failed" : "cleanup failed: " + cleanup_reason;
        if (!reason.empty())
            reason += "; ";
        reason += error;
    }
    // Only an entirely successful trial contributes samples to statistics.
    // A teardown failure invalidates even an otherwise completed measurement.
    if (results_ready && reason.empty()) {
        trial.outcome = "complete";
        std::vector<FrameSample> measured_samples(
            samples.begin(), samples.begin() + static_cast<std::ptrdiff_t>(trial.measured_frames));
        trial.wall_frame = summarize(measured_samples, true);
        trial.cpu_operation = summarize(measured_samples, false);
        if (diagnostic) {
            observations.resize(static_cast<size_t>(trial.measured_frames));
            trial.diagnostic = summarize_diagnostics(observations, late_observations);
        }
        if (options.raw_samples)
            trial.raw_samples = std::move(measured_samples);
    } else {
        trial.reason = reason;
    }
    return trial;
}

} // namespace

bool validate_run_options(const Options& options, std::string& reason)
{
    reason.clear();
    if (options.width <= 0 || options.width > 8192 || options.height <= 0 ||
        options.height > 8192) {
        reason = "window dimensions must be in 1..8192";
    } else if (!std::isfinite(options.warmup_seconds) || options.warmup_seconds < 0.0 ||
               options.warmup_seconds > 3600.0 || !std::isfinite(options.duration_seconds) ||
               options.duration_seconds <= 0.0 || options.duration_seconds > 3600.0) {
        reason = "invalid warmup or measurement duration";
    } else if (!std::isfinite(options.ready_timeout_seconds) ||
               options.ready_timeout_seconds <= 0.0 || options.ready_timeout_seconds > 3600.0) {
        reason = "invalid readiness timeout";
    } else if (options.repeats == 0 || options.repeats > 20) {
        reason = "repeat count must be in 1..20";
    } else if (options.measurement_frames > kMaxSamplesPerTrial) {
        reason = "fixed frame count exceeds sample capacity (300000)";
    } else if (options.profile != "clean" && options.profile != "diagnostic") {
        reason = "profile must be clean or diagnostic";
    }
    if (!reason.empty())
        return false;
    if (options.alternate) {
        const Options& b = *options.alternate;
        if (b.alternate || b.scenario != options.scenario || options.quick_suite ||
            !options.capacity_dimension.empty() || b.quick_suite || !b.capacity_dimension.empty() ||
            b.width != options.width || b.height != options.height ||
            b.native_resolution != options.native_resolution || b.vsync != options.vsync ||
            b.clock_policy != options.clock_policy || b.profile != options.profile ||
            b.warmup_seconds != options.warmup_seconds ||
            b.duration_seconds != options.duration_seconds ||
            b.measurement_frames != options.measurement_frames ||
            b.ready_timeout_seconds != options.ready_timeout_seconds ||
            b.repeats != options.repeats || b.raw_samples != options.raw_samples) {
            reason = "A/B/A requires the same scenario, timing, clock, graphics settings and "
                     "profile; only workload parameters may differ";
            return false;
        }
        if (!validate_run_options(b, reason))
            return false;
    }
    return valid_capacity_options(options, reason);
}

Distribution summarize(const std::vector<FrameSample>& samples, bool wall)
{
    Distribution result;
    if (samples.empty())
        return result;
    std::vector<double> values;
    values.reserve(samples.size());
    for (const auto& sample : samples)
        values.push_back((wall ? sample.wall_seconds : sample.operation_seconds) * 1000.0);
    return summarize_milliseconds(values);
}

DiagnosticSummary summarize_diagnostics(const std::vector<DiagnosticObservation>& observations,
                                        const std::vector<DiagnosticObservation>& late_observations)
{
    DiagnosticSummary result;
    result.observations = observations.size();
    result.cpu_update_ms = diagnostic_times(observations, &DiagnosticObservation::cpu_update_ms);
    result.rmlui_update_ms =
        diagnostic_times(observations, &DiagnosticObservation::rmlui_update_ms);
    result.rmlui_render_ms =
        diagnostic_times(observations, &DiagnosticObservation::rmlui_render_ms);
    result.ui_fixture_mutation_ms =
        diagnostic_times(observations, &DiagnosticObservation::ui_fixture_mutation_ms);
    result.engine_events_ms =
        diagnostic_times(observations, &DiagnosticObservation::engine_events_ms);
    result.engine_jobs_ms = diagnostic_times(observations, &DiagnosticObservation::engine_jobs_ms);
    result.engine_assets_ms =
        diagnostic_times(observations, &DiagnosticObservation::engine_assets_ms);
    result.engine_update_ms =
        diagnostic_times(observations, &DiagnosticObservation::engine_update_ms);
    result.engine_runtime_ms =
        diagnostic_times(observations, &DiagnosticObservation::engine_runtime_ms);
    result.engine_layout_ms =
        diagnostic_times(observations, &DiagnosticObservation::engine_layout_ms);
    result.engine_render_ms =
        diagnostic_times(observations, &DiagnosticObservation::engine_render_ms);
    result.cpu_submission_ms =
        diagnostic_times(observations, &DiagnosticObservation::cpu_submission_ms);
    result.bgfx_frame_cpu_ms =
        diagnostic_times(observations, &DiagnosticObservation::bgfx_frame_cpu_ms);
    result.bgfx_render_thread_ms =
        diagnostic_times(observations, &DiagnosticObservation::bgfx_render_thread_ms);
    result.bgfx_wait_render_ms =
        diagnostic_times(observations, &DiagnosticObservation::bgfx_wait_render_ms);
    result.bgfx_wait_submit_ms =
        diagnostic_times(observations, &DiagnosticObservation::bgfx_wait_submit_ms);
    result.draw_calls = diagnostic_counts(observations, &DiagnosticObservation::draw_calls);
    result.compute_calls = diagnostic_counts(observations, &DiagnosticObservation::compute_calls);
    result.blit_calls = diagnostic_counts(observations, &DiagnosticObservation::blit_calls);
    result.view_count = diagnostic_counts(observations, &DiagnosticObservation::view_count);
    result.textures = diagnostic_counts(observations, &DiagnosticObservation::textures);
    result.framebuffers = diagnostic_counts(observations, &DiagnosticObservation::framebuffers);
    result.programs = diagnostic_counts(observations, &DiagnosticObservation::programs);
    result.bgfx_stats_observations = result.draw_calls.count;

    // Accept only completed GPU frame IDs that match a measured submission,
    // never the current CPU frame by positional association. Delayed results
    // that remain after the bounded completion drain are simply unavailable.
    std::unordered_set<uint32_t> submissions;
    for (const auto& observation : observations) {
        if (observation.submitted_frame)
            submissions.insert(*observation.submitted_frame);
    }
    std::unordered_set<uint32_t> completed;
    std::vector<double> gpu_times;
    for (const auto& observation : observations) {
        if (observation.gpu_completed_frame && observation.gpu_execution_ms &&
            sample_valid(*observation.gpu_execution_ms) &&
            submissions.contains(*observation.gpu_completed_frame) &&
            completed.insert(*observation.gpu_completed_frame).second)
            gpu_times.push_back(*observation.gpu_execution_ms);
    }
    for (const auto& observation : late_observations) {
        if (observation.gpu_completed_frame && observation.gpu_execution_ms &&
            sample_valid(*observation.gpu_execution_ms) &&
            submissions.contains(*observation.gpu_completed_frame) &&
            completed.insert(*observation.gpu_completed_frame).second)
            gpu_times.push_back(*observation.gpu_execution_ms);
    }
    result.gpu_execution_ms = summarize_milliseconds(gpu_times);
    return result;
}

const std::vector<std::string>& quick_suite_scenarios()
{
    static const std::vector<std::string> scenarios = {
        "raw-bgfx-empty", "raw-bgfx-geometry",           "standalone-rmlui-simple",
        "engine-empty",   "integrated-rmlui-controlled", "integrated-rmlui-production"};
    return scenarios;
}

void append_suite_result(SuiteResult& destination, SuiteResult source)
{
    if (source.instrumentation_control)
        destination.instrumentation_control = source.instrumentation_control;
    for (auto& scenario : source.scenarios)
        destination.scenarios.push_back(std::move(scenario));
    size_t complete = 0;
    bool any_measurements = false;
    bool cancelled = false;
    for (const auto& scenario : destination.scenarios) {
        complete += scenario.outcome == "complete" ? 1u : 0u;
        any_measurements |= scenario.measured_frames != 0;
        cancelled |= scenario.outcome == "cancelled";
    }
    destination.outcome = cancelled ? "cancelled"
                          : complete == destination.scenarios.size()
                              ? "complete"
                              : (any_measurements ? "partial" : "failed");
}

void append_failed_scenario(SuiteResult& destination, std::string id, std::string reason)
{
    ScenarioResult failed;
    failed.scenario = std::move(id);
    failed.description = "scenario could not acquire graphics ownership";
    TrialResult trial;
    trial.reason = std::move(reason);
    failed.trials.push_back(std::move(trial));
    SuiteResult single;
    single.scenarios.push_back(std::move(failed));
    append_suite_result(destination, std::move(single));
}

namespace {
AlternatingSummary summarize_trial_groups(const std::vector<TrialResult>& trials, bool alternating)
{
    AlternatingSummary result;
    auto summarize_group = [&](const char* arm, TrialGroupSummary& group) {
        std::vector<double> wall_medians, cpu_medians, wall_p95, cpu_p95, wall_p99, cpu_p99;
        for (const auto& trial : trials) {
            if (trial.arm != arm || trial.outcome != "complete")
                continue;
            wall_medians.push_back(trial.wall_frame.p50_ms);
            cpu_medians.push_back(trial.cpu_operation.p50_ms);
            wall_p95.push_back(trial.wall_frame.p95_ms);
            cpu_p95.push_back(trial.cpu_operation.p95_ms);
            wall_p99.push_back(trial.wall_frame.p99_ms);
            cpu_p99.push_back(trial.cpu_operation.p99_ms);
            ++group.completed;
        }
        group.wall_medians = summarize_milliseconds(wall_medians);
        group.cpu_medians = summarize_milliseconds(cpu_medians);
        group.wall_p95 = summarize_milliseconds(wall_p95);
        group.cpu_p95 = summarize_milliseconds(cpu_p95);
        group.wall_p99 = summarize_milliseconds(wall_p99);
        group.cpu_p99 = summarize_milliseconds(cpu_p99);
    };
    summarize_group("A", result.baseline);
    if (alternating)
        summarize_group("B", result.candidate);
    const auto percent = [](double after, double before) -> std::optional<double> {
        if (!(before > 0.0))
            return std::nullopt;
        return 100.0 * (after - before) / before;
    };
    if (result.baseline.completed && result.candidate.completed) {
        result.wall_delta_percent =
            percent(result.candidate.wall_medians.p50_ms, result.baseline.wall_medians.p50_ms);
        result.cpu_delta_percent =
            percent(result.candidate.cpu_medians.p50_ms, result.baseline.cpu_medians.p50_ms);
    }
    const TrialResult* first = nullptr;
    const TrialResult* last = nullptr;
    for (const auto& trial : trials) {
        if (trial.arm == "A" && trial.outcome == "complete") {
            if (!first)
                first = &trial;
            last = &trial;
        }
        if (trial.outcome != "complete")
            result.warnings.emplace_back("Incomplete trial; comparison has missing observations");
        if (!trial.interrupted_attempts.empty())
            result.warnings.emplace_back(
                "Interrupted attempt(s); platform/background conditions may have changed");
    }
    if (first && last && first != last) {
        result.wall_drift_percent = percent(last->wall_frame.p50_ms, first->wall_frame.p50_ms);
        result.cpu_drift_percent = percent(last->cpu_operation.p50_ms, first->cpu_operation.p50_ms);
    }
    if (alternating && result.baseline.completed != result.candidate.completed * 2)
        result.warnings.emplace_back("Unequal completed A/B/A arms; paired comparison incomplete");
    for (const auto* group : {&result.baseline, &result.candidate}) {
        if (!alternating && group == &result.candidate)
            continue;
        for (const auto* metric : {&group->wall_medians, &group->cpu_medians}) {
            if (metric->count > 1 && metric->mean_ms > 0.0 &&
                metric->standard_deviation_ms / metric->mean_ms > 0.15)
                result.warnings.emplace_back("High between-trial variability (CV > 15%); check "
                                             "background activity and thermals");
        }
    }
    if ((result.wall_drift_percent && std::abs(*result.wall_drift_percent) > 10.0) ||
        (result.cpu_drift_percent && std::abs(*result.cpu_drift_percent) > 10.0))
        result.warnings.emplace_back(
            alternating
                ? "A-arm drift exceeds 10%; thermal or background effects are possible"
                : "Repeated-trial drift exceeds 10%; thermal or background effects are possible");
    return result;
}
} // namespace

std::optional<AlternatingSummary> summarize_alternating(const std::vector<TrialResult>& trials,
                                                        bool enabled)
{
    if (!enabled && std::none_of(trials.begin(), trials.end(),
                                 [](const TrialResult& trial) { return trial.arm == "B"; }))
        return std::nullopt;
    return summarize_trial_groups(trials, true);
}

std::optional<RepeatedSummary> summarize_repeated(const std::vector<TrialResult>& trials,
                                                  bool alternating)
{
    if (alternating || trials.size() < 2)
        return std::nullopt;
    auto group = summarize_trial_groups(trials, false);
    return RepeatedSummary{std::move(group.baseline), group.wall_drift_percent,
                           group.cpu_drift_percent, std::move(group.warnings)};
}

SuiteResult run_suite(const Options& options, const std::vector<Scenario*>& scenarios, Clock& clock,
                      Recovery recovery)
{
    SuiteResult suite;
    std::string error;
    if (!validate_run_options(options, error) || scenarios.empty())
        return suite;

    uint64_t successful_scenarios = 0;
    uint64_t completed_trials = 0;
    for (Scenario* scenario : scenarios) {
        ScenarioResult result;
        if (!scenario) {
            result.scenario = "null";
            suite.scenarios.push_back(std::move(result));
            continue;
        }
        result.scenario = scenario->id();
        result.description = scenario->description();
        std::vector<FrameSample> combined_samples;
        bool cancelled = false;
        const uint32_t trial_count = options.repeats * (options.alternate ? 3u : 1u);
        for (uint32_t trial_number = 0; trial_number < trial_count; ++trial_number) {
            const bool candidate = options.alternate && trial_number % 3 == 1;
            const Options& current = candidate ? *options.alternate : options;
            const size_t capacity = current.measurement_frames != 0
                                        ? static_cast<size_t>(current.measurement_frames)
                                        : static_cast<size_t>(kMaxSamplesPerTrial);
            // Allocate before preparing each trial; no growth during the sample window.
            std::vector<FrameSample> samples(capacity);
            std::vector<DiagnosticObservation> observations;
            if (current.profile == "diagnostic")
                observations.resize(capacity);
            TrialResult trial;
            std::vector<InterruptedAttempt> attempts;
            uint32_t retries = 0;
            while (true) {
                trial = run_trial(current, *scenario, clock, samples, observations);
                trial.arm = candidate ? "B" : "A";
                const auto interruption = scenario->interruption();
                if (trial.outcome == "complete" || interruption == Interruption::None)
                    break;
                if (interruption == Interruption::Cancelled) {
                    trial.outcome = "cancelled";
                    cancelled = true;
                    break;
                }
                // Failed cleanup cannot safely be followed by a new graphics owner.
                if (trial.reason.find("cleanup failed") != std::string::npos)
                    break;
                if (retries == kMaxInterruptionRetries) {
                    trial.reason = "interruption retry limit exceeded: " + trial.reason;
                    break;
                }
                attempts.push_back({trial.reason, trial.warmup_frames, trial.measured_frames});
                ++retries;
                if (recovery) {
                    std::string error;
                    RecoveryState state;
                    do {
                        state = recovery(error);
                        if (state == RecoveryState::Pending)
                            std::this_thread::sleep_for(std::chrono::milliseconds(50));
                    } while (state == RecoveryState::Pending);
                    if (state == RecoveryState::Failed) {
                        trial.reason = "graphics recovery failed: " + error;
                        break;
                    }
                }
                // Recreate every resource and repeat warmup. Never aggregate a
                // discarded attempt's frames or wall time.
            }
            trial.interruption_retries = retries;
            trial.interrupted_attempts = std::move(attempts);
            if (trial.outcome == "complete") {
                combined_samples.insert(combined_samples.end(), samples.begin(),
                                        samples.begin() +
                                            static_cast<std::ptrdiff_t>(trial.measured_frames));
                result.measured_frames += trial.measured_frames;
                result.measured_wall_seconds += trial.measured_wall_seconds;
            }
            result.trials.push_back(std::move(trial));
            if (cancelled)
                break;
        }
        const auto passed =
            std::count_if(result.trials.begin(), result.trials.end(),
                          [](const TrialResult& trial) { return trial.outcome == "complete"; });
        completed_trials += static_cast<uint64_t>(passed);
        result.outcome = cancelled ? "cancelled"
                         : passed == static_cast<std::ptrdiff_t>(trial_count)
                             ? "complete"
                             : (passed > 0 ? "partial" : "failed");
        result.wall_frame = summarize(combined_samples, true);
        result.cpu_operation = summarize(combined_samples, false);
        result.alternating = summarize_alternating(result.trials, options.alternate != nullptr);
        result.repeated = summarize_repeated(result.trials, options.alternate != nullptr);
        if (result.outcome == "complete")
            ++successful_scenarios;
        suite.scenarios.push_back(std::move(result));
        if (cancelled) {
            suite.outcome = "cancelled";
            return suite;
        }
    }
    // Optional clock-control exercise executes only after every measured trial.
    if (options.profile == "diagnostic")
        suite.instrumentation_control = measure_timer_overhead();
    if (successful_scenarios == suite.scenarios.size())
        suite.outcome = "complete";
    else if (completed_trials > 0)
        suite.outcome = "partial";
    return suite;
}

} // namespace noveltea::benchmark
