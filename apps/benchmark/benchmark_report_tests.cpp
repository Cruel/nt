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
    noveltea::benchmark::Environment shared_environment;
    shared_environment.platform = "Linux";
    shared_environment.renderer = "OpenGL";
    shared_environment.width_pixels = 1600;
    shared_environment.height_pixels = 900;
    shared_environment.ui_backend.emplace();
    shared_environment.raw_workload.emplace();
    shared_environment.ui_effect_activity = noveltea::UiEffectActivity{.clipping_calls = 8};
    shared_environment.clear_scenario_metadata();
    if (!check(
            !shared_environment.ui_backend && !shared_environment.raw_workload &&
                !shared_environment.ui_effect_activity && shared_environment.platform == "Linux" &&
                shared_environment.renderer == "OpenGL" &&
                shared_environment.width_pixels == 1600 && shared_environment.height_pixels == 900,
            "scenario switch clears previous workload metadata but preserves device details"))
        return 1;

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

    Options cpu;
    cpu.scenario = "cpu-runtime-session";
    cpu.cpu_work_units = 32;
    cpu.profile = "diagnostic";
    const auto cpu_config = nlohmann::json::parse(encode_configuration(cpu));
    Options cpu_roundtrip;
    if (!check(decode_configuration(cpu_config.dump(), cpu_roundtrip, error) &&
                   cpu_roundtrip.scenario == cpu.scenario && cpu_roundtrip.cpu_work_units == 32 &&
                   cpu_roundtrip.profile == "diagnostic" &&
                   nlohmann::json::parse(encode_configuration(cpu_roundtrip)) == cpu_config,
               "CPU workload configuration encodes stable project identity and batch size"))
        return 1;
    auto cpu_zero = cpu_config;
    cpu_zero["parameters"]["work_units"] = 0;
    auto cpu_excess = cpu_config;
    cpu_excess["parameters"]["work_units"] = 4097;
    auto cpu_mismatched_input = cpu_config;
    cpu_mismatched_input["parameters"]["input"] = "unknown.json";
    auto cpu_missing_input = cpu_config;
    cpu_missing_input["parameters"].erase("input");
    auto cpu_ui = cpu_config;
    cpu_ui["settings"]["no_ui"] = false;
    auto cpu_vsync = cpu_config;
    cpu_vsync["settings"]["vsync"] = true;
    if (!check(rejected(cpu_zero) && rejected(cpu_excess) && rejected(cpu_mismatched_input) &&
                   rejected(cpu_missing_input) && rejected(cpu_ui) && rejected(cpu_vsync),
               "CPU configurations reject out-of-bounds, changed fixture and graphics settings"))
        return 1;

    for (const char* id : {"asset-source-read", "asset-project-prepare", "asset-texture-realize"}) {
        Options asset;
        asset.scenario = id;
        asset.asset_cache = "cold";
        asset.cpu_work_units = 4;
        asset.profile = "diagnostic";
        auto encoded = nlohmann::json::parse(encode_configuration(asset));
        Options restored;
        if (!check(decode_configuration(encoded.dump(), restored, error) &&
                       restored.scenario == asset.scenario && restored.asset_cache == "cold" &&
                       restored.cpu_work_units == 4 &&
                       nlohmann::json::parse(encode_configuration(restored)) == encoded,
                   "asset workload roundtrip retains exact reference and cache identity"))
            return 1;
        auto invalid_cache = encoded;
        invalid_cache["parameters"]["cache"] = "physical-disk-cold";
        auto invalid_input = encoded;
        invalid_input["parameters"]["input"] = "other.png";
        auto invalid_count = encoded;
        invalid_count["parameters"]["work_units"] = 65;
        auto missing_cache = encoded;
        missing_cache["parameters"].erase("cache");
        auto invalid_ui = encoded;
        invalid_ui["settings"]["no_ui"] = false;
        if (!check(rejected(invalid_cache) && rejected(invalid_input) && rejected(invalid_count) &&
                       rejected(missing_cache) && rejected(invalid_ui),
                   "asset workload rejects incompatible cache, source, units and UI mode"))
            return 1;
        noveltea::benchmark::SuiteResult suite;
        noveltea::benchmark::ScenarioResult scenario;
        scenario.scenario = id;
        scenario.outcome = "complete";
        scenario.measured_frames = 4;
        scenario.measured_wall_seconds = 0.1;
        noveltea::benchmark::TrialResult trial;
        trial.outcome = "complete";
        trial.measured_frames = 4;
        trial.measured_wall_seconds = 0.1;
        scenario.trials.push_back(trial);
        suite.scenarios.push_back(scenario);
        suite.outcome = "complete";
        auto result = nlohmann::json::parse(encode_result(asset, shared_environment, suite));
        if (!check(
                result["scenarios"][0]["aggregate"]["frame_loop_cadence_hz"].is_null() &&
                    result["scenarios"][0]["aggregate"].contains("asset_work_batches_per_second") &&
                    result["graphics"]["asset_workload"]["manager_cache"] == "cold" &&
                    result["graphics"]["asset_workload"]["os_page_cache"] == "uncontrolled" &&
                    result["timing"]["gpu_execution_ms"].is_null() &&
                    result["timing"]["frame_wall"].get<std::string>().find(
                        "end-to-end CPU interval between completed work batches") !=
                        std::string::npos,
                "asset reports have workload throughput and explicit cache/GPU limitations"))
            return 1;
    }

    for (const char* mode : {"video-decode", "video-upload", "video-present"}) {
        Options video;
        video.scenario = mode;
        const auto encoded = nlohmann::json::parse(encode_configuration(video));
        Options restored;
        if (!check(encoded["scenario_version"] == 1 &&
                       encoded["parameters"]["codec"] == "vp9-profile0-webm" &&
                       decode_configuration(encoded.dump(), restored, error) &&
                       restored.scenario == mode &&
                       nlohmann::json::parse(encode_configuration(restored)) == encoded,
                   "video modes retain their exact production prepared-media identity"))
            return 1;
        auto replaced = encoded;
        replaced["parameters"]["frame_durations_ms"] = {25, 25, 25, 25};
        auto missing = encoded;
        missing["parameters"].erase("source");
        auto wrong_codec = encoded;
        wrong_codec["parameters"]["codec"] = "h264";
        auto ui = encoded;
        ui["settings"]["no_ui"] = false;
        Options dashboard_video;
        if (!check(rejected(replaced) && rejected(missing) && rejected(wrong_codec) &&
                       decode_configuration(ui.dump(), dashboard_video, error) &&
                       !dashboard_video.no_ui && dashboard_video.scenario == mode,
                   "video configuration rejects changed media but supports dashboard mode"))
            return 1;
    }

    Options native;
    native.scenario = "native-2d-geometry";
    native.native_quads = 128;
    native.native_texture_size = 256;
    const auto native_config = nlohmann::json::parse(encode_configuration(native));
    Options native_roundtrip;
    if (!check(decode_configuration(native_config.dump(), native_roundtrip, error) &&
                   native_roundtrip.native_quads == 128 &&
                   native_roundtrip.native_texture_size == 256 &&
                   native_roundtrip.native_glyphs == 256 &&
                   nlohmann::json::parse(encode_configuration(native_roundtrip)) == native_config,
               "native 2D workload has stable geometry, glyph, texture and font identity"))
        return 1;
    auto native_bad = native_config;
    native_bad["parameters"]["font_size_px"] = 24;
    if (!check(rejected(native_bad), "native 2D does not accept a changed font scale"))
        return 1;
    native_bad = native_config;
    native_bad["parameters"]["texture_edge"] = 73;
    if (!check(rejected(native_bad), "native 2D disallows non-power-of-two texture scale"))
        return 1;
    native_bad = native_config;
    native_bad["parameters"]["reference"] = "unknown";
    if (!check(rejected(native_bad), "native 2D rejects changed scene identity"))
        return 1;
    native_bad = native_config;
    native_bad["parameters"]["geometry_quads"] = 2049;
    if (!check(rejected(native_bad), "native 2D rejects excessive geometry"))
        return 1;
    native.scenario = "native-2d-text-dynamic";
    native.native_quads = 64;
    native.native_texture_size = 0;
    native.native_glyphs = 512;
    Options text_roundtrip;
    if (!check(decode_configuration(encode_configuration(native), text_roundtrip, error) &&
                   text_roundtrip.native_glyphs == 512 &&
                   text_roundtrip.scenario == native.scenario,
               "native 2D dynamic text accepts independently scaled glyph count"))
        return 1;
    Options shader;
    shader.scenario = "native-postprocess";
    shader.native_quads = 96;
    shader.native_texture_size = 128;
    shader.composition_path = "offscreen";
    shader.composite_passes = 3;
    shader.shader_tint = 0.8;
    shader.shader_scope = "full-game-viewport";
    auto shader_config = nlohmann::json::parse(encode_configuration(shader));
    Options shader_roundtrip;
    if (!check(decode_configuration(shader_config.dump(), shader_roundtrip, error) &&
                   shader_roundtrip.native_quads == 96 &&
                   shader_roundtrip.native_texture_size == 128 &&
                   shader_roundtrip.composite_passes == 3 && shader_roundtrip.shader_tint == 0.8 &&
                   shader_roundtrip.shader_scope == "full-game-viewport" &&
                   nlohmann::json::parse(encode_configuration(shader_roundtrip)) == shader_config,
               "native postprocess configuration roundtrip retains independent scene and passes"))
        return 1;
    shader_config["parameters"]["passes"] = 5;
    if (!check(rejected(shader_config), "postprocess rejects more than four passes"))
        return 1;
    shader_config["parameters"]["passes"] = 3;
    shader_config["parameters"]["reference"] = "changed";
    if (!check(rejected(shader_config), "postprocess rejects changed visual fixture identity"))
        return 1;
    shader_config["parameters"]["reference"] = "native-shader-grid-tint-v1";
    shader_config["parameters"]["composition_path"] = "direct";
    if (!check(rejected(shader_config), "direct postprocess cannot silently retain effects"))
        return 1;
    shader.scenario = "native-shader-material";
    shader.composition_path = "direct";
    shader.composite_passes = 0;
    shader.shader_tint = 1.0;
    shader.shader_scope = "world";
    if (!check(decode_configuration(encode_configuration(shader), shader_roundtrip, error),
               "native shader material accepts fixed production shader reference"))
        return 1;

    auto missing_alternate = configured;
    missing_alternate.erase("alternate");
    if (!check(configured["alternate"].is_null() && rejected(missing_alternate),
               "configuration V1 requires the current-only A/B/A field"))
        return 1;
    Options paired = original;
    paired.scenario = "raw-bgfx-geometry";
    paired.alternate = std::make_shared<Options>(paired);
    paired.alternate->rect_count = 7;
    const auto paired_config = nlohmann::json::parse(encode_configuration(paired));
    Options parsed_pair;
    if (!check(decode_configuration(paired_config.dump(), parsed_pair, error) &&
                   parsed_pair.alternate && parsed_pair.alternate->rect_count == 7 &&
                   nlohmann::json::parse(encode_configuration(parsed_pair)) == paired_config,
               "candidate B is a complete current V1 configuration and roundtrips"))
        return 1;
    auto nested_pair = paired_config;
    nested_pair["alternate"]["alternate"] = paired_config;
    auto incompatible_pair = paired_config;
    incompatible_pair["alternate"]["settings"]["vsync"] = true;
    auto different_scenario = paired_config;
    different_scenario["alternate"]["scenario"] = "raw-bgfx-empty";
    if (!check(rejected(nested_pair) && rejected(incompatible_pair) && rejected(different_scenario),
               "A/B/A rejects nesting and incomparable graphics/scenario settings"))
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
        scaling.ui_dynamic_lines = 256;
        scaling.ui_visible_contexts = 8;
        scaling.ui_empty_contexts = 8;
        scaling.ui_hidden_contexts = 8;
        scaling.ui_text_mode = "dynamic";
        scaling.ui_redraw = "dirty-only";
        const auto encoded = nlohmann::json::parse(encode_configuration(scaling));
        Options decoded;
        if (!check(encoded["scenario_version"] == 1 && encoded["parameters"].size() == 8 &&
                       encoded["parameters"]["elements"] == 2048 &&
                       encoded["parameters"]["text_lines"] == 256 &&
                       encoded["parameters"]["dynamic_lines"] == 256 &&
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
        auto replaced_shape = encoded;
        replaced_shape["parameters"].erase("dynamic_lines");
        auto prohibited_version = encoded;
        prohibited_version["scenario_version"] = 2;
        if (!check(rejected(replaced_shape) && rejected(prohibited_version),
                   "development scaling configurations reject replaced V1 shapes and V2 versions"))
            return 1;
        auto illegal_version = encoded;
        illegal_version["scenario_version"] = 3;
        auto excessive_dynamic = encoded;
        excessive_dynamic["parameters"]["dynamic_lines"] = 257;
        auto beyond_text = encoded;
        beyond_text["parameters"]["text_lines"] = 8;
        if (!check(rejected(unknown) && rejected(negative) && rejected(too_many) &&
                       rejected(bad_text) && rejected(bad_redraw) && rejected(bad_type) &&
                       rejected(illegal_version) && rejected(excessive_dynamic) &&
                       rejected(beyond_text),
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
    trial.cpu_operation.min_ms = 8.0;
    trial.cpu_operation.max_ms = 8.0;
    trial.cpu_operation.p50_ms = 8.0;
    trial.cpu_operation.p95_ms = 8.0;
    trial.cpu_operation.p99_ms = 8.0;
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

    noveltea::benchmark::Environment cpu_environment;
    cpu_environment.platform = "Linux";
    cpu_environment.frame_path = "cpu-work-batch-no-presentation";
    auto cpu_suite = suite;
    cpu_suite.scenarios[0].scenario = cpu.scenario;
    const auto cpu_result = nlohmann::json::parse(encode_result(cpu, cpu_environment, cpu_suite));
    if (!check(cpu_result["graphics"]["renderer"].is_null() &&
                   cpu_result["graphics"]["gpu_device_id"].is_null() &&
                   cpu_result["graphics"]["frame_path"] == "cpu-work-batch-no-presentation" &&
                   cpu_result["timing"]["frame_wall"].get<std::string>().find(
                       "end-to-end CPU interval between completed work batches") !=
                       std::string::npos &&
                   cpu_result["timing"]["gpu_execution_ms"].is_null() &&
                   cpu_result["scenarios"][0]["aggregate"]["frame_loop_cadence_hz"].is_null() &&
                   cpu_result["scenarios"][0]["aggregate"]["cpu_work_batches_per_second"] == 100 &&
                   cpu_result["scenarios"][0]["trials"][0]["frame_loop_cadence_hz"].is_null() &&
                   cpu_result["scenarios"][0]["trials"][0]["cpu_work_batches_per_second"] == 100,
               "headless CPU results report batches per second and no graphics FPS or GPU time"))
        return 1;

    Options decode_options;
    decode_options.scenario = "video-decode";
    auto video_suite = suite;
    video_suite.scenarios[0].scenario = decode_options.scenario;
    noveltea::benchmark::Environment video_environment;
    video_environment.video_codec_backend = "libvpx-vp9";
    video_environment.video_codec_fallback = "no compatible hardware";
    const auto decode_report =
        nlohmann::json::parse(encode_result(decode_options, video_environment, video_suite));
    if (!check(
            decode_report["graphics"]["video_hardware_decode_confirmed"] == false &&
                decode_report["graphics"]["video_decode_backend"] == "libvpx-vp9" &&
                decode_report["graphics"]["video_decode_fallback"] == "no compatible hardware" &&
                decode_report["timing"]["frame_wall"].get<std::string>().find(
                    "active CPU decoder operation interval") != std::string::npos &&
                decode_report["scenarios"][0]["aggregate"]["frame_loop_cadence_hz"].is_null() &&
                decode_report["scenarios"][0]["aggregate"]["video_decode_work_units_per_second"] ==
                    100 &&
                decode_report["scenarios"][0]["trials"][0]["video_decode_work_units_per_second"] ==
                    100,
            "decoder-only VP9 rate is CPU throughput, and software fallback is explicit"))
        return 1;
    video_environment.video_codec_backend = "nvdec-vp9";
    const auto hardware_report =
        nlohmann::json::parse(encode_result(decode_options, video_environment, video_suite));
    video_environment.video_codec_backend = "browser-media-gpu";
    const auto browser_report =
        nlohmann::json::parse(encode_result(decode_options, video_environment, video_suite));
    if (!check(hardware_report["graphics"]["video_hardware_decode_confirmed"] == true &&
                   browser_report["graphics"]["video_hardware_decode_confirmed"].is_null(),
               "hardware backend is observed, browser-decoder acceleration remains unknown"))
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
    diagnostic_metrics.engine_update_ms = trial.cpu_operation;
    diagnostic_metrics.engine_layout_ms = trial.cpu_operation;
    diagnostic_metrics.engine_runtime_ms = trial.cpu_operation;
    diagnostic_metrics.rmlui_update_ms = trial.cpu_operation;
    diagnostic_metrics.rmlui_render_ms = trial.cpu_operation;
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
                   diagnostic_trial["engine_layout_ms"]["mean_ms"] == 8.0 &&
                   diagnostic_trial["engine_update_ms"]["p50_ms"] == 8.0 &&
                   diagnostic_trial["engine_runtime_ms"]["samples"] == 2 &&
                   diagnostic_trial["rmlui_update_ms"]["p95_ms"] == 8.0 &&
                   diagnostic_trial["rmlui_render_ms"]["mean_ms"] == 8.0 &&
                   diagnostic_trial["engine_scope"].is_string() &&
                   diagnostic_trial["stage_additivity"].is_string() &&
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
