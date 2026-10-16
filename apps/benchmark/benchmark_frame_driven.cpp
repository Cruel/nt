#include "benchmark_runner.hpp"

#include <algorithm>
#include <cstddef>
#include <utility>

namespace noveltea::benchmark {
namespace {
constexpr uint64_t kMaxSamples = 300000;
bool valid(double seconds) { return seconds >= 0.0 && seconds < 3600.0; }
} // namespace

FrameDrivenSuite::FrameDrivenSuite(const Options& options, Scenario& scenario, Clock& clock)
    : options_(options), scenario_(scenario), clock_(clock)
{
    scenario_result_.scenario = scenario.id();
    scenario_result_.description = scenario.description();
}

void FrameDrivenSuite::interrupt(std::string reason)
{
    if (!done_ && phase_ != Phase::Cleanup) {
        reason_ = std::move(reason);
        phase_ = Phase::Cleanup;
    }
}

void FrameDrivenSuite::finish_trial()
{
    trial_.phases.push_back(Phase::Cleanup);
    std::string cleanup_error;
    if (!scenario_.cleanup(cleanup_error)) {
        if (!reason_.empty())
            reason_ += "; ";
        reason_ += cleanup_error.empty() ? "cleanup failed" : "cleanup failed: " + cleanup_error;
    }
    if (results_ready_ && reason_.empty()) {
        trial_.outcome = "complete";
        std::vector<FrameSample> measured(samples_.begin(),
                                          samples_.begin() +
                                              static_cast<std::ptrdiff_t>(trial_.measured_frames));
        trial_.wall_frame = summarize(measured, true);
        trial_.cpu_operation = summarize(measured, false);
        if (options_.profile == "diagnostic") {
            observations_.resize(static_cast<size_t>(trial_.measured_frames));
            trial_.diagnostic = summarize_diagnostics(observations_, late_);
        }
        if (options_.raw_samples)
            trial_.raw_samples = measured;
        combined_.insert(combined_.end(), measured.begin(), measured.end());
        scenario_result_.measured_frames += trial_.measured_frames;
        scenario_result_.measured_wall_seconds += trial_.measured_wall_seconds;
    } else {
        trial_.reason = reason_.empty() ? "scenario preparation failed" : reason_;
    }
    scenario_result_.trials.push_back(std::move(trial_));
    ++trial_index_;
    if (trial_index_ < options_.repeats) {
        phase_ = Phase::Preparation;
        reason_.clear();
        results_ready_ = false;
        trial_ = {};
        late_.clear();
        return;
    }
    const auto passed =
        std::count_if(scenario_result_.trials.begin(), scenario_result_.trials.end(),
                      [](const TrialResult& item) { return item.outcome == "complete"; });
    scenario_result_.outcome = passed == static_cast<std::ptrdiff_t>(options_.repeats)
                                   ? "complete"
                                   : (passed > 0 ? "partial" : "failed");
    scenario_result_.wall_frame = summarize(combined_, true);
    scenario_result_.cpu_operation = summarize(combined_, false);
    suite_.outcome = scenario_result_.outcome;
    suite_.scenarios.push_back(std::move(scenario_result_));
    done_ = true;
}

bool FrameDrivenSuite::step()
{
    if (done_)
        return true;
    switch (phase_) {
    case Phase::Preparation: {
        reason_.clear();
        trial_.phases.push_back(Phase::Preparation);
        const size_t capacity = options_.measurement_frames != 0
                                    ? static_cast<size_t>(options_.measurement_frames)
                                    : static_cast<size_t>(kMaxSamples);
        samples_.assign(capacity, {});
        observations_.clear();
        late_.clear();
        if (options_.profile == "diagnostic")
            observations_.resize(capacity);
        if (!scenario_.prepare(options_, reason_)) {
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
            clock_.now_seconds() - readiness_start_ <= options_.ready_timeout_seconds) {
            trial_.phases.push_back(Phase::Ready);
            trial_.phases.push_back(Phase::Warmup);
            warmup_start_ = clock_.now_seconds();
            phase_ = Phase::Warmup;
        } else if (readiness == Readiness::Failed ||
                   clock_.now_seconds() - readiness_start_ >= options_.ready_timeout_seconds) {
            if (readiness != Readiness::Failed)
                reason_ = "readiness timeout";
            else if (reason_.empty())
                reason_ = "scenario readiness failed";
            phase_ = Phase::Cleanup;
        }
        break;
    }
    case Phase::Warmup:
        if (clock_.now_seconds() - warmup_start_ >= options_.warmup_seconds) {
            trial_.phases.push_back(Phase::Measurement);
            measurement_start_ = clock_.now_seconds();
            previous_end_ = measurement_start_;
            phase_ = Phase::Measurement;
        } else if (!scenario_.frame(reason_)) {
            if (reason_.empty())
                reason_ = "warmup frame failed";
            phase_ = Phase::Cleanup;
        } else {
            ++trial_.warmup_frames;
        }
        break;
    case Phase::Measurement: {
        if (trial_.measured_frames == samples_.size()) {
            reason_ = "sample capacity exceeded";
            phase_ = Phase::Cleanup;
            break;
        }
        const double start = clock_.now_seconds();
        if (!scenario_.frame(reason_)) {
            if (reason_.empty())
                reason_ = "measurement frame failed";
            phase_ = Phase::Cleanup;
            break;
        }
        const double end = clock_.now_seconds();
        const FrameSample sample{end - previous_end_, end - start};
        if (!valid(sample.wall_seconds) || !valid(sample.operation_seconds) ||
            end <= measurement_start_) {
            reason_ = "non-monotonic or invalid frame timing";
            phase_ = Phase::Cleanup;
            break;
        }
        samples_[static_cast<size_t>(trial_.measured_frames)] = sample;
        if (options_.profile == "diagnostic")
            scenario_.diagnostic_frame(observations_[static_cast<size_t>(trial_.measured_frames)]);
        ++trial_.measured_frames;
        previous_end_ = end;
        trial_.measured_wall_seconds = end - measurement_start_;
        if (options_.measurement_frames != 0
                ? trial_.measured_frames >= options_.measurement_frames
                : trial_.measured_wall_seconds >= options_.duration_seconds)
            phase_ = Phase::Completion;
        break;
    }
    case Phase::Completion:
        trial_.phases.push_back(Phase::Completion);
        if (!scenario_.complete(reason_)) {
            if (reason_.empty())
                reason_ = "scenario completion failed";
        } else {
            if (options_.profile == "diagnostic")
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

} // namespace noveltea::benchmark
