#include "benchmark_report.hpp"
#include "benchmark_capacity.hpp"
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

// The graphics-owned Web runner counts rAF scheduling gaps in frame-wall
// samples; only headless Web CPU/asset runs use active-operation timing.
// Native CPU/asset runs use continuous end-to-end intervals, while the native
// decoder explicitly excludes untimed keyframe priming and decoder resets.
const char* frame_wall_description(const Options& options)
{
#if defined(__EMSCRIPTEN__)
    if (is_cpu_scenario(options.scenario) || options.scenario == "asset-source-read" ||
        options.scenario == "asset-project-prepare")
        return "active CPU operation interval per headless work batch; browser scheduling "
               "gaps excluded; no display frame or FPS";
    if (options.scenario == "asset-texture-realize")
        return "requestAnimationFrame-paced interval between GPU-backed asset work batches "
               "(includes browser scheduling and presentation pacing); asset throughput "
               "reflects paced elapsed time, not unpaced CPU throughput or confirmed display FPS";
#else
    if (is_cpu_scenario(options.scenario) || is_asset_scenario(options.scenario))
        return "end-to-end CPU interval between completed work batches; includes time "
               "between operations and is not display frame time or FPS";
    if (options.scenario == "video-decode")
        return "active CPU decoder operation interval; untimed keyframe priming and "
               "decoder reset excluded; no display frame or FPS";
#endif
    return kWallFrameDescription;
}

Json configuration(const Options& options)
{
    Json parameters = Json::object();
    if (is_native_2d_scenario(options.scenario))
        parameters = {{"geometry_quads", options.native_quads},
                      {"glyphs", options.native_glyphs},
                      {"texture_edge", options.native_texture_size},
                      {"font", "system:/fonts/LiberationSans.ttf"},
                      {"font_size_px", 12},
                      {"reference", "native-2d-grid-az-v1"}};
    else if (is_shader_scenario(options.scenario))
        parameters = {{"geometry_quads", options.native_quads},
                      {"texture_edge", options.native_texture_size},
                      {"composition_path", options.composition_path},
                      {"passes", options.composite_passes},
                      {"tint", options.shader_tint},
                      {"scope", options.shader_scope},
                      {"reference", "native-shader-grid-tint-v1"}};
    else if (is_video_scenario(options.scenario))
        parameters = {{"codec", "vp9-profile0-webm"},
                      {"source", "opaque-vp9.webm"},
                      {"width", 32},
                      {"height", 16},
                      {"frame_durations_ms", {50, 50, 50, 50}},
                      {"reference", "production-video-four-frame-v1"},
                      {"decode_measurement",
                       options.scenario == "video-decode"
                           ? "sequential frames 75/125/175 ms; keyframe priming and loop "
                             "reset excluded from operation timing"
                           : "production realtime source timing"}};
    else if (is_asset_scenario(options.scenario))
        parameters = {{"work_units", options.cpu_work_units},
                      {"cache", options.asset_cache},
                      {"input", options.scenario == "asset-project-prepare"
                                    ? "compiled-project-golden/minimal.json"
                                    : "feature-lab/stress-image-{1,2,3}.png"},
                      {"reference", "production-asset-operations-v1"}};
    else if (is_cpu_scenario(options.scenario))
        parameters = {{"work_units", options.cpu_work_units},
                      {"input", options.scenario == "cpu-lua"
                                    ? "Lua ScriptRuntime benchmark_step/64 additions"
                                    : "compiled-project-golden/minimal.json"}};
    else if (options.scenario == "raw-bgfx-geometry")
        parameters = {{"rect_count", options.rect_count}, {"rect_scale", options.rect_scale}};
    else if (options.scenario == "raw-bgfx-textured")
        parameters = {{"texture_size", options.texture_size}, {"coverage", options.coverage}};
    else if (options.scenario == "raw-bgfx-offscreen")
        parameters = {{"texture_size", options.texture_size},
                      {"coverage", options.coverage},
                      {"target_scale", options.target_scale}};
    else if (options.scenario == "raw-bgfx-composition")
        parameters = {{"composition_path", options.composition_path},
                      {"composite_passes", options.composite_passes},
                      {"target_scale", options.target_scale},
                      {"msaa_samples", options.msaa_samples},
                      {"transparent_overlay", options.transparent_overlay},
                      {"texture_size", options.texture_size},
                      {"coverage", options.coverage}};
    else if (is_ui_effects_scenario(options.scenario))
        parameters = {
            {"clipping", options.ui_clipping},   {"transforms", options.ui_transforms},
            {"gradients", options.ui_gradients}, {"filters", options.ui_filters},
            {"masks", options.ui_masks},         {"nested_layers", options.ui_nested_layers}};
    else if (is_ui_scaling_scenario(options.scenario))
        parameters = {{"elements", options.ui_elements},
                      {"text_lines", options.ui_text_lines},
                      {"dynamic_lines", options.ui_dynamic_lines},
                      {"visible_contexts", options.ui_visible_contexts},
                      {"empty_contexts", options.ui_empty_contexts},
                      {"hidden_contexts", options.ui_hidden_contexts},
                      {"text_mode", options.ui_text_mode},
                      {"redraw", options.ui_redraw}};
    else if (options.scenario == "engine-feature-lab")
        parameters = {{"package_path", options.feature_lab_package}};
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
            {"alternate", options.alternate ? Json::parse(encode_configuration(*options.alternate))
                                            : Json(nullptr)},
            {"clock_policy", options.clock_policy},
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
              {"native_resolution", options.native_resolution},
              {"capacity_dimension", options.capacity_dimension},
              {"capacity_target", options.capacity_target},
              {"capacity_threshold", options.capacity_threshold},
              {"capacity_mode", options.capacity_mode},
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
        {"rmlui_update_ms", distribution(value.rmlui_update_ms)},
        {"rmlui_render_ms", distribution(value.rmlui_render_ms)},
        {"ui_fixture_mutation_ms", distribution(value.ui_fixture_mutation_ms)},
        {"engine_events_ms", distribution(value.engine_events_ms)},
        {"engine_jobs_ms", distribution(value.engine_jobs_ms)},
        {"engine_assets_ms", distribution(value.engine_assets_ms)},
        {"engine_update_ms", distribution(value.engine_update_ms)},
        {"engine_runtime_ms", distribution(value.engine_runtime_ms)},
        {"engine_layout_ms", distribution(value.engine_layout_ms)},
        {"engine_render_ms", distribution(value.engine_render_ms)},
        {"engine_scope", "owner-thread production Engine tick; update overlaps the jobs, "
                         "assets, runtime and layout phases; events, jobs, assets, "
                         "runtime, layout realization, render; render includes CPU-side "
                         "presentation and bgfx::frame blocking, not GPU execution"},
        {"rmlui_scope", "RmlUi Context::Update() and Context::Render() CPU; Update includes "
                        "CSS layout when dirty; Render includes submission, not bgfx handoff"},
        {"ui_fixture_scope", "benchmark-side workload mutations before standalone RmlUi Update; "
                             "separate from Update/Render and absent for Engine-hosted UI"},
        {"stage_additivity", "non-additive: nested/overlapping boundaries, clock overhead and "
                             "async bgfx stats; do not sum across owners"},
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
                           "clock_policy", "settings", "alternate"}) ||
        !root["format"].is_string() || root["format"] != kConfigFormat ||
        !root["version"].is_number_integer() || root["version"] != 1 ||
        !root["scenario"].is_string() || root["scenario"].get<std::string>().empty() ||
        !root["scenario_version"].is_number_integer() || root["scenario_version"] != 1 ||
        !root["parameters"].is_object() || !root["clock_policy"].is_string() ||
        (root["clock_policy"] != "realtime" && root["clock_policy"] != "fixed-step")) {
        reason = "invalid or unsupported benchmark configuration schema";
        return false;
    }
    const std::string scenario = root["scenario"].get<std::string>();
    const auto& parameters = root["parameters"];
    if (is_native_2d_scenario(scenario)) {
        if (!has_fields(parameters, {"geometry_quads", "glyphs", "texture_edge", "font",
                                     "font_size_px", "reference"}) ||
            !unsigned_integer(parameters, "geometry_quads") ||
            !unsigned_integer(parameters, "glyphs") ||
            !unsigned_integer(parameters, "texture_edge") ||
            parameters["geometry_quads"].get<uint64_t>() < 1 ||
            parameters["geometry_quads"].get<uint64_t>() > 2048 ||
            parameters["glyphs"].get<uint64_t>() < 1 ||
            parameters["glyphs"].get<uint64_t>() > 4096 ||
            parameters["texture_edge"].get<uint64_t>() > 1024 || !parameters["font"].is_string() ||
            parameters["font"] != "system:/fonts/LiberationSans.ttf" ||
            !unsigned_integer(parameters, "font_size_px") || parameters["font_size_px"] != 12 ||
            !parameters["reference"].is_string() ||
            parameters["reference"] != "native-2d-grid-az-v1") {
            reason = "invalid native 2D benchmark parameters or reference identity";
            return false;
        }
    } else if (is_shader_scenario(scenario)) {
        if (!has_fields(parameters, {"geometry_quads", "texture_edge", "composition_path", "passes",
                                     "tint", "scope", "reference"}) ||
            !unsigned_integer(parameters, "geometry_quads") ||
            !unsigned_integer(parameters, "texture_edge") ||
            !unsigned_integer(parameters, "passes") || !numeric(parameters, "tint") ||
            !parameters["composition_path"].is_string() || !parameters["scope"].is_string() ||
            !parameters["reference"].is_string() ||
            parameters["geometry_quads"].get<uint64_t>() < 1 ||
            parameters["geometry_quads"].get<uint64_t>() > 2048 ||
            parameters["texture_edge"].get<uint64_t>() > 1024 ||
            parameters["passes"].get<uint64_t>() > 4 || parameters["tint"].get<double>() < 0.0 ||
            parameters["tint"].get<double>() > 1.0 ||
            parameters["reference"] != "native-shader-grid-tint-v1") {
            reason = "invalid native shader material benchmark parameters";
            return false;
        }
    } else if (is_video_scenario(scenario)) {
        if (!has_fields(parameters, {"codec", "source", "width", "height", "frame_durations_ms",
                                     "reference", "decode_measurement"}) ||
            parameters["codec"] != "vp9-profile0-webm" ||
            parameters["source"] != "opaque-vp9.webm" || parameters["width"] != 32 ||
            parameters["height"] != 16 ||
            parameters["frame_durations_ms"] != Json::array({50, 50, 50, 50}) ||
            parameters["reference"] != "production-video-four-frame-v1" ||
            parameters["decode_measurement"] !=
                (scenario == "video-decode"
                     ? "sequential frames 75/125/175 ms; keyframe priming and loop "
                       "reset excluded from operation timing"
                     : "production realtime source timing")) {
            reason = "invalid current video workload fixture identity";
            return false;
        }
    } else if (is_asset_scenario(scenario)) {
        if (!has_fields(parameters, {"work_units", "cache", "input", "reference"}) ||
            !unsigned_integer(parameters, "work_units") ||
            parameters["work_units"].get<uint64_t>() < 1 ||
            parameters["work_units"].get<uint64_t>() > 64 || !parameters["cache"].is_string() ||
            (parameters["cache"] != "cold" && parameters["cache"] != "warm") ||
            !parameters["input"].is_string() ||
            parameters["input"] != (scenario == "asset-project-prepare"
                                        ? "compiled-project-golden/minimal.json"
                                        : "feature-lab/stress-image-{1,2,3}.png") ||
            parameters["reference"] != "production-asset-operations-v1") {
            reason = "invalid asset workload identity, unit count or cache mode";
            return false;
        }
    } else if (is_cpu_scenario(scenario)) {
        if (!has_fields(parameters, {"work_units", "input"}) ||
            !unsigned_integer(parameters, "work_units") ||
            parameters["work_units"].get<uint64_t>() < 1 ||
            parameters["work_units"].get<uint64_t>() > 4096 || !parameters["input"].is_string() ||
            parameters["input"] != (scenario == "cpu-lua"
                                        ? "Lua ScriptRuntime benchmark_step/64 additions"
                                        : "compiled-project-golden/minimal.json")) {
            reason = "invalid CPU workload parameters or input identity";
            return false;
        }
    } else if (scenario == "raw-bgfx-empty" || scenario == "standalone-rmlui-simple" ||
               scenario == "integrated-rmlui-production" ||
               scenario == "integrated-rmlui-controlled" || scenario == "engine-empty" ||
               scenario == "engine-compiled-empty" || scenario == "engine-compiled-menu") {
        if (!parameters.empty()) {
            reason = "empty scenario does not take geometry parameters";
            return false;
        }
    } else if (scenario == "engine-feature-lab") {
        if (!has_fields(parameters, {"package_path"}) || !parameters["package_path"].is_string()) {
            reason = "invalid Feature Lab package path";
            return false;
        }
    } else if (is_ui_effects_scenario(scenario)) {
        if (!has_fields(parameters, {"clipping", "transforms", "gradients", "filters", "masks",
                                     "nested_layers"}) ||
            !unsigned_integer(parameters, "clipping") ||
            !unsigned_integer(parameters, "transforms") ||
            !unsigned_integer(parameters, "gradients") ||
            !unsigned_integer(parameters, "filters") || !unsigned_integer(parameters, "masks") ||
            !unsigned_integer(parameters, "nested_layers") ||
            parameters["clipping"].get<uint64_t>() > 16 ||
            parameters["transforms"].get<uint64_t>() > 16 ||
            parameters["gradients"].get<uint64_t>() > 16 ||
            parameters["filters"].get<uint64_t>() > 16 ||
            parameters["masks"].get<uint64_t>() > 16 ||
            parameters["nested_layers"].get<uint64_t>() > 16 ||
            !valid_ui_effects_parameters(
                {static_cast<uint32_t>(parameters["clipping"].get<uint64_t>()),
                 static_cast<uint32_t>(parameters["transforms"].get<uint64_t>()),
                 static_cast<uint32_t>(parameters["gradients"].get<uint64_t>()),
                 static_cast<uint32_t>(parameters["filters"].get<uint64_t>()),
                 static_cast<uint32_t>(parameters["masks"].get<uint64_t>()),
                 static_cast<uint32_t>(parameters["nested_layers"].get<uint64_t>())})) {
            reason = "invalid RmlUi effects reference parameters";
            return false;
        }
    } else if (is_ui_scaling_scenario(scenario)) {
        if (!has_fields(parameters, {"elements", "text_lines", "dynamic_lines", "visible_contexts",
                                     "empty_contexts", "hidden_contexts", "text_mode", "redraw"}) ||
            !unsigned_integer(parameters, "elements") ||
            !unsigned_integer(parameters, "text_lines") ||
            !unsigned_integer(parameters, "dynamic_lines") ||
            !unsigned_integer(parameters, "visible_contexts") ||
            !unsigned_integer(parameters, "empty_contexts") ||
            !unsigned_integer(parameters, "hidden_contexts") ||
            !parameters["text_mode"].is_string() || !parameters["redraw"].is_string() ||
            parameters["elements"].get<uint64_t>() > 2048 ||
            parameters["text_lines"].get<uint64_t>() > 256 ||
            parameters["dynamic_lines"].get<uint64_t>() > 256 ||
            (parameters["text_mode"] == "dynamic" &&
             parameters["dynamic_lines"].get<uint64_t>() >
                 parameters["text_lines"].get<uint64_t>()) ||
            parameters["visible_contexts"].get<uint64_t>() > 8 ||
            parameters["empty_contexts"].get<uint64_t>() > 16 ||
            parameters["hidden_contexts"].get<uint64_t>() > 16 ||
            !valid_ui_scaling_parameters(
                static_cast<uint32_t>(parameters["elements"].get<uint64_t>()),
                static_cast<uint32_t>(parameters["text_lines"].get<uint64_t>()),
                static_cast<uint32_t>(parameters["visible_contexts"].get<uint64_t>()),
                static_cast<uint32_t>(parameters["empty_contexts"].get<uint64_t>()),
                static_cast<uint32_t>(parameters["hidden_contexts"].get<uint64_t>()),
                parameters["text_mode"].get<std::string>(),
                parameters["redraw"].get<std::string>())) {
            reason = "invalid RmlUi scaling reference parameters";
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
        const bool scaled = scenario == "raw-bgfx-offscreen";
        const bool variable = scenario == "raw-bgfx-draw-calls";
        if (variable
                ? !has_fields(parameters, {"draw_calls", "quad_count", "texture_size", "coverage"})
            : textured
                ? (scaled ? !has_fields(parameters, {"texture_size", "coverage", "target_scale"})
                          : !has_fields(parameters, {"texture_size", "coverage"}))
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
              parameters["texture_size"].get<uint64_t>() > 2048)) ||
            (scaled && !numeric(parameters, "target_scale"))) {
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
                               "no_ui", "quick_suite", "raw_samples", "vsync", "native_resolution",
                               "output", "capacity_dimension", "capacity_target",
                               "capacity_threshold", "capacity_mode"}) ||
        !unsigned_integer(settings, "width") || !unsigned_integer(settings, "height") ||
        !numeric(settings, "warmup_seconds") || !numeric(settings, "measurement_seconds") ||
        !unsigned_integer(settings, "measurement_frames") ||
        !unsigned_integer(settings, "repeats") || !numeric(settings, "ready_timeout_seconds") ||
        !settings["profile"].is_string() ||
        (settings["profile"] != "clean" && settings["profile"] != "diagnostic") ||
        !settings["no_ui"].is_boolean() || !settings["quick_suite"].is_boolean() ||
        !settings["raw_samples"].is_boolean() || !settings["vsync"].is_boolean() ||
        !settings["native_resolution"].is_boolean() || !settings["output"].is_string() ||
        !settings["capacity_dimension"].is_string() || !settings["capacity_target"].is_string() ||
        !numeric(settings, "capacity_threshold") || !settings["capacity_mode"].is_string()) {
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
    next.clock_policy = root["clock_policy"].get<std::string>();
    if (is_native_2d_scenario(scenario)) {
        next.native_quads = static_cast<uint32_t>(parameters["geometry_quads"].get<uint64_t>());
        next.native_glyphs = static_cast<uint32_t>(parameters["glyphs"].get<uint64_t>());
        next.native_texture_size =
            static_cast<uint32_t>(parameters["texture_edge"].get<uint64_t>());
    }
    if (is_shader_scenario(scenario)) {
        next.native_quads = static_cast<uint32_t>(parameters["geometry_quads"].get<uint64_t>());
        next.native_texture_size =
            static_cast<uint32_t>(parameters["texture_edge"].get<uint64_t>());
        next.composition_path = parameters["composition_path"].get<std::string>();
        next.composite_passes = static_cast<uint32_t>(parameters["passes"].get<uint64_t>());
        next.shader_tint = parameters["tint"].get<double>();
        next.shader_scope = parameters["scope"].get<std::string>();
    }
    if (is_cpu_scenario(scenario) || is_asset_scenario(scenario))
        next.cpu_work_units = static_cast<uint32_t>(parameters["work_units"].get<uint64_t>());
    if (is_asset_scenario(scenario))
        next.asset_cache = parameters["cache"].get<std::string>();
    if (scenario == "engine-feature-lab")
        next.feature_lab_package = parameters["package_path"].get<std::string>();
    if (is_ui_effects_scenario(scenario)) {
        next.ui_clipping = static_cast<uint32_t>(parameters["clipping"].get<uint64_t>());
        next.ui_transforms = static_cast<uint32_t>(parameters["transforms"].get<uint64_t>());
        next.ui_gradients = static_cast<uint32_t>(parameters["gradients"].get<uint64_t>());
        next.ui_filters = static_cast<uint32_t>(parameters["filters"].get<uint64_t>());
        next.ui_masks = static_cast<uint32_t>(parameters["masks"].get<uint64_t>());
        next.ui_nested_layers = static_cast<uint32_t>(parameters["nested_layers"].get<uint64_t>());
    }
    if (is_ui_scaling_scenario(scenario)) {
        next.ui_elements = static_cast<uint32_t>(parameters["elements"].get<uint64_t>());
        next.ui_text_lines = static_cast<uint32_t>(parameters["text_lines"].get<uint64_t>());
        next.ui_dynamic_lines = static_cast<uint32_t>(parameters["dynamic_lines"].get<uint64_t>());
        next.ui_visible_contexts =
            static_cast<uint32_t>(parameters["visible_contexts"].get<uint64_t>());
        next.ui_empty_contexts =
            static_cast<uint32_t>(parameters["empty_contexts"].get<uint64_t>());
        next.ui_hidden_contexts =
            static_cast<uint32_t>(parameters["hidden_contexts"].get<uint64_t>());
        next.ui_text_mode = parameters["text_mode"].get<std::string>();
        next.ui_redraw = parameters["redraw"].get<std::string>();
    }
    if (scenario == "raw-bgfx-geometry") {
        next.rect_count = static_cast<uint32_t>(parameters["rect_count"].get<uint64_t>());
        next.rect_scale = parameters["rect_scale"].get<double>();
    }
    if (scenario == "raw-bgfx-offscreen")
        next.target_scale = parameters["target_scale"].get<double>();
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
    next.native_resolution = settings["native_resolution"].get<bool>();
    next.output_path = settings["output"].get<std::string>();
    next.capacity_dimension = settings["capacity_dimension"].get<std::string>();
    next.capacity_target = settings["capacity_target"].get<std::string>();
    next.capacity_threshold = settings["capacity_threshold"].get<double>();
    next.capacity_mode = settings["capacity_mode"].get<std::string>();
    if (!root["alternate"].is_null()) {
        if (!root["alternate"].is_object()) {
            reason = "alternate comparison configuration must be an object or null";
            return false;
        }
        if (!root["alternate"].contains("alternate") || !root["alternate"]["alternate"].is_null()) {
            reason = "nested A/B/A comparisons are unsupported";
            return false;
        }
        Options candidate;
        if (!decode_configuration(root["alternate"].dump(), candidate, reason))
            return false;
        next.alternate = std::make_shared<Options>(std::move(candidate));
    }
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
            Json attempts = Json::array();
            for (const auto& attempt : trial.interrupted_attempts)
                attempts.push_back({{"reason", attempt.reason},
                                    {"warmup_frames", attempt.warmup_frames},
                                    {"measured_frames", attempt.measured_frames}});
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
                 {"arm", trial.arm},
                 {"interrupted_attempts", std::move(attempts)},
                 {"reason", trial.reason.empty() ? Json(nullptr) : Json(trial.reason)},
                 {"phases", std::move(phases)},
                 {"interruption_retries", trial.interruption_retries},
                 {"warmup_frames", trial.warmup_frames},
                 {"measured_frames", trial.measured_frames},
                 {"measured_wall_seconds",
                  trial.measured_frames > 0 ? Json(trial.measured_wall_seconds) : Json(nullptr)},
                 {"frame_loop_cadence_hz",
                  !is_cpu_scenario(options.scenario) && !is_asset_scenario(options.scenario) &&
                          options.scenario != "video-decode" && trial.outcome == "complete" &&
                          trial.measured_wall_seconds > 0.0
                      ? Json(static_cast<double>(trial.measured_frames) /
                             trial.measured_wall_seconds)
                      : Json(nullptr)},
                 {"frame_wall_ms", distribution(trial.wall_frame)},
                 {"cpu_operation_ms", distribution(trial.cpu_operation)},
                 {"diagnostic", options.profile == "diagnostic" && trial.outcome == "complete"
                                    ? diagnostic_result(trial.diagnostic)
                                    : Json(nullptr)},
                 {"raw_samples", std::move(raw)}});
            if (is_cpu_scenario(options.scenario) || is_asset_scenario(options.scenario) ||
                options.scenario == "video-decode") {
                const char* throughput_key =
                    is_asset_scenario(options.scenario) ? "asset_work_batches_per_second"
                    : is_cpu_scenario(options.scenario) ? "cpu_work_batches_per_second"
                                                        : "video_decode_work_units_per_second";
                trials.back()[throughput_key] =
                    trial.outcome == "complete" && trial.measured_wall_seconds > 0.0
                        ? Json(static_cast<double>(trial.measured_frames) /
                               trial.measured_wall_seconds)
                        : Json(nullptr);
            }
        }
        const auto group = [](const TrialGroupSummary& value) {
            return Json{{"completed_trials", value.completed},
                        {"trial_wall_medians_ms", distribution(value.wall_medians)},
                        {"trial_cpu_medians_ms", distribution(value.cpu_medians)},
                        {"trial_wall_p95_ms", distribution(value.wall_p95)},
                        {"trial_cpu_p95_ms", distribution(value.cpu_p95)},
                        {"trial_wall_p99_ms", distribution(value.wall_p99)},
                        {"trial_cpu_p99_ms", distribution(value.cpu_p99)}};
        };
        Json repeated = nullptr;
        if (scenario.repeated) {
            const auto& value = *scenario.repeated;
            repeated = {{"trials", group(value.trials)},
                        {"wall_drift_percent", value.wall_drift_percent
                                                   ? Json(*value.wall_drift_percent)
                                                   : Json(nullptr)},
                        {"cpu_drift_percent",
                         value.cpu_drift_percent ? Json(*value.cpu_drift_percent) : Json(nullptr)},
                        {"warnings", value.warnings}};
        }
        Json alternating = nullptr;
        if (scenario.alternating) {
            const auto& comparison = *scenario.alternating;
            alternating = {{"order", "A/B/A"},
                           {"baseline", group(comparison.baseline)},
                           {"candidate", group(comparison.candidate)},
                           {"wall_delta_percent", comparison.wall_delta_percent
                                                      ? Json(*comparison.wall_delta_percent)
                                                      : Json(nullptr)},
                           {"cpu_delta_percent", comparison.cpu_delta_percent
                                                     ? Json(*comparison.cpu_delta_percent)
                                                     : Json(nullptr)},
                           {"wall_drift_percent", comparison.wall_drift_percent
                                                      ? Json(*comparison.wall_drift_percent)
                                                      : Json(nullptr)},
                           {"cpu_drift_percent", comparison.cpu_drift_percent
                                                     ? Json(*comparison.cpu_drift_percent)
                                                     : Json(nullptr)},
                           {"warnings", comparison.warnings}};
        }
        scenarios.push_back(
            {{"alternating", std::move(alternating)},
             {"repeated", std::move(repeated)},
             {"id", scenario.scenario},
             {"description", scenario.description},
             {"outcome", scenario.outcome},
             {"trials", std::move(trials)},
             {"aggregate",
              {{"measured_frames", scenario.measured_frames},
               {"measured_wall_seconds", scenario.measured_wall_seconds},
               {"frame_loop_cadence_hz",
                !is_cpu_scenario(options.scenario) && !is_asset_scenario(options.scenario) &&
                        options.scenario != "video-decode" && scenario.measured_wall_seconds > 0.0
                    ? Json(static_cast<double>(scenario.measured_frames) /
                           scenario.measured_wall_seconds)
                    : Json(nullptr)},
               {"frame_wall_ms", distribution(scenario.wall_frame)},
               {"cpu_operation_ms", distribution(scenario.cpu_operation)}}}});
        if (is_cpu_scenario(options.scenario) || is_asset_scenario(options.scenario) ||
            options.scenario == "video-decode") {
            const char* throughput_key =
                is_asset_scenario(options.scenario) ? "asset_work_batches_per_second"
                : is_cpu_scenario(options.scenario) ? "cpu_work_batches_per_second"
                                                    : "video_decode_work_units_per_second";
            scenarios.back()["aggregate"][throughput_key] =
                scenario.measured_wall_seconds > 0.0
                    ? Json(static_cast<double>(scenario.measured_frames) /
                           scenario.measured_wall_seconds)
                    : Json(nullptr);
        }
    }
    const auto encode_graphics = [&options](const Environment& environment) -> Json {
        const auto& backend = environment.video_codec_backend;
        Json hardware_decode = nullptr;
        if (backend == "libvpx-vp9")
            hardware_decode = false;
        else if (backend == "nvdec-vp9" || backend == "va-api-vp9" || backend == "mediacodec-vp9" ||
                 backend == "mediafoundation-vp9" || backend == "videotoolbox-vp9")
            hardware_decode = true;
        return {
            {"platform", environment.platform},
            {"asset_workload",
             is_asset_scenario(options.scenario)
                 ? Json{{"manager_cache", options.asset_cache},
                        {"os_page_cache", "uncontrolled"},
                        {"source_backend", environment.platform == "Android" ? "SDL packaged assets"
                                           : environment.platform == "Emscripten"
                                               ? "Web MEMFS"
                                               : "directory source"},
                        {"graphics_backend", options.scenario == "asset-texture-realize"
                                                 ? "production Renderer/bgfx"
                                                 : "none"},
                        {"gpu_upload_execution_ms", nullptr}}
                 : Json(nullptr)},
            {"browser", environment.browser},
            {"video_driver",
             environment.video_driver.empty() ? Json(nullptr) : Json(environment.video_driver)},
            {"renderer", environment.renderer.empty() ? Json(nullptr) : Json(environment.renderer)},
            {"frame_path",
             environment.frame_path.empty() ? Json(nullptr) : Json(environment.frame_path)},
            {"video_decode_backend", environment.video_codec_backend.empty()
                                         ? Json(nullptr)
                                         : Json(environment.video_codec_backend)},
            {"video_decode_fallback", environment.video_codec_fallback.empty()
                                          ? Json(nullptr)
                                          : Json(environment.video_codec_fallback)},
            {"video_upload_pipeline", environment.video_upload_pipeline.empty()
                                          ? Json(nullptr)
                                          : Json(environment.video_upload_pipeline)},
            {"video_hardware_decode_confirmed", hardware_decode},
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
            {"ui_effect_backend_callbacks",
             environment.ui_effect_activity
                 ? Json{{"capture_scope",
                         "preparation-only; observed renderer callbacks, not GPU timings"},
                        {"clipping_calls", environment.ui_effect_activity->clipping_calls},
                        {"transforms", environment.ui_effect_activity->transforms},
                        {"gradient_draws", environment.ui_effect_activity->gradient_draws},
                        {"filtered_composites",
                         environment.ui_effect_activity->filtered_composites},
                        {"mask_saves", environment.ui_effect_activity->mask_saves},
                        {"layer_pushes", environment.ui_effect_activity->layer_pushes},
                        {"max_layer_depth", environment.ui_effect_activity->max_layer_depth},
                        {"backend_errors", environment.ui_effect_activity->backend_errors}}
                 : Json(nullptr)},
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
                 ? Json(environment.raw_workload && environment.raw_workload->offscreen
                            ? environment.raw_workload->target_scale
                            : 1.0)
                 : Json(nullptr)},
            {"render_width_pixels",
             environment.width_pixels > 0
                 ? Json(environment.raw_workload && environment.raw_workload->offscreen
                            ? environment.raw_workload->target_width
                            : environment.width_pixels)
                 : Json(nullptr)},
            {"render_height_pixels",
             environment.height_pixels > 0
                 ? Json(environment.raw_workload && environment.raw_workload->offscreen
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
    // The scenario's observed graphics host takes precedence over the caller's
    // fallback (which may still describe the Web dashboard after an Engine run).
    // A mixed-host collection has no truthful single top-level graphics owner.
    const Json graphics =
        result.scenarios.size() == 1
            ? encode_graphics(scenario_environments.empty() ? environment
                                                            : scenario_environments.front())
        : scenario_environments.empty() ? encode_graphics(environment)
                                        : Json(nullptr);
    Json capacity = nullptr;
    if (result.capacity) {
        Json probes = Json::array();
        for (const auto& probe : result.capacity->probes) {
            probes.push_back(
                {{"workload", probe.workload},
                 {"outcome", probe.outcome},
                 {"observed", probe.observed ? Json(*probe.observed) : Json(nullptr)},
                 {"measured_batches", probe.completed_batches},
                 {"offscreen_work_units", result.capacity->mode == "offscreen"
                                              ? Json(probe.completed_work_units)
                                              : Json(nullptr)},
                 {"work_units_per_cpu_second",
                  result.capacity->mode == "offscreen" && probe.work_units_per_cpu_second
                      ? Json(*probe.work_units_per_cpu_second)
                      : Json(nullptr)}});
        }
        capacity = {
            {"dimension", result.capacity->dimension},
            {"target", result.capacity->target},
            {"threshold", result.capacity->threshold},
            {"mode", result.capacity->mode},
            {"measurement", result.capacity->mode == "offscreen"
                                ? "bounded GPU render-target draw work units per CPU operation; "
                                  "no display FPS or inferred unpaced GPU throughput"
                                : "application-frame observations, may be compositor/rAF paced; "
                                  "not confirmed display FPS or uncapped GPU throughput"},
            {"units_per_batch",
             result.capacity->mode == "offscreen" ? kOffscreenWorkUnitsPerBatch : 1u},
            {"status", result.capacity->status},
            {"reason", result.capacity->reason},
            {"maximum_passing_workload", result.capacity->maximum_passing_workload
                                             ? Json(*result.capacity->maximum_passing_workload)
                                             : Json(nullptr)},
            {"probes", std::move(probes)}};
    }
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
          {"frame_wall", frame_wall_description(options)},
          {"cpu_operation",
           is_asset_scenario(options.scenario)
               ? "CPU duration of a configured batch of production asset operations; "
                 "includes source I/O, codec, or typed request/finalization and "
                 "renderer handoff as selected, not GPU execution time"
           : is_cpu_scenario(options.scenario)
               ? "CPU duration of one configured work batch; includes only "
                 "the selected Lua, Runtime Session, or prediction operations"
               : "CPU wall duration of scenario frame operation"},
          {"gpu_execution_ms", nullptr},
          {"gpu_timing_status", is_asset_scenario(options.scenario)
                                    ? "unavailable: texture upload GPU time cannot be identified "
                                      "by a completed-frame timer"
                                : options.profile == "diagnostic"
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
        {"capacity_search", std::move(capacity)},
        {"outcome", result.outcome},
        {"scenarios", std::move(scenarios)}};
    return report.dump(2);
}

} // namespace noveltea::benchmark
