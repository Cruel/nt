#include "benchmark_options.hpp"
#include "reference_scene.hpp"
#include "reference_workloads.hpp"

#include <charconv>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <limits>
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

bool parse_options(int argc, const char* const argv[], Options& options, std::string& error)
{
    options = {};
    error.clear();
    bool has_cli_settings = false;
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
            flag != "--target-scale" && flag != "--msaa-samples" && flag != "--width" &&
            flag != "--height" && flag != "--warmup-seconds" && flag != "--seconds" &&
            flag != "--frames" && flag != "--output" && flag != "--repeats" &&
            flag != "--ready-timeout-seconds" && flag != "--profile" && flag != "--config") {
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
    return true;
}

Options reference_scenario_options(const Options& base, std::string_view scenario)
{
    Options selected = base;
    selected.scenario = scenario;
    const Options defaults;
    selected.rect_count = defaults.rect_count;
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
    return selected;
}

bool validate_reference_options(const Options& options, std::string& reason)
{
    if (options.scenario != "raw-bgfx-composition" &&
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
         options.scenario == "integrated-rmlui-controlled" || options.scenario == "engine-empty") &&
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
