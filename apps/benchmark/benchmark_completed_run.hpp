#pragma once

#include "benchmark_runner.hpp"

#include <string>

namespace noveltea::benchmark {

// One immutable-in-practice snapshot for the Results panel. Editable dashboard
// settings are intentionally not part of this object after the run completes.
struct CompletedRun {
    Options configuration;
    SuiteResult result;
    std::string report_path;
};

// A single UI-visible label, tested independently of the graphics backend.
[[nodiscard]] std::string completed_run_identity(const CompletedRun& run);

} // namespace noveltea::benchmark
