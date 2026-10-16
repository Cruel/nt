#include "benchmark_bgfx_diagnostics.hpp"

#include <bgfx/bgfx.h>

#include <cstdio>

namespace {
using noveltea::benchmark::capture_bgfx_diagnostics_from_stats;
using noveltea::benchmark::DiagnosticObservation;

bool check(bool condition, const char* message)
{
    if (!condition)
        std::fprintf(stderr, "bgfx diagnostic adapter: %s\n", message);
    return condition;
}
} // namespace

int main()
{
    DiagnosticObservation absent;
    capture_bgfx_diagnostics_from_stats(nullptr, true, absent);
    if (!check(!absent.view_count && !absent.draw_calls, "missing stats are unavailable"))
        return 1;

    bgfx::Stats stats{};
    stats.numDraw = 8;
    DiagnosticObservation no_profiler;
    capture_bgfx_diagnostics_from_stats(&stats, false, no_profiler);
    if (!check(!no_profiler.view_count && no_profiler.draw_calls == 8,
               "ordinary bgfx stats provide draw counts but no view profiler count"))
        return 1;

    DiagnosticObservation unsupported;
    capture_bgfx_diagnostics_from_stats(&stats, true, unsupported);
    if (!check(!unsupported.view_count && unsupported.draw_calls == 8,
               "profiler enabled without records must not report zero views"))
        return 1;

    stats.numViews = 2;
    DiagnosticObservation no_view_records;
    capture_bgfx_diagnostics_from_stats(&stats, true, no_view_records);
    if (!check(!no_view_records.view_count, "a nonzero count without view records is unavailable"))
        return 1;

    bgfx::ViewStats views[2]{};
    stats.viewStats = views;
    DiagnosticObservation profiled;
    capture_bgfx_diagnostics_from_stats(&stats, true, profiled);
    if (!check(profiled.view_count == 2 && profiled.draw_calls == 8,
               "valid profiler records publish their count"))
        return 1;

    DiagnosticObservation disabled;
    capture_bgfx_diagnostics_from_stats(&stats, false, disabled);
    if (!check(!disabled.view_count,
               "profiler records are not accepted when the scenario did not enable profiling"))
        return 1;

    return 0;
}
