#pragma once

#include "benchmark_options.hpp"

#include <cstdint>
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

struct TrialResult {
    std::string outcome = "failed";
    std::string reason;
    std::vector<Phase> phases;
    uint64_t warmup_frames = 0;
    uint64_t measured_frames = 0;
    double measured_wall_seconds = 0.0;
    Distribution wall_frame;
    Distribution cpu_operation;
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

struct SuiteResult {
    std::vector<ScenarioResult> scenarios;
    std::string outcome = "failed";
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
    virtual bool complete(std::string& reason) = 0;
    // Return false with a diagnostic if teardown cannot release scenario resources.
    virtual bool cleanup(std::string& reason) = 0;
};

[[nodiscard]] bool validate_run_options(const Options& options, std::string& reason);
[[nodiscard]] Distribution summarize(const std::vector<FrameSample>& samples, bool wall);
[[nodiscard]] SuiteResult run_suite(const Options& options, const std::vector<Scenario*>& scenarios,
                                    Clock& clock);

} // namespace noveltea::benchmark
