#pragma once

#include "benchmark_runner.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::benchmark {

// Offscreen units are repeated real draw submissions into a render target,
// with one bgfx::frame per bounded batch. They are not presented frames.
constexpr uint32_t kOffscreenWorkUnitsPerBatch = 4;

[[nodiscard]] bool valid_capacity_options(const Options& options, std::string& reason);
[[nodiscard]] Options capacity_probe_options(const Options& base, uint32_t workload);
[[nodiscard]] uint32_t capacity_work_units(const Options& options);

// Deterministic bounded exponential/binary search. Only successful completed
// trials count as evidence; failures and absent GPU timings are inconclusive.
class CapacitySearch {
public:
    explicit CapacitySearch(const Options& options);
    [[nodiscard]] bool done() const { return done_; }
    [[nodiscard]] uint32_t candidate() const { return candidate_; }
    [[nodiscard]] Options candidate_options() const;
    void observe(const SuiteResult& measured);
    [[nodiscard]] const CapacityResult& result() const { return result_; }

private:
    Options options_;
    CapacityResult result_;
    uint32_t candidate_ = 1;
    uint32_t maximum_ = 0;
    uint32_t passing_ = 0;
    uint32_t failing_ = 0;
    bool done_ = false;
};

} // namespace noveltea::benchmark
