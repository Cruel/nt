#pragma once

#include "benchmark_options.hpp"

#include <cstdint>
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

struct TrialResult {
    std::string outcome = "failed";
    std::string reason;
    std::vector<Phase> phases;
    uint64_t warmup_frames = 0;
    uint64_t measured_frames = 0;
    double measured_wall_seconds = 0.0;
    Distribution wall_frame;
    Distribution cpu_operation;
    DiagnosticSummary diagnostic;
    std::vector<FrameSample> raw_samples;
};

struct ScenarioResult {
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

struct SuiteResult {
    std::vector<ScenarioResult> scenarios;
    std::string outcome = "failed";
    std::optional<InstrumentationControl> instrumentation_control;
};

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
};

[[nodiscard]] bool validate_run_options(const Options& options, std::string& reason);
[[nodiscard]] Distribution summarize(const std::vector<FrameSample>& samples, bool wall);
[[nodiscard]] DiagnosticSummary
summarize_diagnostics(const std::vector<DiagnosticObservation>& observations,
                      const std::vector<DiagnosticObservation>& late_observations = {});
[[nodiscard]] SuiteResult run_suite(const Options& options, const std::vector<Scenario*>& scenarios,
                                    Clock& clock);

// Browser/event-loop runner: advance at most one workload frame per host callback.
// Unlike run_suite, the caller owns pacing (requestAnimationFrame on Web).
class FrameDrivenSuite {
public:
    FrameDrivenSuite(const Options& options, Scenario& scenario, Clock& clock);
    [[nodiscard]] bool step(); // true when results and cleanup are complete
    void interrupt(std::string reason);
    [[nodiscard]] const SuiteResult& result() const { return suite_; }

private:
    void finish_trial();
    Options options_;
    Scenario& scenario_;
    Clock& clock_;
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
    double readiness_start_ = 0.0;
    double warmup_start_ = 0.0;
    double measurement_start_ = 0.0;
    double previous_end_ = 0.0;
};

} // namespace noveltea::benchmark
