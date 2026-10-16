#pragma once

#include "benchmark_runner.hpp"

#include <bgfx/bgfx.h>

namespace noveltea::benchmark {

// Copy values immediately: bgfx owns and reuses the Stats buffer. This
// diagnostic-only read does not call frame(), renderFrame(), or block for GPU
// completion. Only GPU timings carry a completed-frame identifier.
inline void capture_bgfx_diagnostics(DiagnosticObservation& observation)
{
    const bgfx::Stats* stats = bgfx::getStats();
    if (!stats)
        return;

    observation.draw_calls = stats->numDraw;
    observation.compute_calls = stats->numCompute;
    observation.blit_calls = stats->numBlit;
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

} // namespace noveltea::benchmark
