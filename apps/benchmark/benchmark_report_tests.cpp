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
                   result["timing"]["presented_frame_count"].is_null() &&
                   result["scenarios"][0]["aggregate"]["frame_loop_cadence_hz"] == 100 &&
                   result["scenarios"][0]["trials"][0]["raw_samples"].size() == 2 &&
                   result["scenarios"][0]["trials"][0]["phases"].size() == 7,
               "result identity, timing, metadata and raw samples"))
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
    original.profile = "diagnostic";
    const auto diagnostic_result = nlohmann::json::parse(encode_result(original, {}, suite));
    if (!check(diagnostic_result["timing"]["profile"] == "diagnostic" &&
                   diagnostic_result["configuration"]["settings"]["profile"] == "diagnostic" &&
                   diagnostic_result["timing"]["gpu_execution_ms"].is_null() &&
                   diagnostic_result["timing"]["bgfx_wait_render_ms"].is_null(),
               "diagnostic profile does not fabricate GPU statistics"))
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
