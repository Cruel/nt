#include "benchmark_report.hpp"

#include <nlohmann/json.hpp>

#include <cstdio>
#include <string>

namespace {
using noveltea::benchmark::decode_configuration;
using noveltea::benchmark::encode_configuration;
using noveltea::benchmark::encode_result;
using noveltea::benchmark::Options;

bool check(bool success, const char* explanation)
{
    if (!success)
        std::fprintf(stderr, "report contract: %s\n", explanation);
    return success;
}

bool rejected(nlohmann::json value)
{
    Options options;
    std::string error;
    return !decode_configuration(value.dump(), options, error) && !error.empty();
}
} // namespace

int main()
{
    Options original;
    original.warmup_seconds = 0.5;
    original.measurement_frames = 41;
    original.repeats = 3;
    original.raw_samples = true;
    original.output_path = "run.json";
    std::string error;
    Options roundtrip;
    const auto configured = nlohmann::json::parse(encode_configuration(original));
    if (!check(decode_configuration(configured.dump(), roundtrip, error) &&
                   roundtrip.measurement_frames == 41 && roundtrip.repeats == 3 &&
                   roundtrip.warmup_seconds == 0.5 && roundtrip.raw_samples &&
                   roundtrip.output_path == "run.json",
               "current config roundtrip"))
        return 1;

    Options quick_options = original;
    quick_options.quick_suite = true;
    const auto quick_config = nlohmann::json::parse(encode_configuration(quick_options));
    Options quick_roundtrip;
    auto invalid_quick = quick_config;
    invalid_quick["settings"]["quick_suite"] = "yes";
    if (!check(quick_config["settings"]["quick_suite"] == true &&
                   decode_configuration(quick_config.dump(), quick_roundtrip, error) &&
                   quick_roundtrip.quick_suite &&
                   nlohmann::json::parse(encode_configuration(quick_roundtrip)) == quick_config &&
                   rejected(invalid_quick),
               "Quick Suite is encoded in the canonical run configuration"))
        return 1;

    Options composition;
    composition.scenario = "raw-bgfx-composition";
    composition.composition_path = "offscreen";
    composition.composite_passes = 3;
    composition.target_scale = 0.5;
    composition.msaa_samples = 2;
    composition.transparent_overlay = false;
    composition.coverage = 0.375;
    const auto composition_json = nlohmann::json::parse(encode_configuration(composition));
    Options composition_decoded;
    if (!check(decode_configuration(composition_json.dump(), composition_decoded, error) &&
                   composition_decoded.composition_path == "offscreen" &&
                   composition_decoded.composite_passes == 3 &&
                   composition_decoded.target_scale == 0.5 &&
                   composition_decoded.msaa_samples == 2 &&
                   !composition_decoded.transparent_overlay &&
                   nlohmann::json::parse(encode_configuration(composition_decoded)) ==
                       composition_json,
               "composition configuration roundtrips with all independent controls"))
        return 1;
    auto bad_composition = composition_json;
    bad_composition["parameters"]["msaa_samples"] = 3;
    auto bad_keys = composition_json;
    bad_keys["parameters"]["unknown"] = 1;
    auto invalid_direct = composition_json;
    invalid_direct["parameters"]["composition_path"] = "direct";
    if (!check(rejected(bad_composition) && rejected(bad_keys) && rejected(invalid_direct),
               "composition rejects invalid MSAA, keys and non-equivalent direct settings"))
        return 1;
    auto old_version = configured;
    old_version["version"] = 0;
    auto wrong_scenario_version = configured;
    wrong_scenario_version["scenario_version"] = 2;
    auto bad_parameters = configured;
    bad_parameters["parameters"]["draw_calls"] = 10;
    Options geometry_options;
    geometry_options.scenario = "raw-bgfx-geometry";
    geometry_options.rect_count = 12;
    geometry_options.rect_scale = 0.75;
    auto geometry_config = nlohmann::json::parse(encode_configuration(geometry_options));
    Options geometry_roundtrip;
    if (!check(decode_configuration(geometry_config.dump(), geometry_roundtrip, error) &&
                   geometry_roundtrip.scenario == "raw-bgfx-geometry" &&
                   geometry_roundtrip.rect_count == 12 && geometry_roundtrip.rect_scale == 0.75 &&
                   nlohmann::json::parse(encode_configuration(geometry_roundtrip)) ==
                       geometry_config,
               "geometry scenario canonical config roundtrip"))
        return 1;
    for (const char* id : {"raw-bgfx-clear", "raw-bgfx-single-quad", "raw-bgfx-textured",
                           "raw-bgfx-offscreen", "raw-bgfx-draw-calls"}) {
        Options raw_options;
        raw_options.scenario = id;
        raw_options.draw_calls = id == std::string("raw-bgfx-draw-calls") ? 7 : 64;
        raw_options.quad_count = id == std::string("raw-bgfx-draw-calls") ? 9 : 1;
        raw_options.texture_size =
            (id == std::string("raw-bgfx-draw-calls") || id == std::string("raw-bgfx-offscreen") ||
             id == std::string("raw-bgfx-textured"))
                ? 64
                : 256;
        raw_options.coverage = (raw_options.texture_size == 64) ? 0.5 : 1.0;
        const auto json = nlohmann::json::parse(encode_configuration(raw_options));
        Options decoded;
        if (!check(decode_configuration(json.dump(), decoded, error) && decoded.scenario == id &&
                       decoded.draw_calls == raw_options.draw_calls &&
                       decoded.quad_count == raw_options.quad_count &&
                       decoded.texture_size == raw_options.texture_size &&
                       decoded.coverage == raw_options.coverage &&
                       nlohmann::json::parse(encode_configuration(decoded)) == json,
                   "every raw bgfx scenario retains a strict canonical identity"))
            return 1;
        auto extra_parameters = json;
        extra_parameters["parameters"]["unknown"] = true;
        if (!check(rejected(extra_parameters), "raw workload rejects unexpected parameter keys"))
            return 1;
        if (json["parameters"].contains("texture_size")) {
            auto bad_texture = json;
            bad_texture["parameters"]["texture_size"] = 63;
            auto bad_coverage = json;
            bad_coverage["parameters"]["coverage"] = 2.0;
            if (!check(rejected(bad_texture) && rejected(bad_coverage),
                       "raw texture and coverage bounds are enforced"))
                return 1;
        }
    }
    Options ui_options;
    ui_options.scenario = "standalone-rmlui-simple";
    const auto ui_config = nlohmann::json::parse(encode_configuration(ui_options));
    Options ui_roundtrip;
    if (!check(ui_config["parameters"].empty() &&
                   decode_configuration(ui_config.dump(), ui_roundtrip, error) &&
                   ui_roundtrip.scenario == ui_options.scenario &&
                   nlohmann::json::parse(encode_configuration(ui_roundtrip)) == ui_config,
               "standalone RmlUi has a stable, parameter-free reference identity"))
        return 1;
    for (const char* id : {"integrated-rmlui-controlled", "integrated-rmlui-production"}) {
        Options integrated = ui_options;
        integrated.scenario = id;
        const auto config = nlohmann::json::parse(encode_configuration(integrated));
        Options decoded;
        if (!check(config["parameters"].empty() &&
                       decode_configuration(config.dump(), decoded, error) &&
                       decoded.scenario == id &&
                       nlohmann::json::parse(encode_configuration(decoded)) == config,
                   "integrated Engine UI mode has a stable, parameter-free identity"))
            return 1;
        const auto unavailable = nlohmann::json::parse(encode_result(integrated, {}, {}));
        if (!check(unavailable["graphics"]["ui_base_direct_compat"].is_null() &&
                       unavailable["graphics"]["ui_reference_msaa_samples"].is_null(),
                   "missing live RmlUi adapter settings are not guessed from scenario names"))
            return 1;
        noveltea::benchmark::Environment env;
        env.ui_backend = noveltea::benchmark::UiBackendSettings{
            .reference_msaa_samples = 2,
            .base_direct_compatibility_requested =
                integrated.scenario == "integrated-rmlui-controlled",
            .preserve_backbuffer = true,
            .optimized_render_path = true,
            .viewport_width = 1280,
            .viewport_height = 720,
        };
        const auto rendered = nlohmann::json::parse(encode_result(integrated, env, {}));
        if (!check(rendered["graphics"]["ui_base_direct_compat"] ==
                           (integrated.scenario == "integrated-rmlui-controlled") &&
                       rendered["graphics"]["ui_reference_msaa_samples"] == 2 &&
                       rendered["graphics"]["ui_base_presentation_policy"] ==
                           "offscreen-required-by-msaa" &&
                       rendered["graphics"]["ui_preserve_backbuffer"] == true &&
                       rendered["graphics"]["ui_output_framebuffer"] == "backbuffer" &&
                       rendered["graphics"]["ui_offscreen_rendering_observed"].is_null(),
                   "render report preserves live backend settings without fabricated observations"))
            return 1;
    }
    for (const char* id : {"standalone-rmlui-effects", "integrated-rmlui-effects"}) {
        Options effects;
        effects.scenario = id;
        effects.ui_clipping = 0;
        effects.ui_transforms = 2;
        effects.ui_gradients = 3;
        effects.ui_filters = 1;
        effects.ui_masks = 1;
        effects.ui_nested_layers = 2;
        const auto encoded = nlohmann::json::parse(encode_configuration(effects));
        Options roundtrip;
        if (!check(decode_configuration(encoded.dump(), roundtrip, error) &&
                       nlohmann::json::parse(encode_configuration(roundtrip)) == encoded &&
                       roundtrip.ui_masks == 1 && roundtrip.ui_clipping == 0,
                   "advanced effects configuration has exact cross-host roundtrip"))
            return 1;
        auto unknown = encoded;
        unknown["parameters"]["unspecified"] = 3;
        if (!check(!decode_configuration(unknown.dump(), roundtrip, error),
                   "unknown effect parameter is rejected"))
            return 1;
        auto invalid = encoded;
        invalid["parameters"]["masks"] = 17;
        if (!check(!decode_configuration(invalid.dump(), roundtrip, error),
                   "effect bound is rejected"))
            return 1;
    }
    for (const char* id : {"standalone-rmlui-scaling", "integrated-rmlui-scaling"}) {
        Options scaling;
        scaling.scenario = id;
        scaling.ui_elements = 2048;
        scaling.ui_text_lines = 256;
        scaling.ui_visible_contexts = 8;
        scaling.ui_empty_contexts = 8;
        scaling.ui_hidden_contexts = 8;
        scaling.ui_text_mode = "dynamic";
        scaling.ui_redraw = "dirty-only";
        const auto encoded = nlohmann::json::parse(encode_configuration(scaling));
        Options decoded;
        if (!check(encoded["parameters"].size() == 7 && encoded["parameters"]["elements"] == 2048 &&
                       encoded["parameters"]["text_lines"] == 256 &&
                       encoded["parameters"]["visible_contexts"] == 8 &&
                       encoded["parameters"]["empty_contexts"] == 8 &&
                       encoded["parameters"]["hidden_contexts"] == 8 &&
                       encoded["parameters"]["text_mode"] == "dynamic" &&
                       encoded["parameters"]["redraw"] == "dirty-only" &&
                       decode_configuration(encoded.dump(), decoded, error) &&
                       nlohmann::json::parse(encode_configuration(decoded)) == encoded,
                   "scaling workload parameters roundtrip with strict identity"))
            return 1;
        auto unknown = encoded;
        unknown["parameters"]["stray"] = 1;
        auto negative = encoded;
        negative["parameters"]["elements"] = -1;
        auto too_many = encoded;
        too_many["parameters"]["hidden_contexts"] = 9;
        auto bad_text = encoded;
        bad_text["parameters"]["text_mode"] = "reactive";
        auto bad_redraw = encoded;
        bad_redraw["parameters"]["redraw"] = "skip";
        auto bad_type = encoded;
        bad_type["parameters"]["text_lines"] = "256";
        if (!check(rejected(unknown) && rejected(negative) && rejected(too_many) &&
                       rejected(bad_text) && rejected(bad_redraw) && rejected(bad_type),
                   "strict scaling schema rejects extra, malformed and out-of-bounds values"))
            return 1;
    }
    Options empty_engine_options;
    empty_engine_options.scenario = "engine-empty";
    const auto empty_engine_config =
        nlohmann::json::parse(encode_configuration(empty_engine_options));
    Options empty_engine_roundtrip;
    if (!check(
            empty_engine_config["parameters"].empty() &&
                decode_configuration(empty_engine_config.dump(), empty_engine_roundtrip, error) &&
                empty_engine_roundtrip.scenario == "engine-empty" &&
                nlohmann::json::parse(encode_configuration(empty_engine_roundtrip)) ==
                    empty_engine_config,
            "empty Engine has stable, parameter-free configuration"))
        return 1;
    for (const char* id : {"engine-compiled-empty", "engine-compiled-menu"}) {
        Options project;
        project.scenario = id;
        project.clock_policy = "fixed-step";
        const auto encoded = nlohmann::json::parse(encode_configuration(project));
        Options decoded;
        if (!check(encoded["clock_policy"] == "fixed-step" && encoded["parameters"].empty() &&
                       decode_configuration(encoded.dump(), decoded, error) &&
                       decoded.scenario == id && decoded.clock_policy == "fixed-step" &&
                       nlohmann::json::parse(encode_configuration(decoded)) == encoded,
                   "Compiled Project reference and fixed clock roundtrip"))
            return 1;
        auto wrong_parameters = encoded;
        wrong_parameters["parameters"]["unknown"] = 1;
        if (!check(rejected(wrong_parameters), "Compiled Project must reject extra parameters"))
            return 1;
    }
    Options feature_lab;
    feature_lab.scenario = "engine-feature-lab";
    feature_lab.feature_lab_package = "local/feature-lab.ntpkg";
    const auto feature_encoded = nlohmann::json::parse(encode_configuration(feature_lab));
    Options feature_decoded;
    if (!check(decode_configuration(feature_encoded.dump(), feature_decoded, error) &&
                   feature_decoded.scenario == "engine-feature-lab" &&
                   feature_decoded.feature_lab_package == feature_lab.feature_lab_package &&
                   nlohmann::json::parse(encode_configuration(feature_decoded)) == feature_encoded,
               "optional Feature Lab path roundtrips explicitly"))
        return 1;
    auto missing_package_field = feature_encoded;
    missing_package_field["parameters"] = nlohmann::json::object();
    auto bad_package_field = feature_encoded;
    bad_package_field["parameters"]["package_path"] = 5;
    auto mismatched_fixed = empty_engine_config;
    mismatched_fixed["clock_policy"] = "fixed-step";
    if (!check(rejected(missing_package_field) && rejected(bad_package_field) &&
                   rejected(mismatched_fixed),
               "strict feature parameters and engine clock compatibility"))
        return 1;
    auto invalid_engine_parameters = empty_engine_config;
    invalid_engine_parameters["parameters"]["project"] = "not-empty";
    auto invalid_ui_parameters = ui_config;
    invalid_ui_parameters["parameters"]["rect_count"] = 3;
    auto missing_geometry_count = geometry_config;
    missing_geometry_count["parameters"].erase("rect_count");
    auto extra_geometry_key = geometry_config;
    extra_geometry_key["parameters"]["unknown"] = true;
    auto invalid_geometry_count = geometry_config;
    invalid_geometry_count["parameters"]["rect_count"] = 0;
    auto invalid_geometry_scale = geometry_config;
    invalid_geometry_scale["parameters"]["rect_scale"] = 2.0;
    auto invalid_geometry_fraction = geometry_config;
    invalid_geometry_fraction["parameters"]["rect_count"] = 2.5;
    auto unknown_scenario = geometry_config;
    unknown_scenario["scenario"] = "unimplemented";
    auto bad_clock = configured;
    bad_clock["clock_policy"] = "fixed_step";
    auto missing = configured;
    missing["settings"].erase("no_ui");
    auto extra = configured;
    extra["settings"]["unknown"] = true;
    auto no_ui_false = configured;
    no_ui_false["settings"]["no_ui"] = false;
    auto negative_frames = configured;
    negative_frames["settings"]["measurement_frames"] = -1;
    auto wrong_profile = configured;
    wrong_profile["settings"]["profile"] = "unsupported";
    auto extra_root = configured;
    extra_root["unused"] = nullptr;
    if (!check(rejected(old_version) && rejected(wrong_scenario_version) &&
                   rejected(bad_parameters) && rejected(bad_clock) && rejected(missing) &&
                   rejected(extra) && rejected(negative_frames) && rejected(wrong_profile) &&
                   rejected(extra_root) && rejected(missing_geometry_count) &&
                   rejected(extra_geometry_key) && rejected(invalid_engine_parameters) &&
                   rejected(invalid_ui_parameters) && rejected(invalid_geometry_count) &&
                   rejected(invalid_geometry_scale) && rejected(invalid_geometry_fraction) &&
                   rejected(unknown_scenario),
               "reject unknown versions, settings, and invalid values"))
        return 1;
    auto diagnostic = configured;
    diagnostic["settings"]["profile"] = "diagnostic";
    diagnostic["settings"]["no_ui"] = false;
    Options interactive;
    if (!check(decode_configuration(diagnostic.dump(), interactive, error) && !interactive.no_ui &&
                   interactive.profile == "diagnostic" &&
                   nlohmann::json::parse(encode_configuration(interactive)) == diagnostic,
               "interactive diagnostic configuration roundtrip"))
        return 1;

    noveltea::benchmark::TrialResult trial;
    trial.outcome = "complete";
    trial.phases = {
        noveltea::benchmark::Phase::Preparation, noveltea::benchmark::Phase::Ready,
        noveltea::benchmark::Phase::Warmup,      noveltea::benchmark::Phase::Measurement,
        noveltea::benchmark::Phase::Completion,  noveltea::benchmark::Phase::Results,
        noveltea::benchmark::Phase::Cleanup};
    trial.measured_frames = 2;
    trial.measured_wall_seconds = 0.02;
    trial.cpu_operation.count = 2;
    trial.cpu_operation.mean_ms = 8.0;
    trial.raw_samples = {{0.01, 0.008}, {0.01, 0.008}};

    noveltea::benchmark::ScenarioResult scenario;
    scenario.scenario = "raw-bgfx-empty";
    scenario.description = "known reference";
    scenario.outcome = "complete";
    scenario.measured_frames = 2;
    scenario.measured_wall_seconds = 0.02;
    scenario.trials.push_back(trial);
    scenario.cpu_operation = trial.cpu_operation;
    noveltea::benchmark::SuiteResult suite;
    suite.outcome = "complete";
    suite.scenarios.push_back(scenario);
    const auto result = nlohmann::json::parse(encode_result(original,
                                                            {.platform = "Linux",
                                                             .video_driver = "x11",
                                                             .renderer = "OpenGL",
                                                             .frame_path = "bgfx-frame",
                                                             .gpu_vendor_id = 12,
                                                             .gpu_device_id = 34,
                                                             .width_pixels = 1280,
                                                             .height_pixels = 720},
                                                            suite));
    if (!check(result["format"] == "noveltea.benchmark.result" && result["version"] == 1 &&
                   result["configuration"] == configured &&
                   result["build"]["revision"].is_string() &&
                   (result["build"]["tracked_source_dirty"].is_boolean() ||
                    result["build"]["tracked_source_dirty"].is_null()) &&
                   result["build"]["source_fingerprint_sha256"].is_string() &&
                   result["configuration"]["clock_policy"] == "realtime" &&
                   result["configuration"]["parameters"].empty() &&
                   result["graphics"]["gpu_device_id"] == 34 &&
                   result["graphics"]["frame_path"] == "bgfx-frame" &&
                   result["graphics"]["gpu_driver_version"].is_null() &&
                   result["graphics"]["internal_render_scale"] == 1.0 &&
                   result["graphics"]["render_width_pixels"] == 1280 &&
                   result["graphics"]["render_height_pixels"] == 720 &&
                   result["timing"]["profile"] == "clean" &&
                   result["timing"]["gpu_execution_ms"].is_null() &&
                   result["timing"]["instrumentation_control"].is_null() &&
                   result["scenarios"][0]["trials"][0]["diagnostic"].is_null() &&
                   result["timing"]["presented_frame_count"].is_null() &&
                   result["scenarios"][0]["aggregate"]["frame_loop_cadence_hz"] == 100 &&
                   result["scenarios"][0]["trials"][0]["raw_samples"].size() == 2 &&
                   result["scenarios"][0]["trials"][0]["phases"].size() == 7,
               "result identity, timing, metadata and raw samples"))
        return 1;

    Options offscreen_options;
    offscreen_options.scenario = "raw-bgfx-offscreen";
    auto offscreen_work = noveltea::benchmark::raw_workload_reference(offscreen_options, 640, 360);
    noveltea::benchmark::Environment raw_offscreen_env;
    raw_offscreen_env.width_pixels = 640;
    raw_offscreen_env.height_pixels = 360;
    raw_offscreen_env.raw_workload = *offscreen_work;
    const auto offscreen_report =
        nlohmann::json::parse(encode_result(offscreen_options, raw_offscreen_env, suite));
    if (!check(
            offscreen_work &&
                offscreen_report["graphics"]["raw_workload"]["id"] == "raw-bgfx-offscreen" &&
                offscreen_report["graphics"]["raw_workload"]["render_views"] == 2 &&
                offscreen_report["graphics"]["raw_workload"]["draw_submissions_per_frame"] == 2 &&
                offscreen_report["graphics"]["raw_workload"]["vertices_submitted_per_frame"] == 8 &&
                offscreen_report["graphics"]["raw_workload"]["texture_and_target_bytes"] ==
                    256 * 256 * 4 + 640 * 360 * 4 &&
                offscreen_report["graphics"]["render_width_pixels"] == 640 &&
                result["graphics"]["raw_workload"].is_null(),
            "raw GPU operation counters and actual framebuffer dimensions appear in report"))
        return 1;

    Options msaa_options;
    msaa_options.scenario = "raw-bgfx-composition";
    msaa_options.composition_path = "offscreen";
    msaa_options.composite_passes = 1;
    msaa_options.msaa_samples = 4;
    auto msaa_reference = noveltea::benchmark::raw_workload_reference(msaa_options, 640, 360);
    noveltea::benchmark::Environment msaa_env;
    msaa_env.width_pixels = 640;
    msaa_env.height_pixels = 360;
    msaa_env.raw_workload = *msaa_reference;
    const auto msaa_report = nlohmann::json::parse(encode_result(msaa_options, msaa_env, suite));
    const auto& msaa_reported = msaa_report["graphics"]["raw_workload"];
    if (!check(
            msaa_reference && msaa_reported["requested_msaa_samples"] == 4 &&
                msaa_reported["msaa_samples"] == 4 &&
                msaa_reported["effective_msaa_samples"].is_null() &&
                msaa_reported["msaa_sample_count_verified"] == false &&
                msaa_reported["estimated_extra_msaa_bytes_basis"].get<std::string>().find(
                    "requested") != std::string::npos &&
                offscreen_report["graphics"]["raw_workload"]["effective_msaa_samples"] == 0 &&
                offscreen_report["graphics"]["raw_workload"]["msaa_sample_count_verified"] == true,
            "MSAA requests and nominal memory budgets are not misreported as effective GPU state"))
        return 1;

    noveltea::benchmark::Environment engine_env;
    engine_env.frame_path = "engine-tick";
    engine_env.engine_postprocess_active = false;
    const auto engine_result =
        nlohmann::json::parse(encode_result(empty_engine_options, engine_env, {}));
    if (!check(engine_result["graphics"]["frame_path"] == "engine-tick" &&
                   engine_result["graphics"]["engine_postprocess_surface_active"] == false &&
                   engine_result["configuration"]["parameters"].empty(),
               "empty Engine metadata differs from raw bgfx with observed renderer state"))
        return 1;
    // Even when the host passed as fallback is stale (e.g. Web's bgfx
    // dashboard), a one-scenario report must use the live Engine environment
    // for both top-level and per-scenario graphics.
    auto single_engine = suite;
    single_engine.scenarios.front().scenario = "integrated-rmlui-production";
    noveltea::benchmark::Environment stale_host;
    stale_host.frame_path = "bgfx-frame";
    stale_host.width_pixels = 1228;
    stale_host.height_pixels = 610;
    noveltea::benchmark::Environment measured_engine;
    measured_engine.frame_path = "engine-tick";
    measured_engine.width_pixels = 1280;
    measured_engine.height_pixels = 720;
    measured_engine.ui_backend =
        noveltea::benchmark::UiBackendSettings{.reference_msaa_samples = 2};
    const auto single_report = nlohmann::json::parse(
        encode_result(ui_options, stale_host, single_engine, {measured_engine}));
    if (!check(single_report["graphics"] == single_report["scenarios"][0]["graphics"] &&
                   single_report["graphics"]["frame_path"] == "engine-tick" &&
                   single_report["graphics"]["width_pixels"] == 1280 &&
                   single_report["graphics"]["ui_reference_msaa_samples"] == 2,
               "single Engine scenario metadata cannot inherit the old dashboard host"))
        return 1;

    // A mixed renderer suite must not claim all entries ran with one host.
    auto mixed = suite;
    mixed.scenarios.push_back(scenario);
    mixed.scenarios.back().scenario = "engine-empty";
    noveltea::benchmark::Environment raw_env;
    raw_env.frame_path = "bgfx-frame";
    raw_env.renderer = "OpenGL";
    const auto multi =
        nlohmann::json::parse(encode_result(original, raw_env, mixed, {raw_env, engine_env}));
    if (!check(multi["graphics"].is_null() &&
                   multi["scenarios"][0]["graphics"]["frame_path"] == "bgfx-frame" &&
                   multi["scenarios"][1]["graphics"]["frame_path"] == "engine-tick" &&
                   multi["scenarios"][0]["graphics"]["renderer"] == "OpenGL" &&
                   multi["scenarios"][1]["graphics"]["renderer"].is_null(),
               "mixed host suite preserves per-scenario graphics identity"))
        return 1;
    original.profile = "diagnostic";
    suite.instrumentation_control =
        noveltea::benchmark::InstrumentationControl{20000, 45.0, 65.0, 20.0};
    auto& diagnostic_metrics = suite.scenarios[0].trials[0].diagnostic;
    diagnostic_metrics.observations = 2;
    diagnostic_metrics.bgfx_stats_observations = 2;
    diagnostic_metrics.cpu_submission_ms = trial.cpu_operation;
    diagnostic_metrics.bgfx_wait_render_ms = trial.cpu_operation;
    diagnostic_metrics.draw_calls = {2, 1.0, 1, 1};
    const auto diagnostic_result = nlohmann::json::parse(encode_result(original, {}, suite));
    const auto& diagnostic_trial = diagnostic_result["scenarios"][0]["trials"][0]["diagnostic"];
    if (!check(diagnostic_result["timing"]["profile"] == "diagnostic" &&
                   diagnostic_result["configuration"]["settings"]["profile"] == "diagnostic" &&
                   diagnostic_result["timing"]["gpu_execution_ms"].is_null() &&
                   diagnostic_result["timing"]["bgfx_wait_render_ms"].is_null() &&
                   diagnostic_result["timing"]["instrumentation_control"]["incremental_ns"] ==
                       20.0 &&
                   diagnostic_trial["cpu_submission_ms"]["mean_ms"] == 8.0 &&
                   diagnostic_trial["bgfx_wait_render_ms"]["mean_ms"] == 8.0 &&
                   diagnostic_trial["gpu_execution_ms"].is_null() &&
                   diagnostic_trial["draw_calls"]["mean"] == 1.0 &&
                   diagnostic_trial["stats_scope"].is_string(),
               "diagnostic report preserves separate scopes and honest absent GPU timing"))
        return 1;
    original.raw_samples = false;
    suite.scenarios[0].trials[0].outcome = "failed";
    suite.scenarios[0].trials[0].reason =
        "presentation interrupted; cleanup failed: host shutdown failed";
    suite.scenarios[0].trials[0].measured_frames = 1;
    suite.scenarios[0].trials[0].measured_wall_seconds = 0.01;
    const auto failed = nlohmann::json::parse(encode_result(original, {}, suite));
    if (!check(failed["scenarios"][0]["trials"][0]["reason"] ==
                       "presentation interrupted; cleanup failed: host shutdown failed" &&
                   failed["scenarios"][0]["trials"][0]["raw_samples"].is_null() &&
                   failed["scenarios"][0]["trials"][0]["measured_frames"] == 1 &&
                   failed["scenarios"][0]["trials"][0]["frame_wall_ms"].is_null() &&
                   failed["graphics"]["gpu_device_id"].is_null() &&
                   failed["graphics"]["render_width_pixels"].is_null() &&
                   failed["graphics"]["internal_render_scale"].is_null(),
               "failed trial and missing graphics are not fabricated"))
        return 1;
    return 0;
}
