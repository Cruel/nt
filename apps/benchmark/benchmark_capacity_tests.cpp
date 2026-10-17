#include "benchmark_capacity.hpp"
#include "benchmark_report.hpp"
#include "reference_workloads.hpp"

#include <nlohmann/json.hpp>

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace {
using namespace noveltea::benchmark;

bool require(bool value, const char* label)
{
    if (!value)
        std::fprintf(stderr, "capacity search: %s\n", label);
    return value;
}

SuiteResult sample(double operation_p95_ms, double gpu_p95_ms = 0.0, double cadence_hz = 60.0)
{
    TrialResult trial;
    trial.outcome = "complete";
    trial.measured_frames = 60;
    trial.measured_wall_seconds = 60.0 / cadence_hz;
    trial.cpu_operation.count = 60;
    trial.cpu_operation.mean_ms = operation_p95_ms;
    trial.cpu_operation.p95_ms = operation_p95_ms;
    if (gpu_p95_ms > 0.0) {
        trial.diagnostic.gpu_execution_ms.count = 55;
        trial.diagnostic.gpu_execution_ms.p95_ms = gpu_p95_ms;
    }
    ScenarioResult scenario;
    scenario.outcome = "complete";
    scenario.scenario = "raw-bgfx-draw-calls";
    scenario.trials.push_back(trial);
    SuiteResult result;
    result.outcome = "complete";
    result.scenarios.push_back(scenario);
    return result;
}

} // namespace

int main()
{
    Options geometry;
    geometry.scenario = "raw-bgfx-draw-calls";
    geometry.capacity_dimension = "geometry";
    geometry.capacity_target = "cpu-ms";
    geometry.capacity_threshold = 17.5;
    geometry.warmup_seconds = 0;
    geometry.measurement_frames = 60;
    std::string reason;
    if (!require(valid_capacity_options(geometry, reason), "valid geometry search"))
        return 1;
    CapacitySearch search(geometry);
    std::vector<uint32_t> visited;
    while (!search.done() && visited.size() < 25) {
        const auto candidate = search.candidate_options();
        visited.push_back(candidate.draw_calls);
        search.observe(sample(static_cast<double>(candidate.draw_calls) / 4.0));
    }
    if (!require(search.done() && search.result().status == "bracketed" &&
                     search.result().maximum_passing_workload == 70 && visited.front() == 1 &&
                     visited.back() == 71,
                 "bounded exponential/binary search reaches exact maximum passing count"))
        return 1;

    Options ui = geometry;
    ui.scenario = "integrated-rmlui-scaling";
    ui.capacity_dimension = "ui";
    CapacitySearch ui_search(ui);
    if (!require(ui_search.candidate_options().ui_elements == 1 &&
                     valid_capacity_options(ui, reason),
                 "independent UI candidate"))
        return 1;

    Options pixels = geometry;
    pixels.scenario = "raw-bgfx-offscreen";
    pixels.capacity_dimension = "pixels";
    CapacitySearch pixel_search(pixels);
    for (uint32_t value : {25u, 50u, 75u, 100u}) {
        const auto candidate = pixel_search.candidate_options();
        if (!require(pixel_search.candidate() == value &&
                         std::abs(candidate.target_scale - static_cast<double>(value) / 100.0) <
                             0.0001 &&
                         validate_run_options(candidate, reason) &&
                         validate_reference_options(candidate, reason) &&
                         raw_workload_reference(candidate, 1280, 720)->target_width ==
                             static_cast<uint32_t>(1280 * value / 100) &&
                         raw_workload_reference(candidate, 1280, 720)->target_height ==
                             static_cast<uint32_t>(720 * value / 100),
                     "valid discrete quarter-resolution scaling with real target dimensions"))
            return 1;
        pixel_search.observe(sample(5.0));
    }
    if (!require(pixel_search.done() && pixel_search.result().status == "bounded-maximum" &&
                     pixel_search.result().maximum_passing_workload == 100,
                 "upper configured limit is never claimed as uncapped hardware capacity"))
        return 1;

    CapacitySearch below(pixels);
    below.observe(sample(20.0));
    if (!require(below.done() && below.result().status == "below-minimum" &&
                     !below.result().maximum_passing_workload,
                 "unaffordable smallest scale yields no fabricated passing workload"))
        return 1;

    Options gpu = geometry;
    gpu.capacity_target = "gpu-ms";
    gpu.profile = "diagnostic";
    CapacitySearch missing(gpu);
    missing.observe(sample(1.0));
    if (!require(missing.done() && missing.result().status == "inconclusive" &&
                     !missing.result().probes.front().observed,
                 "missing GPU timestamps never substitute CPU metrics"))
        return 1;

    CapacitySearch partly_known(gpu);
    partly_known.observe(sample(1.0, 1.0));
    partly_known.observe(sample(1.0));
    if (!require(partly_known.done() && partly_known.result().status == "inconclusive" &&
                     partly_known.result().maximum_passing_workload == 1,
                 "partial search retains known lower bound without inferring unknown maximum"))
        return 1;

    Options presented = geometry;
    presented.capacity_target = "presented-fps";
    presented.capacity_threshold = 100.0;
    CapacitySearch paced(presented);
    paced.observe(sample(1.0, 0.0, 60.0));
    if (!require(paced.done() && paced.result().status == "below-minimum" &&
                     !paced.result().maximum_passing_workload,
                 "rAF/compositor-capped cadence never infers a higher FPS"))
        return 1;

    Options offscreen = pixels;
    offscreen.capacity_mode = "offscreen";
    offscreen.capacity_target = "cpu-ms";
    offscreen.capacity_threshold = 5;
    CapacitySearch batch(offscreen);
    batch.observe(sample(16.0));
    if (!require(batch.result().probes.front().completed_work_units == 240 &&
                     batch.result().probes.front().observed == 4.0 &&
                     batch.result().probes.front().work_units_per_cpu_second.has_value() &&
                     *batch.result().probes.front().work_units_per_cpu_second > 0 && !batch.done(),
                 "offscreen units use bounded batches, not presented FPS"))
        return 1;
    offscreen.capacity_target = "presented-fps";
    if (!require(!valid_capacity_options(offscreen, reason),
                 "offscreen presentation metric must be rejected"))
        return 1;
    offscreen.capacity_target = "gpu-ms";
    offscreen.profile = "diagnostic";
    offscreen.vsync = false;
    CapacitySearch offscreen_gpu(offscreen);
    offscreen_gpu.observe(sample(2.0, 16.0));
    if (!require(offscreen_gpu.result().probes.front().observed == 4.0 &&
                     offscreen_gpu.result().probes.front().outcome == "within-budget",
                 "GPU frame timing normalized only by actual batch size"))
        return 1;

    offscreen_gpu.observe(sample(2.0, 0.0));
    if (!require(offscreen_gpu.result().status == "inconclusive",
                 "GPU timing absence mid-search makes search inconclusive"))
        return 1;

    pixels.native_resolution = true;
    const auto config = encode_configuration(pixels);
    Options decoded;
    if (!require(decode_configuration(config, decoded, reason) &&
                     decoded.capacity_dimension == "pixels" && decoded.native_resolution &&
                     decoded.capacity_target == "cpu-ms" && decoded.capacity_threshold == 17.5 &&
                     encode_configuration(decoded) == config,
                 "strict capacity configuration roundtrip"))
        return 1;
    auto invalid = nlohmann::json::parse(config);
    invalid["settings"].erase("native_resolution");
    if (!require(!decode_configuration(invalid.dump(), decoded, reason),
                 "reject missing native-resolution field rather than supporting old schema"))
        return 1;
    SuiteResult report_result = sample(1.0);
    report_result.capacity = pixel_search.result();
    const auto report = nlohmann::json::parse(encode_result(pixels, {}, report_result));
    if (!require(report["capacity_search"]["status"] == "bounded-maximum" &&
                     report["capacity_search"]["probes"].size() == 4 &&
                     report["capacity_search"]["maximum_passing_workload"] == 100 &&
                     report["capacity_search"]["mode"] == "presented",
                 "search provenance survives JSON result encoding"))
        return 1;
    return 0;
}
