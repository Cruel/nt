#include "benchmark_runner.hpp"

#include <algorithm>
#include <cstddef>
#include <utility>

namespace noveltea::benchmark {
namespace {
constexpr uint64_t kMaxSamples = 300000;
bool valid(double seconds) { return seconds >= 0.0 && seconds < 3600.0; }
} // namespace

FrameDrivenSuite::FrameDrivenSuite(const Options& options, Scenario& scenario, Clock& clock,
                                   Recovery recovery, bool headless_batches)
    : options_(options), active_options_(options), scenario_(scenario), clock_(clock),
      recovery_(std::move(recovery)), headless_batches_(headless_batches)
{
    scenario_result_.scenario = scenario.id();
    scenario_result_.description = scenario.description();
}

void FrameDrivenSuite::interrupt(std::string reason)
{
    if (!done_ && !cancelled_) {
        reason_ = std::move(reason);
        interrupted_ = true;
        phase_ = Phase::Cleanup;
    }
}

void FrameDrivenSuite::cancel(std::string reason)
{
    if (!done_) {
        reason_ = std::move(reason);
        cancelled_ = true;
        interrupted_ = false;
        recovering_ = false;
        phase_ = Phase::Cleanup;
    }
}

void FrameDrivenSuite::cancel_without_cleanup(std::string reason)
{
    cancel(std::move(reason));
    // A terminal report is safe without GL; GPU cleanup belongs to the host
    // after the context returns. Skip any second cleanup if already recovering.
    cleanup_completed_ = true;
}

void FrameDrivenSuite::fail_frame(std::string fallback)
{
    if (reason_.empty())
        reason_ = std::move(fallback);
    if (scenario_.interruption() == Interruption::Recoverable)
        interrupted_ = true;
    else if (scenario_.interruption() == Interruption::Cancelled)
        cancelled_ = true;
    phase_ = Phase::Cleanup;
}

void FrameDrivenSuite::finish_trial()
{
    trial_.phases.push_back(Phase::Cleanup);
    std::string cleanup_error;
    // Cancellation can arrive while waiting for recovery, after the
    // interrupted attempt has *already* released its graphics resources.
    const bool cleanup_ok = cleanup_completed_ || scenario_.cleanup(cleanup_error);
    cleanup_completed_ = true;
    if (!cleanup_ok) {
        // Never begin another trial or acquire a new graphics host after a
        // failed teardown, including when an interruption was recoverable.
        terminal_cleanup_failed_ = true;
        if (!reason_.empty())
            reason_ += "; ";
        reason_ += cleanup_error.empty() ? "cleanup failed" : "cleanup failed: " + cleanup_error;
    }
    // Never publish incomplete measurements. Only a recovered, fresh warmup
    // may supply the logical trial's samples and aggregate.
    if (interrupted_ && cleanup_ok && !cancelled_ && retry_count_ < kMaxInterruptionRetries) {
        interrupted_attempts_.push_back({reason_, trial_.warmup_frames, trial_.measured_frames});
        ++retry_count_;
        recovering_ = true;
        reason_.clear();
        results_ready_ = false;
        trial_ = {};
        late_.clear();
        return;
    }
    trial_.interruption_retries = retry_count_;
    trial_.arm = options_.alternate && trial_index_ % 3 == 1 ? "B" : "A";
    trial_.interrupted_attempts = std::move(interrupted_attempts_);
    if (interrupted_ && retry_count_ == kMaxInterruptionRetries)
        reason_ = "interruption retry limit exceeded: " + reason_;
    if (results_ready_ && reason_.empty() && trial_.measured_wall_seconds <= 0.0)
        reason_ = "clock resolution insufficient to measure any elapsed work";
    if (results_ready_ && reason_.empty()) {
        trial_.outcome = "complete";
        std::vector<FrameSample> measured(samples_.begin(),
                                          samples_.begin() +
                                              static_cast<std::ptrdiff_t>(trial_.measured_frames));
        trial_.wall_frame = summarize(measured, true);
        trial_.cpu_operation = summarize(measured, false);
        if (active_options_.profile == "diagnostic") {
            observations_.resize(static_cast<size_t>(trial_.measured_frames));
            trial_.diagnostic = summarize_diagnostics(observations_, late_);
        }
        if (active_options_.raw_samples)
            trial_.raw_samples = measured;
        combined_.insert(combined_.end(), measured.begin(), measured.end());
        scenario_result_.measured_frames += trial_.measured_frames;
        scenario_result_.measured_wall_seconds += trial_.measured_wall_seconds;
    } else {
        trial_.reason = reason_.empty() ? "scenario preparation failed" : reason_;
        if (cancelled_)
            trial_.outcome = "cancelled";
    }
    scenario_result_.trials.push_back(std::move(trial_));
    ++trial_index_;
    const uint32_t trial_count = options_.repeats * (options_.alternate ? 3u : 1u);
    if (!cancelled_ && !terminal_cleanup_failed_ && trial_index_ < trial_count) {
        phase_ = Phase::Preparation;
        reason_.clear();
        results_ready_ = false;
        interrupted_ = false;
        retry_count_ = 0;
        interrupted_attempts_.clear();
        trial_ = {};
        late_.clear();
        return;
    }
    const auto passed =
        std::count_if(scenario_result_.trials.begin(), scenario_result_.trials.end(),
                      [](const TrialResult& item) { return item.outcome == "complete"; });
    scenario_result_.outcome = cancelled_ ? "cancelled"
                               : passed == static_cast<std::ptrdiff_t>(trial_count)
                                   ? "complete"
                                   : (passed > 0 ? "partial" : "failed");
    scenario_result_.wall_frame = summarize(combined_, true);
    scenario_result_.cpu_operation = summarize(combined_, false);
    scenario_result_.alternating =
        summarize_alternating(scenario_result_.trials, options_.alternate != nullptr);
    scenario_result_.repeated =
        summarize_repeated(scenario_result_.trials, options_.alternate != nullptr);
    suite_.outcome = scenario_result_.outcome;
    suite_.scenarios.push_back(std::move(scenario_result_));
    done_ = true;
}

bool FrameDrivenSuite::step()
{
    if (done_)
        return true;
    if (recovering_) {
        std::string error;
        const auto state = recovery_ ? recovery_(error) : RecoveryState::Ready;
        if (state == RecoveryState::Pending)
            return false;
        recovering_ = false;
        if (state == RecoveryState::Failed) {
            reason_ = error.empty() ? "graphics recovery failed" : "graphics recovery: " + error;
            interrupted_ = false;
            phase_ = Phase::Cleanup;
            // Cleanup was already performed for this attempt.
            // Report terminal failure without running it twice.
            trial_.reason = reason_;
            trial_.interruption_retries = retry_count_;
            trial_.arm = options_.alternate && trial_index_ % 3 == 1 ? "B" : "A";
            trial_.interrupted_attempts = std::move(interrupted_attempts_);
            scenario_result_.trials.push_back(std::move(trial_));
            trial_index_ = options_.repeats * (options_.alternate ? 3u : 1u);
            scenario_result_.outcome = combined_.empty() ? "failed" : "partial";
            scenario_result_.wall_frame = summarize(combined_, true);
            scenario_result_.cpu_operation = summarize(combined_, false);
            scenario_result_.alternating =
                summarize_alternating(scenario_result_.trials, options_.alternate != nullptr);
            scenario_result_.repeated =
                summarize_repeated(scenario_result_.trials, options_.alternate != nullptr);
            suite_.outcome = scenario_result_.outcome;
            suite_.scenarios.push_back(std::move(scenario_result_));
            done_ = true;
            return true;
        }
        interrupted_ = false;
        trial_ = {};
        phase_ = Phase::Preparation;
    }
    switch (phase_) {
    case Phase::Preparation: {
        cleanup_completed_ = false;
        reason_.clear();
        trial_.phases.push_back(Phase::Preparation);
        active_options_ =
            options_.alternate && trial_index_ % 3 == 1 ? *options_.alternate : options_;
        const size_t capacity = active_options_.measurement_frames != 0
                                    ? static_cast<size_t>(active_options_.measurement_frames)
                                    : static_cast<size_t>(kMaxSamples);
        samples_.assign(capacity, {});
        warmup_active_seconds_ = 0.0;
        observations_.clear();
        late_.clear();
        if (active_options_.profile == "diagnostic")
            observations_.resize(capacity);
        if (!scenario_.prepare(active_options_, reason_)) {
            phase_ = Phase::Cleanup;
        } else {
            readiness_start_ = clock_.now_seconds();
            phase_ = Phase::Ready;
        }
        break;
    }
    case Phase::Ready: {
        const auto readiness = scenario_.readiness(reason_);
        if (readiness == Readiness::Ready &&
            clock_.now_seconds() - readiness_start_ <= active_options_.ready_timeout_seconds) {
            trial_.phases.push_back(Phase::Ready);
            trial_.phases.push_back(Phase::Warmup);
            warmup_start_ = clock_.now_seconds();
            phase_ = Phase::Warmup;
        } else if (readiness == Readiness::Failed || clock_.now_seconds() - readiness_start_ >=
                                                         active_options_.ready_timeout_seconds) {
            if (readiness != Readiness::Failed)
                reason_ = "readiness timeout";
            else if (reason_.empty())
                reason_ = "scenario readiness failed";
            phase_ = Phase::Cleanup;
        }
        break;
    }
    case Phase::Warmup:
        if ((headless_batches_ ? warmup_active_seconds_ : clock_.now_seconds() - warmup_start_) >=
            active_options_.warmup_seconds) {
            trial_.phases.push_back(Phase::Measurement);
            measurement_start_ = clock_.now_seconds();
            previous_end_ = measurement_start_;
            phase_ = Phase::Measurement;
        } else if (!scenario_.prepare_frame(reason_)) {
            fail_frame("warmup preparation failed");
        } else {
            const double start = clock_.now_seconds();
            if (!scenario_.frame(reason_))
                fail_frame("warmup frame failed");
            else {
                warmup_active_seconds_ += clock_.now_seconds() - start;
                ++trial_.warmup_frames;
            }
        }
        break;
    case Phase::Measurement: {
        if (trial_.measured_frames == samples_.size()) {
            reason_ = "sample capacity exceeded";
            phase_ = Phase::Cleanup;
            break;
        }
        if (!scenario_.prepare_frame(reason_)) {
            fail_frame("measurement preparation failed");
            break;
        }
        const double start = clock_.now_seconds();
        if (!scenario_.frame(reason_)) {
            fail_frame("measurement frame failed");
            break;
        }
        const double end = clock_.now_seconds();
        const double operation = end - start;
        const bool active_timing = headless_batches_ || scenario_.active_operation_timing();
        const FrameSample sample{active_timing ? operation : end - previous_end_, operation};
        if (!valid(sample.wall_seconds) || !valid(sample.operation_seconds) ||
            (!active_timing && end <= measurement_start_)) {
            reason_ = "non-monotonic or invalid frame timing";
            phase_ = Phase::Cleanup;
            break;
        }
        samples_[static_cast<size_t>(trial_.measured_frames)] = sample;
        if (active_options_.profile == "diagnostic")
            scenario_.diagnostic_frame(observations_[static_cast<size_t>(trial_.measured_frames)]);
        ++trial_.measured_frames;
        previous_end_ = end;
        if (active_timing)
            trial_.measured_wall_seconds += operation;
        else
            trial_.measured_wall_seconds = end - measurement_start_;
        if (active_options_.measurement_frames != 0
                ? trial_.measured_frames >= active_options_.measurement_frames
                : trial_.measured_wall_seconds >= active_options_.duration_seconds)
            phase_ = Phase::Completion;
        break;
    }
    case Phase::Completion:
        trial_.phases.push_back(Phase::Completion);
        if (!scenario_.complete(reason_)) {
            if (reason_.empty())
                reason_ = "scenario completion failed";
        } else {
            if (active_options_.profile == "diagnostic")
                scenario_.diagnostic_completion(late_);
            trial_.phases.push_back(Phase::Results);
            results_ready_ = true;
            reason_.clear();
        }
        phase_ = Phase::Cleanup;
        break;
    case Phase::Results:
        phase_ = Phase::Cleanup;
        break;
    case Phase::Cleanup:
        finish_trial();
        break;
    }
    return done_;
}

bool FrameDrivenSuite::step_bounded_batch()
{
    // A callback spends at most ~8 ms in headless CPU work (except for a
    // single indivisible operation), leaving the browser time for input and
    // visibility/cancellation events before the next rAF callback.
    const double start = clock_.now_seconds();
    for (unsigned unit = 0; unit < 64; ++unit) {
        if (step())
            return true;
        if (clock_.now_seconds() - start >= 0.008)
            break;
    }
    return false;
}

} // namespace noveltea::benchmark
