#include "benchmark_report.hpp"
#include "reference_scene.hpp"
#include "reference_workloads.hpp"
#include "benchmark_source_identity.hpp"

#include <nlohmann/json.hpp>

#include <cmath>
#include <cstdint>
#include <string>
#include <string_view>

namespace noveltea::benchmark {
namespace {
using Json = nlohmann::json;
constexpr std::string_view kConfigFormat = "noveltea.benchmark.configuration";
constexpr std::string_view kResultFormat = "noveltea.benchmark.result";
#if defined(__EMSCRIPTEN__)
constexpr const char* kWallFrameDescription =
    "requestAnimationFrame-paced browser callback interval (includes scheduling and "
    "presentation pacing); not uncapped GPU throughput or confirmed display FPS";
#else
constexpr const char* kWallFrameDescription =
    "end-to-end CPU frame-loop interval; not confirmed presentation";
#endif

Json configuration(const Options& options)
{
    Json parameters = Json::object();
    if (options.scenario == "raw-bgfx-geometry")
        parameters = {{"rect_count", options.rect_count}, {"rect_scale", options.rect_scale}};
    else if (options.scenario == "raw-bgfx-textured" || options.scenario == "raw-bgfx-offscreen")
        parameters = {{"texture_size", options.texture_size}, {"coverage", options.coverage}};
    else if (options.scenario == "raw-bgfx-composition")
        parameters = {{"composition_path", options.composition_path},
                      {"composite_passes", options.composite_passes},
                      {"target_scale", options.target_scale},
                      {"msaa_samples", options.msaa_samples},
                      {"transparent_overlay", options.transparent_overlay},
                      {"texture_size", options.texture_size},
                      {"coverage", options.coverage}};
    else if (options.scenario == "raw-bgfx-draw-calls")
        parameters = {{"draw_calls", options.draw_calls},
                      {"quad_count", options.quad_count},
                      {"texture_size", options.texture_size},
                      {"coverage", options.coverage}};
    return {{"format", kConfigFormat},
            {"version", 1},
            {"scenario", options.scenario},
            {"scenario_version", 1},
            {"parameters", parameters},
            {"clock_policy", "realtime"},
            {"settings",
             {{"width", options.width},
              {"height", options.height},
              {"warmup_seconds", options.warmup_seconds},
              {"measurement_seconds", options.duration_seconds},
              {"measurement_frames", options.measurement_frames},
              {"repeats", options.repeats},
              {"ready_timeout_seconds", options.ready_timeout_seconds},
              {"profile", options.profile},
              {"no_ui", options.no_ui},
              {"quick_suite", options.quick_suite},
              {"raw_samples", options.raw_samples},
              {"vsync", options.vsync},
              {"output", options.output_path}}}};
}

Json distribution(const Distribution& value)
{
    if (value.count == 0)
        return nullptr;
    return {{"samples", value.count}, {"mean_ms", value.mean_ms},
            {"min_ms", value.min_ms}, {"max_ms", value.max_ms},
            {"p50_ms", value.p50_ms}, {"p95_ms", value.p95_ms},
            {"p99_ms", value.p99_ms}, {"standard_deviation_ms", value.standard_deviation_ms}};
}

Json counter_summary(const CounterSummary& value)
{
    if (!value.count)
        return nullptr;
    return {
        {"snapshots", value.count}, {"mean", value.mean}, {"min", value.min}, {"max", value.max}};
}

Json diagnostic_result(const DiagnosticSummary& value)
{
    return {
        {"observations", value.observations},
        {"bgfx_stats_snapshots", value.bgfx_stats_observations},
        {"stats_scope", "asynchronous bgfx completed-frame snapshots; may repeat or lag; "
                        "not paired to CPU frame indices"},
        {"cpu_update_ms", distribution(value.cpu_update_ms)},
        {"cpu_submission_ms", distribution(value.cpu_submission_ms)},
        {"bgfx_frame_cpu_ms", distribution(value.bgfx_frame_cpu_ms)},
        {"bgfx_render_thread_ms", distribution(value.bgfx_render_thread_ms)},
        {"bgfx_wait_render_ms", distribution(value.bgfx_wait_render_ms)},
        {"bgfx_wait_submit_ms", distribution(value.bgfx_wait_submit_ms)},
        {"gpu_execution_ms", distribution(value.gpu_execution_ms)},
        {"gpu_scope", "unique gpuFrameNum matched to a measured bgfx::frame ID; "
                      "incomplete delayed GPU completions are omitted"},
        {"draw_calls", counter_summary(value.draw_calls)},
        {"compute_calls", counter_summary(value.compute_calls)},
        {"blit_calls", counter_summary(value.blit_calls)},
        {"view_count", counter_summary(value.view_count)},
        {"view_scope", "number of per-view profiler records, only if "
                       "BGFX_DEBUG_PROFILER produces valid records; otherwise unavailable"},
        {"resource_textures", counter_summary(value.textures)},
        {"resource_framebuffers", counter_summary(value.framebuffers)},
        {"resource_programs", counter_summary(value.programs)},
    };
}

const char* phase_name(Phase value)
{
    switch (value) {
    case Phase::Preparation:
        return "preparation";
    case Phase::Ready:
        return "ready";
    case Phase::Warmup:
        return "warmup";
    case Phase::Measurement:
        return "measurement";
    case Phase::Completion:
        return "completion";
    case Phase::Results:
        return "results";
    case Phase::Cleanup:
        return "cleanup";
    }
    return "unknown";
}

bool has_fields(const Json& value, std::initializer_list<const char*> keys)
{
    if (!value.is_object() || value.size() != keys.size())
        return false;
    for (const char* key : keys) {
        if (!value.contains(key))
            return false;
    }
    return true;
}

bool numeric(const Json& value, const char* key)
{
    return value[key].is_number() && std::isfinite(value[key].get<double>());
}

bool unsigned_integer(const Json& value, const char* key)
{
    return value[key].is_number_integer() &&
           (value[key].is_number_unsigned() || value[key].get<int64_t>() >= 0);
}
} // namespace

std::string encode_configuration(const Options& options) { return configuration(options).dump(2); }

bool decode_configuration(std::string_view source, Options& options, std::string& reason)
{
    const Json root = Json::parse(source.begin(), source.end(), nullptr, false);
    if (root.is_discarded() ||
        !has_fields(root, {"format", "version", "scenario", "scenario_version", "parameters",
                           "clock_policy", "settings"}) ||
        !root["format"].is_string() || root["format"] != kConfigFormat ||
        !root["version"].is_number_integer() || root["version"] != 1 ||
        !root["scenario"].is_string() || root["scenario"].get<std::string>().empty() ||
        !root["scenario_version"].is_number_integer() || root["scenario_version"] != 1 ||
        !root["parameters"].is_object() || !root["clock_policy"].is_string() ||
        root["clock_policy"] != "realtime") {
        reason = "invalid or unsupported benchmark configuration schema";
        return false;
    }
    const std::string scenario = root["scenario"].get<std::string>();
    const auto& parameters = root["parameters"];
    if (scenario == "raw-bgfx-empty" || scenario == "standalone-rmlui-simple" ||
        scenario == "integrated-rmlui-production" || scenario == "integrated-rmlui-controlled" ||
        scenario == "engine-empty") {
        if (!parameters.empty()) {
            reason = "empty scenario does not take geometry parameters";
            return false;
        }
    } else if (scenario == "raw-bgfx-geometry") {
        if (!has_fields(parameters, {"rect_count", "rect_scale"}) ||
            !unsigned_integer(parameters, "rect_count") || !numeric(parameters, "rect_scale") ||
            parameters["rect_count"].get<uint64_t>() > kMaxReferenceRects ||
            !valid_geometry_parameters(
                static_cast<uint32_t>(parameters["rect_count"].get<uint64_t>()),
                parameters["rect_scale"].get<double>())) {
            reason = "invalid geometry reference parameters";
            return false;
        }
    } else if (scenario == "raw-bgfx-composition") {
        if (!has_fields(parameters,
                        {"composition_path", "composite_passes", "target_scale", "msaa_samples",
                         "transparent_overlay", "texture_size", "coverage"}) ||
            !parameters["composition_path"].is_string() ||
            !unsigned_integer(parameters, "composite_passes") ||
            !numeric(parameters, "target_scale") || !unsigned_integer(parameters, "msaa_samples") ||
            !parameters["transparent_overlay"].is_boolean() ||
            !unsigned_integer(parameters, "texture_size") || !numeric(parameters, "coverage") ||
            parameters["composite_passes"].get<uint64_t>() > 4 ||
            parameters["msaa_samples"].get<uint64_t>() > 4 ||
            parameters["texture_size"].get<uint64_t>() > 2048) {
            reason = "invalid composition reference parameters";
            return false;
        }
    } else if (is_extended_raw_scenario(scenario)) {
        const bool textured = scenario == "raw-bgfx-textured" || scenario == "raw-bgfx-offscreen";
        const bool variable = scenario == "raw-bgfx-draw-calls";
        if (variable
                ? !has_fields(parameters, {"draw_calls", "quad_count", "texture_size", "coverage"})
            : textured ? !has_fields(parameters, {"texture_size", "coverage"})
                       : !parameters.empty()) {
            reason = "invalid raw workload parameter keys";
            return false;
        }
        if ((variable && (!unsigned_integer(parameters, "draw_calls") ||
                          !unsigned_integer(parameters, "quad_count") ||
                          parameters["draw_calls"].get<uint64_t>() > 1024 ||
                          parameters["quad_count"].get<uint64_t>() > 512)) ||
            ((variable || textured) &&
             (!unsigned_integer(parameters, "texture_size") || !numeric(parameters, "coverage") ||
              parameters["texture_size"].get<uint64_t>() > 2048))) {
            reason = "invalid raw workload parameter values";
            return false;
        }
    } else {
        reason = "unsupported benchmark scenario";
        return false;
    }
    const auto& settings = root["settings"];
    if (!has_fields(settings, {"width", "height", "warmup_seconds", "measurement_seconds",
                               "measurement_frames", "repeats", "ready_timeout_seconds", "profile",
                               "no_ui", "quick_suite", "raw_samples", "vsync", "output"}) ||
        !unsigned_integer(settings, "width") || !unsigned_integer(settings, "height") ||
        !numeric(settings, "warmup_seconds") || !numeric(settings, "measurement_seconds") ||
        !unsigned_integer(settings, "measurement_frames") ||
        !unsigned_integer(settings, "repeats") || !numeric(settings, "ready_timeout_seconds") ||
        !settings["profile"].is_string() ||
        (settings["profile"] != "clean" && settings["profile"] != "diagnostic") ||
        !settings["no_ui"].is_boolean() || !settings["quick_suite"].is_boolean() ||
        !settings["raw_samples"].is_boolean() || !settings["vsync"].is_boolean() ||
        !settings["output"].is_string()) {
        reason = "invalid benchmark configuration settings";
        return false;
    }
    const uint64_t width = settings["width"].get<uint64_t>();
    const uint64_t height = settings["height"].get<uint64_t>();
    const uint64_t repeats = settings["repeats"].get<uint64_t>();
    if (width > 8192 || height > 8192 || repeats > 20) {
        reason = "benchmark configuration exceeds supported limits";
        return false;
    }
    Options next;
    next.scenario = scenario;
    if (scenario == "raw-bgfx-geometry") {
        next.rect_count = static_cast<uint32_t>(parameters["rect_count"].get<uint64_t>());
        next.rect_scale = parameters["rect_scale"].get<double>();
    }
    if (scenario == "raw-bgfx-composition") {
        next.composition_path = parameters["composition_path"].get<std::string>();
        next.composite_passes =
            static_cast<uint32_t>(parameters["composite_passes"].get<uint64_t>());
        next.target_scale = parameters["target_scale"].get<double>();
        next.msaa_samples = static_cast<uint32_t>(parameters["msaa_samples"].get<uint64_t>());
        next.transparent_overlay = parameters["transparent_overlay"].get<bool>();
    }
    if (scenario == "raw-bgfx-draw-calls") {
        next.draw_calls = static_cast<uint32_t>(parameters["draw_calls"].get<uint64_t>());
        next.quad_count = static_cast<uint32_t>(parameters["quad_count"].get<uint64_t>());
    }
    if (scenario == "raw-bgfx-draw-calls" || scenario == "raw-bgfx-textured" ||
        scenario == "raw-bgfx-offscreen" || scenario == "raw-bgfx-composition") {
        next.texture_size = static_cast<uint32_t>(parameters["texture_size"].get<uint64_t>());
        next.coverage = parameters["coverage"].get<double>();
    }
    next.width = static_cast<int>(width);
    next.height = static_cast<int>(height);
    next.warmup_seconds = settings["warmup_seconds"].get<double>();
    next.duration_seconds = settings["measurement_seconds"].get<double>();
    next.measurement_frames = settings["measurement_frames"].get<uint64_t>();
    next.repeats = static_cast<uint32_t>(repeats);
    next.ready_timeout_seconds = settings["ready_timeout_seconds"].get<double>();
    next.raw_samples = settings["raw_samples"].get<bool>();
    next.profile = settings["profile"].get<std::string>();
    next.no_ui = settings["no_ui"].get<bool>();
    next.quick_suite = settings["quick_suite"].get<bool>();
    next.vsync = settings["vsync"].get<bool>();
    next.output_path = settings["output"].get<std::string>();
    if (!validate_run_options(next, reason) || !validate_reference_options(next, reason))
        return false;
    options = std::move(next);
    reason.clear();
    return true;
}

std::string encode_result(const Options& options, const Environment& environment,
                          const SuiteResult& result,
                          const std::vector<Environment>& scenario_environments)
{
    Json scenarios = Json::array();
    for (const auto& scenario : result.scenarios) {
        Json trials = Json::array();
        for (const auto& trial : scenario.trials) {
            Json phases = Json::array();
            for (const auto phase : trial.phases)
                phases.push_back(phase_name(phase));
            Json raw = nullptr;
            if (options.raw_samples && trial.outcome == "complete") {
                raw = Json::array();
                for (const auto& sample : trial.raw_samples)
                    raw.push_back({{"wall_ms", sample.wall_seconds * 1000.0},
                                   {"cpu_operation_ms", sample.operation_seconds * 1000.0}});
            }
            trials.push_back(
                {{"outcome", trial.outcome},
                 {"reason", trial.reason.empty() ? Json(nullptr) : Json(trial.reason)},
                 {"phases", std::move(phases)},
                 {"interruption_retries", trial.interruption_retries},
                 {"warmup_frames", trial.warmup_frames},
                 {"measured_frames", trial.measured_frames},
                 {"measured_wall_seconds",
                  trial.measured_frames > 0 ? Json(trial.measured_wall_seconds) : Json(nullptr)},
                 {"frame_loop_cadence_hz",
                  trial.outcome == "complete" && trial.measured_wall_seconds > 0.0
                      ? Json(static_cast<double>(trial.measured_frames) /
                             trial.measured_wall_seconds)
                      : Json(nullptr)},
                 {"frame_wall_ms", distribution(trial.wall_frame)},
                 {"cpu_operation_ms", distribution(trial.cpu_operation)},
                 {"diagnostic", options.profile == "diagnostic" && trial.outcome == "complete"
                                    ? diagnostic_result(trial.diagnostic)
                                    : Json(nullptr)},
                 {"raw_samples", std::move(raw)}});
        }
        scenarios.push_back(
            {{"id", scenario.scenario},
             {"description", scenario.description},
             {"outcome", scenario.outcome},
             {"trials", std::move(trials)},
             {"aggregate",
              {{"measured_frames", scenario.measured_frames},
               {"measured_wall_seconds", scenario.measured_wall_seconds},
               {"frame_loop_cadence_hz", scenario.measured_wall_seconds > 0.0
                                             ? Json(static_cast<double>(scenario.measured_frames) /
                                                    scenario.measured_wall_seconds)
                                             : Json(nullptr)},
               {"frame_wall_ms", distribution(scenario.wall_frame)},
               {"cpu_operation_ms", distribution(scenario.cpu_operation)}}}});
    }
    const auto encode_graphics = [](const Environment& environment) -> Json {
        return {
            {"platform", environment.platform},
            {"video_driver",
             environment.video_driver.empty() ? Json(nullptr) : Json(environment.video_driver)},
            {"renderer", environment.renderer.empty() ? Json(nullptr) : Json(environment.renderer)},
            {"frame_path",
             environment.frame_path.empty() ? Json(nullptr) : Json(environment.frame_path)},
            {"gpu_vendor_id",
             environment.gpu_vendor_id < 0 ? Json(nullptr) : Json(environment.gpu_vendor_id)},
            {"gpu_device_id",
             environment.gpu_device_id < 0 ? Json(nullptr) : Json(environment.gpu_device_id)},
            {"gpu_driver_version", nullptr},
            {"width_pixels",
             environment.width_pixels > 0 ? Json(environment.width_pixels) : Json(nullptr)},
            {"height_pixels",
             environment.height_pixels > 0 ? Json(environment.height_pixels) : Json(nullptr)},
            // These are captured from the actual initialized RmlUi adapter,
            // not inferred from the scenario name. A multisampled reference
            // layer must use offscreen base presentation by backend policy.
            {"ui_render_path",
             environment.ui_backend
                 ? Json(environment.ui_backend->optimized_render_path ? "optimized" : "reference")
                 : Json(nullptr)},
            {"ui_base_direct_compat",
             environment.ui_backend
                 ? Json(environment.ui_backend->base_direct_compatibility_requested)
                 : Json(nullptr)},
            {"ui_reference_msaa_samples", environment.ui_backend
                                              ? Json(environment.ui_backend->reference_msaa_samples)
                                              : Json(nullptr)},
            {"ui_preserve_backbuffer", environment.ui_backend
                                           ? Json(environment.ui_backend->preserve_backbuffer)
                                           : Json(nullptr)},
            {"ui_base_presentation_policy",
             environment.ui_backend ? Json(environment.ui_backend->reference_msaa_samples > 0
                                               ? "offscreen-required-by-msaa"
                                               : "depends-on-root-and-capabilities")
                                    : Json(nullptr)},
            {"ui_output_framebuffer", environment.ui_backend
                                          ? Json(environment.ui_backend->output_framebuffer_bound
                                                     ? "explicit-offscreen-target"
                                                     : "backbuffer")
                                          : Json(nullptr)},
            {"ui_raster_snapping_geometry",
             environment.ui_backend ? Json(environment.ui_backend->geometry_raster_snapping)
                                    : Json(nullptr)},
            {"ui_raster_snapping_text", environment.ui_backend
                                            ? Json(environment.ui_backend->text_raster_snapping)
                                            : Json(nullptr)},
            {"ui_backend_viewport_width",
             environment.ui_backend ? Json(environment.ui_backend->viewport_width) : Json(nullptr)},
            {"ui_backend_viewport_height", environment.ui_backend
                                               ? Json(environment.ui_backend->viewport_height)
                                               : Json(nullptr)},
            {"engine_ui_reference_width", environment.ui_reference_width > 0
                                              ? Json(environment.ui_reference_width)
                                              : Json(nullptr)},
            {"engine_ui_reference_height", environment.ui_reference_height > 0
                                               ? Json(environment.ui_reference_height)
                                               : Json(nullptr)},
            {"ui_raster_width_pixels",
             environment.ui_raster_width > 0 ? Json(environment.ui_raster_width) : Json(nullptr)},
            {"ui_raster_height_pixels",
             environment.ui_raster_height > 0 ? Json(environment.ui_raster_height) : Json(nullptr)},
            {"world_raster_width_pixels", environment.world_raster_width > 0
                                              ? Json(environment.world_raster_width)
                                              : Json(nullptr)},
            {"world_raster_height_pixels", environment.world_raster_height > 0
                                               ? Json(environment.world_raster_height)
                                               : Json(nullptr)},
            {"engine_postprocess_surface_active", environment.engine_postprocess_active
                                                      ? Json(*environment.engine_postprocess_active)
                                                      : Json(nullptr)},
            {"raw_workload",
             environment.raw_workload
                 ? Json{{"id", environment.raw_workload->id},
                        {"draw_calls", environment.raw_workload->draw_calls},
                        {"quads_per_draw", environment.raw_workload->quads_per_draw},
                        {"texture_edge_pixels", environment.raw_workload->texture_size},
                        {"texture_and_target_bytes", environment.raw_workload->texture_bytes},
                        {"linear_coverage", environment.raw_workload->coverage},
                        {"offscreen", environment.raw_workload->offscreen},
                        {"composition_path", environment.raw_workload->composition
                                                 ? Json(environment.raw_workload->composition_path)
                                                 : Json(nullptr)},
                        {"composite_passes", environment.raw_workload->composite_passes},
                        {"transparent_overlay", environment.raw_workload->transparent_overlay},
                        {"semantically_equivalent_to_direct",
                         environment.raw_workload->composition
                             ? Json(environment.raw_workload->equivalent_to_direct)
                             : Json(nullptr)},
                        {"target_scale", environment.raw_workload->target_scale},
                        {"target_width_pixels", environment.raw_workload->target_width},
                        {"target_height_pixels", environment.raw_workload->target_height},
                        {"render_target_count", environment.raw_workload->target_count},
                        {"render_target_color_bytes", environment.raw_workload->target_color_bytes},
                        {"estimated_extra_msaa_bytes",
                         environment.raw_workload->estimated_msaa_bytes},
                        // bgfx validates the texture format, but backend allocation may clamp
                        // MSAA sample counts. Never present the request as effective GPU state.
                        {"msaa_samples", environment.raw_workload->msaa_samples},
                        {"requested_msaa_samples", environment.raw_workload->msaa_samples},
                        {"effective_msaa_samples",
                         environment.raw_workload->msaa_samples == 0 ? Json(0) : Json(nullptr)},
                        {"msaa_sample_count_verified", environment.raw_workload->msaa_samples == 0},
                        {"estimated_extra_msaa_bytes_basis",
                         environment.raw_workload->msaa_samples == 0
                             ? "none"
                             : "requested sample count; actual allocation/resolve unverified"},
                        {"covered_backbuffer_pixels_estimate",
                         environment.raw_workload->covered_pixels},
                        {"render_views", environment.raw_workload->view_count},
                        {"draw_submissions_per_frame", environment.raw_workload->draws_per_frame},
                        {"vertices_submitted_per_frame",
                         environment.raw_workload->vertices_per_frame},
                        {"triangles_submitted_per_frame",
                         environment.raw_workload->triangles_per_frame}}
                 : Json(nullptr)},
            {"ui_offscreen_rendering_observed", nullptr},
            {"internal_render_scale",
             environment.width_pixels > 0 && environment.height_pixels > 0
                 ? Json(environment.raw_workload && environment.raw_workload->composition &&
                                environment.raw_workload->offscreen
                            ? environment.raw_workload->target_scale
                            : 1.0)
                 : Json(nullptr)},
            {"render_width_pixels",
             environment.width_pixels > 0
                 ? Json(environment.raw_workload && environment.raw_workload->composition &&
                                environment.raw_workload->offscreen
                            ? environment.raw_workload->target_width
                            : environment.width_pixels)
                 : Json(nullptr)},
            {"render_height_pixels",
             environment.height_pixels > 0
                 ? Json(environment.raw_workload && environment.raw_workload->composition &&
                                environment.raw_workload->offscreen
                            ? environment.raw_workload->target_height
                            : environment.height_pixels)
                 : Json(nullptr)}};
    };
    for (size_t i = 0; i < result.scenarios.size(); ++i) {
        if (i < scenario_environments.size())
            scenarios[i]["graphics"] = encode_graphics(scenario_environments[i]);
        else if (result.scenarios.size() == 1)
            scenarios[i]["graphics"] = encode_graphics(environment);
        else
            scenarios[i]["graphics"] = nullptr;
    }
    // A mixed-host suite has no single truthful renderer or framebuffer.
    const Json graphics = result.scenarios.size() == 1 || scenario_environments.empty()
                              ? encode_graphics(environment)
                              : Json(nullptr);
    const Json report = {
        {"format", kResultFormat},
        {"version", 1},
        {"configuration", configuration(options)},
        {"build",
         {{"revision", NOVELTEA_BENCHMARK_REVISION},
          {"type", NOVELTEA_BENCHMARK_BUILD_TYPE},
          {"compiler", NOVELTEA_BENCHMARK_COMPILER},
          {"tracked_source_dirty", NOVELTEA_BENCHMARK_SOURCE_DIRTY},
          {"source_fingerprint_sha256", NOVELTEA_BENCHMARK_SOURCE_FINGERPRINT},
          {"devtools", false}}},
        {"graphics", graphics},
        {"timing",
         {{"clock", "steady_clock"},
          {"profile", options.profile},
          {"frame_wall", kWallFrameDescription},
          {"cpu_operation", "CPU wall duration of scenario frame operation"},
          {"gpu_execution_ms", nullptr},
          {"gpu_timing_status", options.profile == "diagnostic"
                                    ? "per-trial when GPU completed-frame IDs are available"
                                    : "unavailable in Clean"},
          {"presented_frame_count", nullptr},
          {"bgfx_wait_submit_ms", nullptr},
          {"bgfx_wait_render_ms", nullptr},
          {"instrumentation_control",
           options.profile == "diagnostic" && result.instrumentation_control
               ? Json{{"scope", "clock-only control after all trials; not full profiling overhead"},
                      {"iterations", result.instrumentation_control->iterations},
                      {"two_clock_reads_ns", result.instrumentation_control->two_clock_reads_ns},
                      {"four_clock_reads_ns", result.instrumentation_control->four_clock_reads_ns},
                      {"incremental_ns", result.instrumentation_control->incremental_ns}}
               : Json(nullptr)}}},
        {"outcome", result.outcome},
        {"scenarios", std::move(scenarios)}};
    return report.dump(2);
}

} // namespace noveltea::benchmark
