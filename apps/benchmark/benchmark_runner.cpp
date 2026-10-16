#include "benchmark_runner.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <numeric>
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
                if (!scenario.frame(reason)) {
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
                while (true) {
                    if (trial.measured_frames == samples.size()) {
                        measured = false;
                        reason = "sample capacity exceeded";
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
                    const FrameSample sample{frame_end - previous_end, frame_end - frame_start};
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
                    if (options.measurement_frames != 0
                            ? trial.measured_frames >= options.measurement_frames
                            : frame_end - measured_start >= options.duration_seconds)
                        break;
                }
                trial.measured_wall_seconds = previous_end - measured_start;
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
    return reason.empty();
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

SuiteResult run_suite(const Options& options, const std::vector<Scenario*>& scenarios, Clock& clock)
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
        for (uint32_t trial_number = 0; trial_number < options.repeats; ++trial_number) {
            const size_t capacity = options.measurement_frames != 0
                                        ? static_cast<size_t>(options.measurement_frames)
                                        : static_cast<size_t>(kMaxSamplesPerTrial);
            // Allocate before preparing each trial; no growth during the sample window.
            std::vector<FrameSample> samples(capacity);
            std::vector<DiagnosticObservation> observations;
            if (options.profile == "diagnostic")
                observations.resize(capacity);
            auto trial = run_trial(options, *scenario, clock, samples, observations);
            if (trial.outcome == "complete") {
                combined_samples.insert(combined_samples.end(), samples.begin(),
                                        samples.begin() +
                                            static_cast<std::ptrdiff_t>(trial.measured_frames));
                result.measured_frames += trial.measured_frames;
                result.measured_wall_seconds += trial.measured_wall_seconds;
            }
            result.trials.push_back(std::move(trial));
        }
        const auto passed =
            std::count_if(result.trials.begin(), result.trials.end(),
                          [](const TrialResult& trial) { return trial.outcome == "complete"; });
        completed_trials += static_cast<uint64_t>(passed);
        result.outcome = passed == static_cast<std::ptrdiff_t>(result.trials.size())
                             ? "complete"
                             : (passed > 0 ? "partial" : "failed");
        result.wall_frame = summarize(combined_samples, true);
        result.cpu_operation = summarize(combined_samples, false);
        if (result.outcome == "complete")
            ++successful_scenarios;
        suite.scenarios.push_back(std::move(result));
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
