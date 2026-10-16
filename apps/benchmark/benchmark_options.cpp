#include "benchmark_options.hpp"
#include "reference_scene.hpp"
#include "reference_workloads.hpp"

#include <algorithm>
#include <charconv>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <optional>
#include <string_view>

namespace noveltea::benchmark {
namespace {

bool parse_integer(std::string_view text, uint64_t& value)
{
    if (text.empty())
        return false;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    return error == std::errc{} && end == text.data() + text.size();
}

bool parse_duration(const char* text, double& value)
{
    if (!text || *text == '\0')
        return false;
    char* end = nullptr;
    errno = 0;
    value = std::strtod(text, &end);
    return errno == 0 && end != text && *end == '\0' && std::isfinite(value) && value >= 0.0 &&
           value <= 3600.0;
}

} // namespace

UiEffectCounts ui_effect_counts(const Options& options)
{
    return {options.ui_clipping, options.ui_transforms, options.ui_gradients,
            options.ui_filters,  options.ui_masks,      options.ui_nested_layers};
}

bool parse_options(int argc, const char* const argv[], Options& options, std::string& error)
{
    options = {};
    error.clear();
    bool has_cli_settings = false;
    std::string named_ui_preset;
    // Explicit knobs take precedence over a named preset regardless of CLI order.
    // The Web launcher serializes named and explicit knobs in canonical URL order.
    std::optional<uint32_t> ui_elements_override;
    std::optional<uint32_t> ui_text_lines_override;
    std::optional<uint32_t> ui_dynamic_lines_override;
    std::optional<uint32_t> ui_visible_override;
    std::optional<uint32_t> ui_empty_override;
    std::optional<uint32_t> ui_hidden_override;
    std::optional<std::string> ui_text_mode_override;
    std::optional<std::string> ui_redraw_override;
    for (int i = 1; i < argc; ++i) {
        const std::string_view flag = argv[i];
        if (flag == "--help") {
            options.help = true;
            return true;
        }
        if (flag == "--dashboard-visual-smoke") {
            has_cli_settings = true;
            options.dashboard_visual_smoke = true;
            options.no_ui = false;
            continue;
        }
        if (flag == "--dashboard-smoke") {
            has_cli_settings = true;
            options.dashboard_smoke = true;
            options.no_ui = false;
            options.warmup_seconds = 0.0;
            options.measurement_frames = 30;
            continue;
        }
        if (flag == "--quick-suite") {
            has_cli_settings = true;
            options.quick_suite = true;
            continue;
        }
        if (flag == "--smoke") {
            has_cli_settings = true;
            options.warmup_seconds = 0.0;
            options.measurement_frames = 30;
            continue;
        }
        if (flag == "--native-resolution") {
            has_cli_settings = true;
            options.native_resolution = true;
            continue;
        }
        if (flag == "--vsync") {
            has_cli_settings = true;
            options.vsync = true;
            continue;
        }
        if (flag == "--no-ui") {
            options.no_ui = true;
            continue;
        }
        if (flag == "--ui") {
            has_cli_settings = true;
            options.no_ui = false;
            continue;
        }
        if (flag == "--no-transparent-overlay") {
            has_cli_settings = true;
            options.transparent_overlay = false;
            continue;
        }
        if (flag == "--raw-samples") {
            has_cli_settings = true;
            options.raw_samples = true;
            continue;
        }
        if (flag != "--scenario" && flag != "--rect-count" && flag != "--rect-scale" &&
            flag != "--draw-calls" && flag != "--quad-count" && flag != "--texture-size" &&
            flag != "--coverage" && flag != "--composition-path" && flag != "--composite-passes" &&
            flag != "--target-scale" && flag != "--msaa-samples" && flag != "--ui-elements" &&
            flag != "--ui-text-lines" && flag != "--ui-dynamic-lines" &&
            flag != "--ui-visible-contexts" && flag != "--ui-empty-contexts" &&
            flag != "--ui-hidden-contexts" && flag != "--ui-preset" && flag != "--ui-text-mode" &&
            flag != "--ui-redraw" && flag != "--ui-clipping" && flag != "--ui-transforms" &&
            flag != "--ui-gradients" && flag != "--ui-filters" && flag != "--ui-masks" &&
            flag != "--ui-nested-layers" && flag != "--width" && flag != "--height" &&
            flag != "--warmup-seconds" && flag != "--seconds" && flag != "--frames" &&
            flag != "--output" && flag != "--repeats" && flag != "--ready-timeout-seconds" &&
            flag != "--profile" && flag != "--config" && flag != "--clock-policy" &&
            flag != "--feature-lab-package" && flag != "--capacity-dimension" &&
            flag != "--capacity-target" && flag != "--capacity-threshold" &&
            flag != "--capacity-mode") {
            error = "unknown argument: " + std::string(flag);
            return false;
        }
        if (i + 1 >= argc) {
            error = "missing value for " + std::string(flag);
            return false;
        }
        const char* value = argv[++i];
        if (flag == "--config") {
            if (*value == '\0') {
                error = "config path must not be empty";
                return false;
            }
            options.config_path = value;
            continue;
        }
        if (flag == "--scenario") {
            has_cli_settings = true;
            options.scenario = value;
            continue;
        }
        if (flag == "--capacity-dimension" || flag == "--capacity-target" ||
            flag == "--capacity-mode" || flag == "--capacity-threshold") {
            has_cli_settings = true;
            if (flag == "--capacity-dimension")
                options.capacity_dimension = value;
            else if (flag == "--capacity-target")
                options.capacity_target = value;
            else if (flag == "--capacity-mode")
                options.capacity_mode = value;
            else if (!parse_duration(value, options.capacity_threshold) ||
                     options.capacity_threshold == 0.0) {
                error = "invalid capacity threshold";
                return false;
            }
            continue;
        }
        if (flag == "--clock-policy") {
            has_cli_settings = true;
            options.clock_policy = value;
            if (options.clock_policy != "realtime" && options.clock_policy != "fixed-step") {
                error = "--clock-policy must be realtime or fixed-step";
                return false;
            }
            continue;
        }
        if (flag == "--feature-lab-package") {
            has_cli_settings = true;
            if (!*value) {
                error = "--feature-lab-package requires a path";
                return false;
            }
            options.feature_lab_package = value;
            continue;
        }
        if (flag == "--ui-preset") {
            has_cli_settings = true;
            Options probe;
            if (!apply_ui_scaling_preset(probe, value)) {
                error = "unknown RmlUi scaling preset";
                return false;
            }
            named_ui_preset = value;
            continue;
        }
        if (flag == "--ui-text-mode" || flag == "--ui-redraw") {
            has_cli_settings = true;
            if (flag == "--ui-text-mode") {
                options.ui_text_mode = value;
                ui_text_mode_override = value;
            } else {
                options.ui_redraw = value;
                ui_redraw_override = value;
            }
            if ((flag == "--ui-text-mode" && options.ui_text_mode != "static" &&
                 options.ui_text_mode != "dynamic") ||
                (flag == "--ui-redraw" && options.ui_redraw != "continuous" &&
                 options.ui_redraw != "dirty-only")) {
                error = "invalid RmlUi text or redraw mode";
                return false;
            }
            continue;
        }
        if (flag == "--ui-elements" || flag == "--ui-text-lines" || flag == "--ui-dynamic-lines" ||
            flag == "--ui-visible-contexts" || flag == "--ui-empty-contexts" ||
            flag == "--ui-hidden-contexts" || flag == "--ui-clipping" ||
            flag == "--ui-transforms" || flag == "--ui-gradients" || flag == "--ui-filters" ||
            flag == "--ui-masks" || flag == "--ui-nested-layers") {
            has_cli_settings = true;
            uint64_t number = 0;
            const bool effects = flag == "--ui-clipping" || flag == "--ui-transforms" ||
                                 flag == "--ui-gradients" || flag == "--ui-filters" ||
                                 flag == "--ui-masks" || flag == "--ui-nested-layers";
            if (!parse_integer(value, number) || number > (effects ? 16u : 2048u)) {
                error = "invalid RmlUi workload count";
                return false;
            }
            if (flag == "--ui-elements")
                ui_elements_override = options.ui_elements = static_cast<uint32_t>(number);
            else if (flag == "--ui-text-lines")
                ui_text_lines_override = options.ui_text_lines = static_cast<uint32_t>(number);
            else if (flag == "--ui-dynamic-lines")
                ui_dynamic_lines_override = options.ui_dynamic_lines =
                    static_cast<uint32_t>(number);
            else if (flag == "--ui-visible-contexts")
                ui_visible_override = options.ui_visible_contexts = static_cast<uint32_t>(number);
            else if (flag == "--ui-empty-contexts")
                ui_empty_override = options.ui_empty_contexts = static_cast<uint32_t>(number);
            else if (flag == "--ui-hidden-contexts")
                ui_hidden_override = options.ui_hidden_contexts = static_cast<uint32_t>(number);
            else if (flag == "--ui-clipping")
                options.ui_clipping = static_cast<uint32_t>(number);
            else if (flag == "--ui-transforms")
                options.ui_transforms = static_cast<uint32_t>(number);
            else if (flag == "--ui-gradients")
                options.ui_gradients = static_cast<uint32_t>(number);
            else if (flag == "--ui-filters")
                options.ui_filters = static_cast<uint32_t>(number);
            else if (flag == "--ui-masks")
                options.ui_masks = static_cast<uint32_t>(number);
            else
                options.ui_nested_layers = static_cast<uint32_t>(number);
            continue;
        }
        if (flag == "--composition-path") {
            has_cli_settings = true;
            options.composition_path = value;
            if (options.composition_path != "direct" && options.composition_path != "offscreen") {
                error = "--composition-path must be direct or offscreen";
                return false;
            }
            continue;
        }
        if (flag == "--target-scale") {
            has_cli_settings = true;
            double scale = 0.0;
            if (!parse_duration(value, scale) || scale < 0.25 || scale > 1.0) {
                error = "--target-scale must be in 0.25..1.0";
                return false;
            }
            options.target_scale = scale;
            continue;
        }
        if (flag == "--composite-passes" || flag == "--msaa-samples") {
            has_cli_settings = true;
            uint64_t number = 0;
            if (!parse_integer(value, number) ||
                (flag == "--composite-passes" ? number > 4
                                              : number != 0 && number != 2 && number != 4)) {
                error = "invalid composition count or MSAA sample count";
                return false;
            }
            if (flag == "--composite-passes")
                options.composite_passes = static_cast<uint32_t>(number);
            else
                options.msaa_samples = static_cast<uint32_t>(number);
            continue;
        }
        if (flag == "--coverage") {
            has_cli_settings = true;
            double coverage = 0.0;
            if (!parse_duration(value, coverage) || coverage < 0.125 || coverage > 1.0) {
                error = "--coverage must be in 0.125..1.0";
                return false;
            }
            options.coverage = coverage;
            continue;
        }
        if (flag == "--rect-scale") {
            has_cli_settings = true;
            double scale = 0.0;
            if (!parse_duration(value, scale) || scale < 0.25 || scale > 1.0) {
                error = "--rect-scale must be in 0.25..1.0";
                return false;
            }
            options.rect_scale = scale;
            continue;
        }
        if (flag == "--profile") {
            has_cli_settings = true;
            options.profile = value;
            if (options.profile != "clean" && options.profile != "diagnostic") {
                error = "profile must be clean or diagnostic";
                return false;
            }
            continue;
        }
        if (flag == "--output") {
            if (*value == '\0') {
                error = "output path must not be empty";
                return false;
            }
            options.output_path = value;
            continue;
        }
        has_cli_settings = true;
        if (flag == "--seconds" || flag == "--warmup-seconds" ||
            flag == "--ready-timeout-seconds") {
            double seconds = 0.0;
            if (!parse_duration(value, seconds) || (flag != "--warmup-seconds" && seconds == 0.0)) {
                error = "invalid duration for " + std::string(flag);
                return false;
            }
            if (flag == "--seconds")
                options.duration_seconds = seconds;
            else if (flag == "--warmup-seconds")
                options.warmup_seconds = seconds;
            else
                options.ready_timeout_seconds = seconds;
            continue;
        }
        uint64_t number = 0;
        if (!parse_integer(value, number) || number == 0) {
            error = "invalid positive integer for " + std::string(flag);
            return false;
        }
        if (flag == "--draw-calls") {
            if (number > 1024) {
                error = "--draw-calls exceeds 1024";
                return false;
            }
            options.draw_calls = static_cast<uint32_t>(number);
        } else if (flag == "--quad-count") {
            if (number > 512) {
                error = "--quad-count exceeds 512";
                return false;
            }
            options.quad_count = static_cast<uint32_t>(number);
        } else if (flag == "--texture-size") {
            if (number > 2048 || (number & (number - 1)) != 0) {
                error = "--texture-size must be a power of two in 1..2048";
                return false;
            }
            options.texture_size = static_cast<uint32_t>(number);
        } else if (flag == "--rect-count") {
            if (number > kMaxReferenceRects) {
                error = "--rect-count exceeds 256";
                return false;
            }
            options.rect_count = static_cast<uint32_t>(number);
        } else if (flag == "--frames") {
            if (number > 300000) {
                error = "--frames exceeds maximum (300000)";
                return false;
            }
            options.measurement_frames = number;
        } else if (flag == "--repeats") {
            if (number > 20) {
                error = "--repeats exceeds maximum (20)";
                return false;
            }
            options.repeats = static_cast<uint32_t>(number);
        } else {
            if (number > 8192) {
                error = "width/height must be within 1..8192";
                return false;
            }
            if (flag == "--width")
                options.width = static_cast<int>(number);
            else
                options.height = static_cast<int>(number);
        }
    }
    if (argc == 1)
        options.no_ui = false;
    if (!options.config_path.empty() && has_cli_settings) {
        error = "--config cannot be combined with run settings; --output is allowed";
        return false;
    }
    if (named_ui_preset.empty() && ui_text_lines_override && !ui_dynamic_lines_override)
        options.ui_dynamic_lines = std::min(options.ui_dynamic_lines, options.ui_text_lines);
    if (!named_ui_preset.empty()) {
        if (!is_ui_scaling_scenario(options.scenario)) {
            error = "--ui-preset requires an RmlUi scaling scenario";
            return false;
        }
        (void)apply_ui_scaling_preset(options, named_ui_preset);
        if (ui_elements_override)
            options.ui_elements = *ui_elements_override;
        if (ui_text_lines_override) {
            options.ui_text_lines = *ui_text_lines_override;
            if (!ui_dynamic_lines_override)
                options.ui_dynamic_lines =
                    std::min(options.ui_dynamic_lines, options.ui_text_lines);
        }
        if (ui_dynamic_lines_override)
            options.ui_dynamic_lines = *ui_dynamic_lines_override;
        if (ui_visible_override)
            options.ui_visible_contexts = *ui_visible_override;
        if (ui_empty_override)
            options.ui_empty_contexts = *ui_empty_override;
        if (ui_hidden_override)
            options.ui_hidden_contexts = *ui_hidden_override;
        if (ui_text_mode_override)
            options.ui_text_mode = *ui_text_mode_override;
        if (ui_redraw_override)
            options.ui_redraw = *ui_redraw_override;
    }
    return true;
}

bool apply_ui_scaling_preset(Options& options, std::string_view preset)
{
    if (preset != "balanced" && preset != "elements-heavy" && preset != "text-heavy" &&
        preset != "contexts-heavy" && preset != "dirty-static")
        return false;
    const Options defaults;
    options.ui_elements = defaults.ui_elements;
    options.ui_text_lines = defaults.ui_text_lines;
    options.ui_dynamic_lines = defaults.ui_dynamic_lines;
    options.ui_visible_contexts = defaults.ui_visible_contexts;
    options.ui_empty_contexts = defaults.ui_empty_contexts;
    options.ui_hidden_contexts = defaults.ui_hidden_contexts;
    options.ui_text_mode = defaults.ui_text_mode;
    options.ui_redraw = defaults.ui_redraw;
    if (preset == "elements-heavy") {
        options.ui_elements = 2048;
    } else if (preset == "text-heavy") {
        options.ui_text_lines = 256;
        options.ui_dynamic_lines = 256;
        options.ui_text_mode = "dynamic";
    } else if (preset == "contexts-heavy") {
        options.ui_visible_contexts = 4;
        options.ui_empty_contexts = 8;
        options.ui_hidden_contexts = 8;
    } else if (preset == "dirty-static") {
        options.ui_redraw = "dirty-only";
    }
    return true;
}

Options reference_scenario_options(const Options& base, std::string_view scenario)
{
    Options selected = base;
    selected.scenario = scenario;
    if (scenario != "engine-feature-lab")
        selected.feature_lab_package.clear();
    if (scenario != "engine-compiled-empty" && scenario != "engine-compiled-menu" &&
        scenario != "engine-feature-lab")
        selected.clock_policy = "realtime";
    const Options defaults;
    selected.rect_count = defaults.rect_count;
    selected.ui_elements = defaults.ui_elements;
    selected.ui_text_lines = defaults.ui_text_lines;
    selected.ui_dynamic_lines = defaults.ui_dynamic_lines;
    selected.ui_visible_contexts = defaults.ui_visible_contexts;
    selected.ui_empty_contexts = defaults.ui_empty_contexts;
    selected.ui_hidden_contexts = defaults.ui_hidden_contexts;
    selected.ui_text_mode = defaults.ui_text_mode;
    selected.ui_redraw = defaults.ui_redraw;
    selected.ui_clipping = defaults.ui_clipping;
    selected.ui_transforms = defaults.ui_transforms;
    selected.ui_gradients = defaults.ui_gradients;
    selected.ui_filters = defaults.ui_filters;
    selected.ui_masks = defaults.ui_masks;
    selected.ui_nested_layers = defaults.ui_nested_layers;
    selected.rect_scale = defaults.rect_scale;
    selected.draw_calls = defaults.draw_calls;
    selected.quad_count = defaults.quad_count;
    selected.texture_size = defaults.texture_size;
    selected.coverage = defaults.coverage;
    selected.composition_path = defaults.composition_path;
    selected.composite_passes = defaults.composite_passes;
    selected.target_scale = defaults.target_scale;
    selected.msaa_samples = defaults.msaa_samples;
    selected.transparent_overlay = defaults.transparent_overlay;
    selected.capacity_dimension.clear();
    selected.capacity_target = defaults.capacity_target;
    selected.capacity_threshold = defaults.capacity_threshold;
    selected.capacity_mode = defaults.capacity_mode;
    selected.native_resolution = defaults.native_resolution;
    return selected;
}

bool validate_reference_options(const Options& options, std::string& reason)
{
    const Options defaults;
    const bool project_scenario = options.scenario == "engine-compiled-empty" ||
                                  options.scenario == "engine-compiled-menu" ||
                                  options.scenario == "engine-feature-lab";
    if ((options.clock_policy != "realtime" && options.clock_policy != "fixed-step") ||
        (options.clock_policy == "fixed-step" && !project_scenario) ||
        (!options.feature_lab_package.empty() && options.scenario != "engine-feature-lab")) {
        reason = "fixed-step clock requires a Compiled Project scenario; package path requires "
                 "Feature Lab";
        return false;
    }
    const bool effects_scenario = is_ui_effects_scenario(options.scenario);
    const auto effects = ui_effect_counts(options);
    const auto default_effects = ui_effect_counts(defaults);
    if (!effects_scenario &&
        (effects.clipping != default_effects.clipping ||
         effects.transforms != default_effects.transforms ||
         effects.gradients != default_effects.gradients ||
         effects.filters != default_effects.filters || effects.masks != default_effects.masks ||
         effects.nested_layers != default_effects.nested_layers)) {
        reason = "RmlUi effect settings require an effects scenario";
        return false;
    }
    if (effects_scenario) {
        if (valid_ui_effects_parameters(effects) && options.rect_count == defaults.rect_count &&
            options.rect_scale == defaults.rect_scale &&
            options.draw_calls == defaults.draw_calls &&
            options.quad_count == defaults.quad_count &&
            options.texture_size == defaults.texture_size &&
            options.coverage == defaults.coverage &&
            options.composition_path == defaults.composition_path &&
            options.composite_passes == defaults.composite_passes &&
            options.target_scale == defaults.target_scale &&
            options.msaa_samples == defaults.msaa_samples &&
            options.transparent_overlay == defaults.transparent_overlay &&
            options.ui_elements == defaults.ui_elements &&
            options.ui_text_lines == defaults.ui_text_lines &&
            options.ui_dynamic_lines == defaults.ui_dynamic_lines &&
            options.ui_visible_contexts == defaults.ui_visible_contexts &&
            options.ui_empty_contexts == defaults.ui_empty_contexts &&
            options.ui_hidden_contexts == defaults.ui_hidden_contexts &&
            options.ui_text_mode == defaults.ui_text_mode &&
            options.ui_redraw == defaults.ui_redraw) {
            reason.clear();
            return true;
        }
        reason = "invalid RmlUi effects parameters";
        return false;
    }
    if (is_ui_scaling_scenario(options.scenario)) {
        if (options.rect_count == defaults.rect_count &&
            options.rect_scale == defaults.rect_scale &&
            options.draw_calls == defaults.draw_calls &&
            options.quad_count == defaults.quad_count &&
            options.texture_size == defaults.texture_size &&
            options.coverage == defaults.coverage &&
            options.composition_path == defaults.composition_path &&
            options.composite_passes == defaults.composite_passes &&
            options.target_scale == defaults.target_scale &&
            options.msaa_samples == defaults.msaa_samples &&
            options.transparent_overlay == defaults.transparent_overlay &&
            options.ui_dynamic_lines <= 256 &&
            (options.ui_text_mode != "dynamic" ||
             options.ui_dynamic_lines <= options.ui_text_lines) &&
            valid_ui_scaling_parameters(options.ui_elements, options.ui_text_lines,
                                        options.ui_visible_contexts, options.ui_empty_contexts,
                                        options.ui_hidden_contexts, options.ui_text_mode,
                                        options.ui_redraw)) {
            reason.clear();
            return true;
        }
        reason = "invalid RmlUi scaling parameters";
        return false;
    }
    if (options.ui_elements != defaults.ui_elements ||
        options.ui_text_lines != defaults.ui_text_lines ||
        options.ui_dynamic_lines != defaults.ui_dynamic_lines ||
        options.ui_visible_contexts != defaults.ui_visible_contexts ||
        options.ui_empty_contexts != defaults.ui_empty_contexts ||
        options.ui_hidden_contexts != defaults.ui_hidden_contexts ||
        options.ui_text_mode != defaults.ui_text_mode || options.ui_redraw != defaults.ui_redraw) {
        reason = "RmlUi scaling settings require a scaling scenario";
        return false;
    }
    if (options.scenario != "raw-bgfx-composition" && options.scenario != "raw-bgfx-offscreen" &&
        (options.composition_path != "direct" || options.composite_passes != 0 ||
         options.target_scale != 1.0 || options.msaa_samples != 0 ||
         !options.transparent_overlay)) {
        reason = "composition settings require raw-bgfx-composition";
        return false;
    }
    if (is_extended_raw_scenario(options.scenario) && options.rect_count == kReferenceRectCount &&
        options.rect_scale == kReferenceRectScale &&
        raw_workload_reference(options, static_cast<uint32_t>(options.width),
                               static_cast<uint32_t>(options.height))) {
        reason.clear();
        return true;
    }
    if (options.scenario == "raw-bgfx-geometry" &&
        valid_geometry_parameters(options.rect_count, options.rect_scale) &&
        options.draw_calls == 64 && options.quad_count == 1 && options.texture_size == 256 &&
        options.coverage == 1.0) {
        reason.clear();
        return true;
    }
    if ((options.scenario == "raw-bgfx-empty" || options.scenario == "standalone-rmlui-simple" ||
         options.scenario == "integrated-rmlui-production" ||
         options.scenario == "integrated-rmlui-controlled" || options.scenario == "engine-empty" ||
         project_scenario) &&
        options.rect_count == kReferenceRectCount && options.rect_scale == kReferenceRectScale &&
        options.draw_calls == 64 && options.quad_count == 1 && options.texture_size == 256 &&
        options.coverage == 1.0) {
        reason.clear();
        return true;
    }
    reason = "unsupported scenario or incompatible reference parameters";
    return false;
}

} // namespace noveltea::benchmark
