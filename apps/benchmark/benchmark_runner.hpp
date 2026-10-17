#pragma once

#include "benchmark_options.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::benchmark {

enum class Phase {
    Preparation,
    Ready,
    Warmup,
    Measurement,
    Completion,
    Results,
    Cleanup
};
enum class Readiness {
    Pending,
    Ready,
    Failed
};
// Platform interruptions are not workload failures; cancelled trials never retry.
enum class Interruption {
    None,
    Recoverable,
    Cancelled
};
enum class RecoveryState {
    Pending,
    Ready,
    Failed
};
constexpr uint32_t kMaxInterruptionRetries = 3;
using Recovery = std::function<RecoveryState(std::string&)>;

struct FrameSample {
    double wall_seconds = 0.0;
    double operation_seconds = 0.0;
};

struct Distribution {
    uint64_t count = 0;
    double mean_ms = 0.0;
    double min_ms = 0.0;
    double max_ms = 0.0;
    double p50_ms = 0.0;
    double p95_ms = 0.0;
    double p99_ms = 0.0;
    double standard_deviation_ms = 0.0;
};

// Populated only for Diagnostic frames. bgfx stats describe an asynchronous
// completed-frame snapshot, not necessarily the frame just submitted.
struct DiagnosticObservation {
    std::optional<double> cpu_update_ms;
    // Owner-specific Diagnostic timings, absent for unsupported scenarios.
    std::optional<double> rmlui_update_ms;
    std::optional<double> rmlui_render_ms;
    std::optional<double> ui_fixture_mutation_ms;
    std::optional<double> engine_events_ms;
    std::optional<double> engine_jobs_ms;
    std::optional<double> engine_assets_ms;
    std::optional<double> engine_update_ms;
    std::optional<double> engine_runtime_ms;
    std::optional<double> engine_layout_ms;
    std::optional<double> engine_render_ms;
    std::optional<double> cpu_submission_ms;
    std::optional<double> bgfx_frame_cpu_ms;
    std::optional<double> bgfx_render_thread_ms;
    std::optional<double> bgfx_wait_render_ms;
    std::optional<double> bgfx_wait_submit_ms;
    std::optional<double> gpu_execution_ms;
    std::optional<uint32_t> submitted_frame;
    std::optional<uint32_t> gpu_completed_frame;
    std::optional<uint32_t> draw_calls;
    std::optional<uint32_t> compute_calls;
    std::optional<uint32_t> blit_calls;
    std::optional<uint32_t> view_count;
    std::optional<uint32_t> textures;
    std::optional<uint32_t> framebuffers;
    std::optional<uint32_t> programs;
};

struct CounterSummary {
    uint64_t count = 0;
    double mean = 0.0;
    uint32_t min = 0;
    uint32_t max = 0;
};

struct DiagnosticSummary {
    uint64_t observations = 0;
    uint64_t bgfx_stats_observations = 0;
    Distribution cpu_update_ms;
    Distribution rmlui_update_ms;
    Distribution rmlui_render_ms;
    Distribution ui_fixture_mutation_ms;
    Distribution engine_events_ms;
    Distribution engine_jobs_ms;
    Distribution engine_assets_ms;
    Distribution engine_update_ms;
    Distribution engine_runtime_ms;
    Distribution engine_layout_ms;
    Distribution engine_render_ms;
    Distribution cpu_submission_ms;
    Distribution bgfx_frame_cpu_ms;
    Distribution bgfx_render_thread_ms;
    Distribution bgfx_wait_render_ms;
    Distribution bgfx_wait_submit_ms;
    Distribution gpu_execution_ms;
    CounterSummary draw_calls;
    CounterSummary compute_calls;
    CounterSummary blit_calls;
    CounterSummary view_count;
    CounterSummary textures;
    CounterSummary framebuffers;
    CounterSummary programs;
};

struct InterruptedAttempt {
    std::string reason;
    uint64_t warmup_frames = 0;
    uint64_t measured_frames = 0;
};

struct TrialResult {
    std::string arm = "A";
    std::vector<InterruptedAttempt> interrupted_attempts;
    std::string outcome = "failed";
    std::string reason;
    std::vector<Phase> phases;
    uint32_t interruption_retries = 0;
    uint64_t warmup_frames = 0;
    uint64_t measured_frames = 0;
    double measured_wall_seconds = 0.0;
    Distribution wall_frame;
    Distribution cpu_operation;
    DiagnosticSummary diagnostic;
    std::vector<FrameSample> raw_samples;
};

struct TrialGroupSummary {
    uint32_t completed = 0;
    Distribution wall_medians;
    Distribution cpu_medians;
    Distribution wall_p95;
    Distribution cpu_p95;
    Distribution wall_p99;
    Distribution cpu_p99;
};

struct AlternatingSummary {
    TrialGroupSummary baseline;
    TrialGroupSummary candidate;
    std::optional<double> wall_delta_percent;
    std::optional<double> cpu_delta_percent;
    std::optional<double> wall_drift_percent;
    std::optional<double> cpu_drift_percent;
    std::vector<std::string> warnings;
};

struct ScenarioResult {
    std::optional<AlternatingSummary> alternating;
    std::string scenario;
    std::string description;
    std::vector<TrialResult> trials;
    std::string outcome = "failed";
    uint64_t measured_frames = 0;
    double measured_wall_seconds = 0.0;
    Distribution wall_frame;
    Distribution cpu_operation;
};

struct InstrumentationControl {
    uint64_t iterations = 0;
    double two_clock_reads_ns = 0.0;
    double four_clock_reads_ns = 0.0;
    double incremental_ns = 0.0;
};

struct CapacityProbe {
    uint32_t workload = 0;
    std::string outcome;
    std::optional<double> observed;
    uint64_t completed_batches = 0;
    uint64_t completed_work_units = 0;
    std::optional<double> work_units_per_cpu_second;
};

struct CapacityResult {
    std::string dimension;
    std::string target;
    double threshold = 0.0;
    std::string mode;
    std::string status = "inconclusive";
    std::string reason;
    std::optional<uint32_t> maximum_passing_workload;
    std::vector<CapacityProbe> probes;
};

struct SuiteResult {
    std::optional<CapacityResult> capacity;
    std::vector<ScenarioResult> scenarios;
    std::string outcome = "failed";
    std::optional<InstrumentationControl> instrumentation_control;
};

// The fixed reference comparison order; each scenario keeps its own trials and outcome.
[[nodiscard]] const std::vector<std::string>& quick_suite_scenarios();
// Append a separately executed scenario and recompute the suite outcome. A failed
// scenario is not a reason to discard subsequent independent comparisons.
void append_suite_result(SuiteResult& destination, SuiteResult source);
void append_failed_scenario(SuiteResult& destination, std::string id, std::string reason);

class Clock {
public:
    virtual ~Clock() = default;
    [[nodiscard]] virtual double now_seconds() = 0;
};

class Scenario {
public:
    virtual ~Scenario() = default;
    [[nodiscard]] virtual const char* id() const = 0;
    [[nodiscard]] virtual const char* description() const = 0;
    [[nodiscard]] virtual bool requires_graphics() const = 0;
    virtual bool prepare(const Options& options, std::string& reason) = 0;
    virtual Readiness readiness(std::string& reason) = 0;
    virtual bool frame(std::string& reason) = 0;
    // Only called after a successful measured frame in the Diagnostic profile.
    // CPU-only scenarios and unsupported backends leave fields unavailable.
    virtual void diagnostic_frame(DiagnosticObservation&) {}
    // Optional late GPU observations after the timed interval, before cleanup.
    // Must not be used to infer a CPU-to-GPU frame pairing without IDs.
    virtual void diagnostic_completion(std::vector<DiagnosticObservation>&) {}
    virtual bool complete(std::string& reason) = 0;
    // Return false with a diagnostic if teardown cannot release scenario resources.
    virtual bool cleanup(std::string& reason) = 0;
    // A scenario that consumes native lifecycle/input events identifies the
    // interruption that caused frame() to fail. Reset in prepare().
    [[nodiscard]] virtual Interruption interruption() const { return Interruption::None; }
};

[[nodiscard]] bool validate_run_options(const Options& options, std::string& reason);
[[nodiscard]] Distribution summarize(const std::vector<FrameSample>& samples, bool wall);
[[nodiscard]] DiagnosticSummary
summarize_diagnostics(const std::vector<DiagnosticObservation>& observations,
                      const std::vector<DiagnosticObservation>& late_observations = {});
[[nodiscard]] std::optional<AlternatingSummary>
summarize_alternating(const std::vector<TrialResult>& trials, bool enabled = false);
[[nodiscard]] SuiteResult run_suite(const Options& options, const std::vector<Scenario*>& scenarios,
                                    Clock& clock, Recovery recovery = {});

// Browser/event-loop runner: advance at most one workload frame per host callback.
// Unlike run_suite, the caller owns pacing (requestAnimationFrame on Web).
class FrameDrivenSuite {
public:
    FrameDrivenSuite(const Options& options, Scenario& scenario, Clock& clock,
                     Recovery recovery = {});
    [[nodiscard]] bool step(); // true when results and cleanup are complete
    void interrupt(std::string reason);
    void cancel(std::string reason);
    // For hosts whose graphics context is unavailable: produce a terminal
    // cancelled result without calling Scenario::cleanup(). The caller must
    // retain the scenario and dispose of its GPU resources after restoration.
    void cancel_without_cleanup(std::string reason);
    [[nodiscard]] const SuiteResult& result() const { return suite_; }

private:
    void finish_trial();
    void fail_frame(std::string fallback);
    Options options_;
    Options active_options_;
    std::vector<InterruptedAttempt> interrupted_attempts_;
    Scenario& scenario_;
    Clock& clock_;
    Recovery recovery_;
    SuiteResult suite_;
    ScenarioResult scenario_result_;
    TrialResult trial_;
    std::vector<FrameSample> samples_;
    std::vector<FrameSample> combined_;
    std::vector<DiagnosticObservation> observations_;
    std::vector<DiagnosticObservation> late_;
    Phase phase_ = Phase::Preparation;
    std::string reason_;
    uint32_t trial_index_ = 0;
    bool done_ = false;
    bool results_ready_ = false;
    bool cleanup_completed_ = false;
    bool recovering_ = false;
    bool interrupted_ = false;
    bool cancelled_ = false;
    uint32_t retry_count_ = 0;
    double readiness_start_ = 0.0;
    double warmup_start_ = 0.0;
    double measurement_start_ = 0.0;
    double previous_end_ = 0.0;
};

} // namespace noveltea::benchmark
