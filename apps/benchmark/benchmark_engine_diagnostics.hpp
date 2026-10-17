#pragma once

#include "benchmark_runner.hpp"
#include "noveltea/engine_tooling.hpp"

namespace noveltea::benchmark {

// Owner-thread timings from production Engine tick boundaries, not the
// benchmark Scenario wrapper or bgfx completed frame. Never called in Clean.
inline void capture_engine_stage_diagnostics(const Engine& engine,
                                             DiagnosticObservation& observation)
{
    const auto stages = EngineTooling::engine_benchmark_frame_timing(engine);
    if (!stages)
        return; // An early-return/throttled tick is not a completed measurement.
    constexpr double kToMs = 1000.0;
    observation.engine_events_ms = stages->events_seconds * kToMs;
    observation.engine_jobs_ms = stages->jobs_seconds * kToMs;
    observation.engine_assets_ms = stages->assets_seconds * kToMs;
    observation.engine_update_ms = stages->update_seconds * kToMs;
    observation.engine_runtime_ms = stages->runtime_seconds * kToMs;
    observation.engine_layout_ms = stages->layout_seconds * kToMs;
    observation.engine_render_ms = stages->render_seconds * kToMs;
}

} // namespace noveltea::benchmark
