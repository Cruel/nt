#pragma once

#include "benchmark_runner.hpp"

#include <bgfx/bgfx.h>

namespace noveltea::benchmark {

// bgfx owns the Stats and viewStats buffers. Copy values immediately.
// View records require BGFX_DEBUG_PROFILER plus backend timer support;
// an unpopulated numViews is *not* evidence that zero views were rendered.
inline void capture_bgfx_diagnostics_from_stats(const bgfx::Stats* stats,
                                                bool view_profiler_enabled,
                                                DiagnosticObservation& observation)
{
    if (!stats)
        return;

    observation.draw_calls = stats->numDraw;
    observation.compute_calls = stats->numCompute;
    observation.blit_calls = stats->numBlit;
    if (view_profiler_enabled && stats->numViews > 0 && stats->viewStats)
        observation.view_count = stats->numViews;
    observation.textures = stats->numTextures;
    observation.framebuffers = stats->numFrameBuffers;
    observation.programs = stats->numPrograms;

    if (stats->cpuTimerFreq > 0) {
        const double to_ms = 1000.0 / static_cast<double>(stats->cpuTimerFreq);
        if (stats->cpuTimeEnd >= stats->cpuTimeBegin && stats->cpuTimeBegin > 0)
            observation.bgfx_render_thread_ms =
                static_cast<double>(stats->cpuTimeEnd - stats->cpuTimeBegin) * to_ms;
        if (stats->waitRender >= 0)
            observation.bgfx_wait_render_ms = static_cast<double>(stats->waitRender) * to_ms;
        if (stats->waitSubmit >= 0)
            observation.bgfx_wait_submit_ms = static_cast<double>(stats->waitSubmit) * to_ms;
    }
    if (stats->gpuTimerFreq > 0 && stats->gpuFrameNum > 0 &&
        stats->gpuTimeEnd > stats->gpuTimeBegin && stats->gpuTimeBegin > 0) {
        observation.gpu_completed_frame = stats->gpuFrameNum;
        observation.gpu_execution_ms =
            static_cast<double>(stats->gpuTimeEnd - stats->gpuTimeBegin) * 1000.0 /
            static_cast<double>(stats->gpuTimerFreq);
    }
}

// Diagnostic-only read: no frame(), renderFrame(), or GPU synchronization.
// Only GPU timings carry a completed-frame identity.
inline void capture_bgfx_diagnostics(DiagnosticObservation& observation,
                                     bool view_profiler_enabled = false)
{
    capture_bgfx_diagnostics_from_stats(bgfx::getStats(), view_profiler_enabled, observation);
}

} // namespace noveltea::benchmark
