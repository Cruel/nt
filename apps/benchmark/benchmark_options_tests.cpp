#include "benchmark_options.hpp"

#include <cstdio>
#include <string>

namespace {

bool expect_options(const char* const args[], int count, bool success, uint64_t expected_frames = 0)
{
    noveltea::benchmark::Options options;
    std::string error;
    const bool parsed = noveltea::benchmark::parse_options(count, args, options, error);
    if (parsed != success || (success && options.measurement_frames != expected_frames)) {
        std::fprintf(stderr, "unexpected parse outcome: %s\n", error.c_str());
        return false;
    }
    return true;
}

} // namespace

int main()
{
    const char* const defaults[] = {"benchmark"};
    const char* const fixed[] = {"benchmark", "--frames", "50",         "--seconds",
                                 "2",         "--output", "report.json"};
    const char* const smoke[] = {"benchmark", "--smoke"};
    const char* const invalid_frames[] = {"benchmark", "--frames", "0"};
    const char* const invalid_float[] = {"benchmark", "--seconds", "nan"};
    const char* const invalid_width[] = {"benchmark", "--width", "9000"};
    const char* const invalid_missing[] = {"benchmark", "--output"};
    const char* const invalid_unknown[] = {"benchmark", "--bogus"};
    const char* const repeats[] = {"benchmark", "--repeats", "3", "--ready-timeout-seconds", "1"};
    const char* const invalid_repeats[] = {"benchmark", "--repeats", "21"};
    const char* const invalid_large_frames[] = {"benchmark", "--frames", "300001"};
    const char* const diagnostic[] = {"benchmark", "--profile", "diagnostic"};
    const char* const invalid_profile[] = {"benchmark", "--profile", "unknown"};
    const char* const ui[] = {"benchmark", "--ui", "--frames", "30"};
    const char* const geometry[] = {"benchmark",    "--scenario", "raw-bgfx-geometry",
                                    "--rect-count", "12",         "--rect-scale",
                                    "0.75"};
    const char* const ui_reference[] = {"benchmark", "--scenario", "standalone-rmlui-simple"};
    const char* const ui_scaling[] = {"benchmark",
                                      "--scenario",
                                      "standalone-rmlui-scaling",
                                      "--ui-elements",
                                      "2048",
                                      "--ui-text-lines",
                                      "256",
                                      "--ui-visible-contexts",
                                      "8",
                                      "--ui-empty-contexts",
                                      "8",
                                      "--ui-hidden-contexts",
                                      "8",
                                      "--ui-text-mode",
                                      "dynamic",
                                      "--ui-redraw",
                                      "dirty-only"};
    const char* const ui_named_preset[] = {
        "benchmark",     "--scenario", "standalone-rmlui-scaling", "--ui-preset", "contexts-heavy",
        "--ui-elements", "128"};
    const char* const ui_preset_last[] = {
        "benchmark",   "--ui-elements", "128", "--scenario", "integrated-rmlui-scaling",
        "--ui-preset", "contexts-heavy"};
    const char* const ui_bad_preset[] = {"benchmark", "--ui-preset", "unknown"};
    const char* const ui_wrong_preset[] = {"benchmark", "--scenario", "raw-bgfx-empty",
                                           "--ui-preset", "balanced"};
    const char* const ui_bad_mode[] = {"benchmark", "--ui-text-mode", "unknown"};
    const char* const ui_bad_redraw[] = {"benchmark", "--ui-redraw", "once"};
    const char* const ui_bad_count[] = {"benchmark", "--ui-elements", "2049"};
    const char* const ui_dynamic_custom[] = {"benchmark",
                                             "--scenario",
                                             "standalone-rmlui-scaling",
                                             "--ui-text-mode",
                                             "dynamic",
                                             "--ui-text-lines",
                                             "8",
                                             "--ui-dynamic-lines",
                                             "8"};
    const char* const ui_dynamic_overflow[] = {
        "benchmark", "--scenario", "integrated-rmlui-scaling", "--ui-dynamic-lines", "257"};
    const char* const ui_dynamic_too_many[] = {"benchmark",
                                               "--scenario",
                                               "standalone-rmlui-scaling",
                                               "--ui-text-mode",
                                               "dynamic",
                                               "--ui-text-lines",
                                               "8",
                                               "--ui-dynamic-lines",
                                               "9"};
    const char* const raw_scaled[] = {
        "benchmark",    "--scenario", "raw-bgfx-draw-calls", "--draw-calls", "7",
        "--quad-count", "9",          "--texture-size",      "64",           "--coverage",
        "0.375"};
    const char* const composed[] = {"benchmark",
                                    "--scenario",
                                    "raw-bgfx-composition",
                                    "--composition-path",
                                    "offscreen",
                                    "--composite-passes",
                                    "3",
                                    "--target-scale",
                                    "0.5",
                                    "--msaa-samples",
                                    "2",
                                    "--no-transparent-overlay"};
    const char* const bad_composites[] = {"benchmark", "--composite-passes", "5"};
    const char* const bad_msaa[] = {"benchmark", "--msaa-samples", "3"};
    const char* const bad_target[] = {"benchmark", "--target-scale", "0.1"};
    const char* const bad_draws[] = {"benchmark", "--draw-calls", "1025"};
    const char* const bad_quads[] = {"benchmark", "--quad-count", "513"};
    const char* const bad_texture[] = {"benchmark", "--texture-size", "63"};
    const char* const bad_coverage[] = {"benchmark", "--coverage", "nan"};
    const char* const invalid_geometry[] = {"benchmark", "--rect-count", "257"};
    const char* const invalid_scale[] = {"benchmark", "--rect-scale", "0.1"};
    const char* const lifecycle[] = {"benchmark", "--dashboard-smoke"};
    const char* const quick[] = {"benchmark", "--quick-suite", "--smoke"};
    const char* const config_only[] = {"benchmark", "--config", "run.json", "--output",
                                       "other.json"};
    const char* const mixed_config[] = {"benchmark", "--config", "run.json", "--smoke"};

    if (!expect_options(defaults, 1, true) || !expect_options(fixed, 7, true, 50) ||
        !expect_options(smoke, 2, true, 30) || !expect_options(invalid_frames, 3, false) ||
        !expect_options(invalid_float, 3, false) || !expect_options(invalid_width, 3, false) ||
        !expect_options(invalid_missing, 2, false) || !expect_options(invalid_unknown, 2, false) ||
        !expect_options(repeats, 5, true) || !expect_options(invalid_repeats, 3, false) ||
        !expect_options(invalid_large_frames, 3, false) || !expect_options(diagnostic, 3, true) ||
        !expect_options(ui, 4, true, 30) || !expect_options(lifecycle, 2, true, 30) ||
        !expect_options(quick, 3, true, 30) || !expect_options(invalid_profile, 3, false) ||
        !expect_options(geometry, 7, true) || !expect_options(ui_reference, 3, true) ||
        !expect_options(invalid_geometry, 3, false) || !expect_options(invalid_scale, 3, false) ||
        !expect_options(ui_scaling, 17, true) || !expect_options(ui_named_preset, 7, true) ||
        !expect_options(ui_preset_last, 7, true) || !expect_options(ui_bad_preset, 3, false) ||
        !expect_options(ui_wrong_preset, 5, false) || !expect_options(ui_bad_mode, 3, false) ||
        !expect_options(ui_bad_redraw, 3, false) || !expect_options(ui_bad_count, 3, false) ||
        !expect_options(ui_dynamic_custom, 9, true) || !expect_options(raw_scaled, 11, true) ||
        !expect_options(composed, 12, true) || !expect_options(bad_composites, 3, false) ||
        !expect_options(bad_msaa, 3, false) || !expect_options(bad_target, 3, false) ||
        !expect_options(bad_draws, 3, false) || !expect_options(bad_quads, 3, false) ||
        !expect_options(bad_texture, 3, false) || !expect_options(bad_coverage, 3, false) ||
        !expect_options(config_only, 5, true) || !expect_options(mixed_config, 4, false))
        return 1;

    noveltea::benchmark::Options options;
    std::string error;
    if (!noveltea::benchmark::parse_options(1, defaults, options, error) || options.no_ui ||
        !noveltea::benchmark::parse_options(2, smoke, options, error) || !options.no_ui ||
        !noveltea::benchmark::parse_options(3, diagnostic, options, error) ||
        options.profile != "diagnostic" ||
        !noveltea::benchmark::parse_options(2, lifecycle, options, error) ||
        !options.dashboard_smoke || options.no_ui)
        return 1;
    if (!noveltea::benchmark::parse_options(3, quick, options, error) || !options.quick_suite ||
        !options.no_ui)
        return 1;
    if (!noveltea::benchmark::parse_options(7, geometry, options, error) ||
        options.scenario != "raw-bgfx-geometry" || options.rect_count != 12 ||
        options.rect_scale != 0.75 ||
        !noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.scenario = "raw-bgfx-empty";
    if (noveltea::benchmark::validate_reference_options(options, error) || error.empty())
        return 1;
    options.scenario = "standalone-rmlui-simple";
    options.rect_count = 3;
    options.rect_scale = 1.0;
    if (!noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.rect_count = 4;
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.rect_count = 3;
    options.scenario = "integrated-rmlui-controlled";
    if (!noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.scenario = "integrated-rmlui-production";
    if (!noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.scenario = "engine-empty";
    if (!noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.msaa_samples = 2;
    if (noveltea::benchmark::validate_reference_options(options, error) ||
        error != "composition settings require raw-bgfx-composition")
        return 1;
    options.msaa_samples = 0;
    options.scenario = "synthetic";
    if (noveltea::benchmark::validate_reference_options(options, error) || error.empty())
        return 1;
    if (!noveltea::benchmark::parse_options(11, raw_scaled, options, error) ||
        options.scenario != "raw-bgfx-draw-calls" || options.draw_calls != 7 ||
        options.quad_count != 9 || options.texture_size != 64 || options.coverage != 0.375 ||
        !noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.scenario = "raw-bgfx-clear";
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    if (!noveltea::benchmark::parse_options(12, composed, options, error) ||
        options.composition_path != "offscreen" || options.composite_passes != 3 ||
        options.target_scale != 0.5 || options.msaa_samples != 2 || options.transparent_overlay ||
        !noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.composition_path = "direct";
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    if (!noveltea::benchmark::parse_options(7, ui_named_preset, options, error) ||
        options.ui_elements != 128 || options.ui_visible_contexts != 4 ||
        options.ui_empty_contexts != 8 || options.ui_hidden_contexts != 8 ||
        !noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    if (!noveltea::benchmark::parse_options(7, ui_preset_last, options, error) ||
        options.ui_elements != 128 || options.ui_visible_contexts != 4 ||
        options.ui_empty_contexts != 8 || options.ui_hidden_contexts != 8 ||
        !noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    for (const char* preset :
         {"balanced", "elements-heavy", "text-heavy", "contexts-heavy", "dirty-static"}) {
        options.scenario = "integrated-rmlui-scaling";
        if (!noveltea::benchmark::apply_ui_scaling_preset(options, preset) ||
            (std::string(preset) == "text-heavy" &&
             (options.ui_dynamic_lines != 256 || options.ui_text_lines != 256)) ||
            !noveltea::benchmark::validate_reference_options(options, error))
            return 1;
    }
    if (noveltea::benchmark::apply_ui_scaling_preset(options, "unknown"))
        return 1;
    if (!noveltea::benchmark::parse_options(17, ui_scaling, options, error) ||
        !noveltea::benchmark::validate_reference_options(options, error) ||
        options.ui_elements != 2048 || options.ui_text_lines != 256 ||
        options.ui_visible_contexts != 8 || options.ui_empty_contexts != 8 ||
        options.ui_hidden_contexts != 8 || options.ui_text_mode != "dynamic" ||
        options.ui_redraw != "dirty-only")
        return 1;
    if (!noveltea::benchmark::parse_options(5, ui_dynamic_overflow, options, error))
        return 1;
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    if (!noveltea::benchmark::parse_options(9, ui_dynamic_custom, options, error) ||
        options.ui_dynamic_lines != 8 ||
        !noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    if (!noveltea::benchmark::parse_options(9, ui_dynamic_too_many, options, error))
        return 1;
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    if (!noveltea::benchmark::parse_options(17, ui_scaling, options, error))
        return 1;
    options.scenario = "integrated-rmlui-scaling";
    if (options.ui_dynamic_lines != 1 ||
        !noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.ui_empty_contexts = 16;
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    const auto reset_ui =
        noveltea::benchmark::reference_scenario_options(options, "standalone-rmlui-scaling");
    if (reset_ui.ui_elements != 512 || reset_ui.ui_text_lines != 64 ||
        reset_ui.ui_dynamic_lines != 1 || reset_ui.ui_visible_contexts != 1 ||
        reset_ui.ui_empty_contexts != 0 || reset_ui.ui_hidden_contexts != 0 ||
        reset_ui.ui_text_mode != "static" || reset_ui.ui_redraw != "continuous" ||
        !noveltea::benchmark::validate_reference_options(reset_ui, error))
        return 1;
    const char* const effects_cli[] = {"benchmark",
                                       "--scenario",
                                       "standalone-rmlui-effects",
                                       "--ui-clipping",
                                       "0",
                                       "--ui-transforms",
                                       "2",
                                       "--ui-gradients",
                                       "3",
                                       "--ui-filters",
                                       "1",
                                       "--ui-masks",
                                       "1",
                                       "--ui-nested-layers",
                                       "2"};
    if (!noveltea::benchmark::parse_options(15, effects_cli, options, error) ||
        !noveltea::benchmark::validate_reference_options(options, error) ||
        options.ui_clipping != 0 || options.ui_transforms != 2 || options.ui_gradients != 3 ||
        options.ui_filters != 1 || options.ui_masks != 1 || options.ui_nested_layers != 2)
        return 1;
    options.scenario = "integrated-rmlui-effects";
    if (!noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.ui_filters = 17;
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.ui_filters = 0;
    options.ui_transforms = options.ui_gradients = options.ui_masks = options.ui_nested_layers = 0;
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    const auto restored =
        noveltea::benchmark::reference_scenario_options(options, "standalone-rmlui-effects");
    if (restored.ui_clipping != 2 || restored.ui_transforms != 2 || restored.ui_gradients != 2 ||
        restored.ui_filters != 2 || restored.ui_masks != 2 || restored.ui_nested_layers != 2 ||
        !noveltea::benchmark::validate_reference_options(restored, error))
        return 1;
    options = reset_ui;
    options.scenario = "raw-bgfx-empty";
    options.ui_elements = 513;
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    const char* const project_cli[] = {"benchmark", "--scenario", "engine-compiled-empty",
                                       "--clock-policy", "fixed-step"};
    const char* const feature_cli[] = {"benchmark", "--scenario", "engine-feature-lab",
                                       "--feature-lab-package", "lab.ntpkg"};
    const char* const invalid_clock[] = {"benchmark", "--clock-policy", "30fps"};
    const char* const invalid_package[] = {"benchmark", "--feature-lab-package", ""};
    if (!expect_options(project_cli, 5, true) || !expect_options(feature_cli, 5, true) ||
        !expect_options(invalid_clock, 3, false) || !expect_options(invalid_package, 3, false))
        return 1;
    if (!noveltea::benchmark::parse_options(5, project_cli, options, error) ||
        options.clock_policy != "fixed-step" ||
        !noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    const auto menu =
        noveltea::benchmark::reference_scenario_options(options, "engine-compiled-menu");
    if (menu.clock_policy != "fixed-step" ||
        !noveltea::benchmark::validate_reference_options(menu, error))
        return 1;
    const auto raw = noveltea::benchmark::reference_scenario_options(menu, "raw-bgfx-empty");
    if (raw.clock_policy != "realtime" || !raw.feature_lab_package.empty() ||
        !noveltea::benchmark::validate_reference_options(raw, error))
        return 1;
    if (!noveltea::benchmark::parse_options(5, feature_cli, options, error) ||
        options.feature_lab_package != "lab.ntpkg" ||
        !noveltea::benchmark::validate_reference_options(options, error) ||
        !noveltea::benchmark::reference_scenario_options(options, "engine-compiled-menu")
             .feature_lab_package.empty())
        return 1;
    options.clock_policy = "fixed-step";
    options.scenario = "engine-empty";
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options = {};
    for (const char* id : {"raw-bgfx-clear", "raw-bgfx-single-quad", "raw-bgfx-textured",
                           "raw-bgfx-offscreen", "raw-bgfx-draw-calls"}) {
        options.scenario = id;
        if (!noveltea::benchmark::validate_reference_options(options, error))
            return 1;
    }
    return 0;
}
