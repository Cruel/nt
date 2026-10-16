#include "benchmark_capacity.hpp"

#include "reference_scene.hpp"
#include "reference_workloads.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace noveltea::benchmark {
namespace {

uint32_t maximum_workload(const Options& options)
{
    if (options.capacity_dimension == "pixels")
        return 100;
    if (options.capacity_dimension == "ui")
        return 2048;
    return options.scenario == "raw-bgfx-geometry" ? kMaxReferenceRects : 1024;
}

uint32_t next_exponential(uint32_t value, uint32_t maximum) { return std::min(maximum, value * 2); }

} // namespace

bool valid_capacity_options(const Options& options, std::string& reason)
{
    if (options.capacity_dimension.empty())
        return true;
    const bool geometry =
        options.capacity_dimension == "geometry" &&
        (options.scenario == "raw-bgfx-draw-calls" || options.scenario == "raw-bgfx-geometry");
    const bool ui = options.capacity_dimension == "ui" && is_ui_scaling_scenario(options.scenario);
    const bool pixels =
        options.capacity_dimension == "pixels" &&
        (options.scenario == "raw-bgfx-offscreen" ||
         (options.scenario == "raw-bgfx-composition" && options.composition_path == "offscreen"));
    if (!geometry && !ui && !pixels) {
        reason = "capacity dimension requires a matching geometry, RmlUi scaling, or offscreen raw "
                 "scenario";
        return false;
    }
    if (options.capacity_target != "cpu-ms" && options.capacity_target != "gpu-ms" &&
        options.capacity_target != "presented-fps") {
        reason = "capacity target must be cpu-ms, gpu-ms, or presented-fps";
        return false;
    }
    if (!std::isfinite(options.capacity_threshold) || options.capacity_threshold <= 0.0 ||
        options.capacity_threshold > 1000.0) {
        reason = "capacity threshold must be in (0, 1000]";
        return false;
    }
    if (options.capacity_mode != "presented" && options.capacity_mode != "offscreen") {
        reason = "capacity mode must be presented or offscreen";
        return false;
    }
    if (options.quick_suite || options.dashboard_smoke || options.dashboard_visual_smoke) {
        reason = "capacity search cannot be combined with suite or dashboard smoke";
        return false;
    }
    if (options.capacity_target == "gpu-ms" && options.profile != "diagnostic") {
        reason = "GPU capacity search requires diagnostic profile with real GPU timing";
        return false;
    }
    if (options.capacity_mode == "offscreen" &&
        (options.scenario != "raw-bgfx-offscreen" || options.capacity_target == "presented-fps" ||
         options.vsync)) {
        reason =
            "offscreen capacity requires raw-bgfx-offscreen, CPU/GPU target and VSync disabled";
        return false;
    }
    return true;
}

Options capacity_probe_options(const Options& base, uint32_t workload)
{
    Options candidate = base;
    if (base.capacity_dimension == "geometry") {
        if (base.scenario == "raw-bgfx-geometry")
            candidate.rect_count = workload;
        else
            candidate.draw_calls = workload;
    } else if (base.capacity_dimension == "ui") {
        candidate.ui_elements = workload;
    } else if (base.capacity_dimension == "pixels") {
        candidate.target_scale = static_cast<double>(workload) / 100.0;
    }
    return candidate;
}

uint32_t capacity_work_units(const Options& options)
{
    return options.capacity_mode == "offscreen" && !options.capacity_dimension.empty()
               ? kOffscreenWorkUnitsPerBatch
               : 1;
}

CapacitySearch::CapacitySearch(const Options& options) : options_(options)
{
    result_.dimension = options.capacity_dimension;
    result_.target = options.capacity_target;
    result_.threshold = options.capacity_threshold;
    result_.mode = options.capacity_mode;
    maximum_ = maximum_workload(options);
    candidate_ = options.capacity_dimension == "pixels" ? 25 : 1;
}

Options CapacitySearch::candidate_options() const
{
    return capacity_probe_options(options_, candidate_);
}

void CapacitySearch::observe(const SuiteResult& measured)
{
    if (done_)
        return;
    CapacityProbe probe;
    probe.workload = candidate_;
    bool complete = !measured.scenarios.empty() && measured.outcome == "complete";
    double metric =
        options_.capacity_target == "presented-fps" ? std::numeric_limits<double>::infinity() : 0.0;
    double cpu_seconds = 0.0;
    for (const auto& scenario : measured.scenarios) {
        complete &= scenario.outcome == "complete" && !scenario.trials.empty();
        for (const auto& trial : scenario.trials) {
            complete &= trial.outcome == "complete" && trial.measured_frames > 0;
            if (trial.outcome != "complete")
                continue;
            probe.completed_batches += trial.measured_frames;
            cpu_seconds += trial.cpu_operation.mean_ms * trial.measured_frames / 1000.0;
            if (options_.capacity_target == "cpu-ms") {
                if (trial.cpu_operation.count == 0)
                    complete = false;
                metric = std::max(metric, trial.cpu_operation.p95_ms);
            } else if (options_.capacity_target == "gpu-ms") {
                if (trial.diagnostic.gpu_execution_ms.count < 2)
                    complete = false;
                metric = std::max(metric, trial.diagnostic.gpu_execution_ms.p95_ms);
            } else {
                if (!(trial.measured_wall_seconds > 0.0))
                    complete = false;
                else
                    metric = std::min(metric, static_cast<double>(trial.measured_frames) /
                                                  trial.measured_wall_seconds);
            }
        }
    }
    const uint32_t units = capacity_work_units(options_);
    probe.completed_work_units = probe.completed_batches * units;
    if (cpu_seconds > 0.0)
        probe.work_units_per_cpu_second =
            static_cast<double>(probe.completed_work_units) / cpu_seconds;
    if (complete && std::isfinite(metric) && metric > 0.0) {
        if (options_.capacity_mode == "offscreen" && options_.capacity_target != "presented-fps")
            metric /= units;
        probe.observed = metric;
        const bool passes = options_.capacity_target == "presented-fps"
                                ? metric >= options_.capacity_threshold
                                : metric <= options_.capacity_threshold;
        probe.outcome = passes ? "within-budget" : "over-budget";
        if (passes)
            passing_ = std::max(passing_, candidate_);
        else
            failing_ = failing_ == 0 ? candidate_ : std::min(failing_, candidate_);
    } else {
        probe.outcome = measured.outcome == "cancelled" ? "cancelled" : "inconclusive";
        done_ = true;
        result_.status = probe.outcome;
        result_.reason = options_.capacity_target == "gpu-ms"
                             ? "GPU timing unavailable, incomplete or invalid; no capacity inferred"
                             : "candidate failed or did not provide valid complete timing";
        // A known passing lower bound is still useful, but it cannot be
        // promoted to a certified maximum when a later candidate is unknown.
        if (passing_ != 0)
            result_.maximum_passing_workload = passing_;
    }
    result_.probes.push_back(std::move(probe));
    if (done_)
        return;
    if (passing_ == maximum_) {
        done_ = true;
        result_.status = "bounded-maximum";
        result_.reason = "highest configured workload passed; hardware limit was not measured";
    } else if (failing_ == (options_.capacity_dimension == "pixels" ? 25u : 1u) ||
               (passing_ != 0 &&
                failing_ == passing_ + (options_.capacity_dimension == "pixels" ? 25u : 1u)) ||
               result_.probes.size() >= 20) {
        done_ = true;
        result_.status = passing_ == 0 ? "below-minimum" : "bracketed";
        result_.reason = passing_ == 0
                             ? "minimum supported workload exceeded the target"
                             : "highest tested passing workload; no uncapped rate inferred";
    } else if (failing_ != 0) {
        candidate_ = passing_ + (failing_ - passing_) / 2;
        if (options_.capacity_dimension == "pixels") {
            candidate_ = (candidate_ / 25) * 25;
            if (candidate_ <= passing_)
                candidate_ = passing_ + 25;
        }
    } else {
        candidate_ = options_.capacity_dimension == "pixels"
                         ? std::min(maximum_, candidate_ + 25)
                         : next_exponential(candidate_, maximum_);
    }
    if (done_ && passing_ != 0)
        result_.maximum_passing_workload = passing_;
}

} // namespace noveltea::benchmark
