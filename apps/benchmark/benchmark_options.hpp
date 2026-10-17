#pragma once

#include "reference_scene.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

namespace noveltea::benchmark {

struct Options {
    int width = 1280;
    int height = 720;
    double warmup_seconds = 3.0;
    double duration_seconds = 10.0;
    uint64_t measurement_frames = 0; // Zero selects duration-based measurement.
    uint32_t repeats = 1;
    double ready_timeout_seconds = 5.0;
    bool raw_samples = false;
    bool no_ui = true;
    std::string profile = "clean";
    std::string clock_policy = "realtime"; // Full Engine workloads may use fixed 60 Hz steps.
    std::string feature_lab_package;       // Optional exported .ntpkg, staged before warmup.
    bool vsync = false;
    bool native_resolution = false; // Use display pixel dimensions instead of explicit window size.
    std::string capacity_dimension; // Empty disables search; geometry, ui, pixels.
    std::string capacity_target = "cpu-ms"; // cpu-ms, gpu-ms, presented-fps.
    double capacity_threshold = 16.67;
    std::string capacity_mode = "presented"; // presented or bounded offscreen units.
    bool help = false;
    bool dashboard_smoke = false;
    bool quick_suite = false;
    bool dashboard_visual_smoke = false;
    bool inspection_smoke = false;
    std::string scenario = "raw-bgfx-empty";
    uint32_t rect_count = 3;
    uint32_t ui_elements = 512;
    uint32_t ui_text_lines = 64;
    uint32_t ui_dynamic_lines = 1; // Number of lines changed per frame in dynamic mode.
    uint32_t ui_visible_contexts = 1;
    uint32_t ui_empty_contexts = 0;
    uint32_t ui_hidden_contexts = 0;
    std::string ui_text_mode = "static";
    std::string ui_redraw = "continuous";
    uint32_t ui_clipping = 2;
    uint32_t ui_transforms = 2;
    uint32_t ui_gradients = 2;
    uint32_t ui_filters = 2;
    uint32_t ui_masks = 2;
    uint32_t ui_nested_layers = 2;
    double rect_scale = 1.0;
    uint32_t cpu_work_units = 1;        // Repeated CPU operations in one timed runner batch.
    uint32_t native_quads = 64;         // Native 2D independent geometry dimension.
    uint32_t native_glyphs = 256;       // Total shaped text glyphs per native text frame.
    uint32_t native_texture_size = 0;   // Zero means solid color; otherwise texels per side.
    double shader_tint = 1.0;           // Each postprocess pass multiplies RGB by this amount.
    std::string shader_scope = "world"; // world or full-game-viewport.
    uint32_t draw_calls = 64;
    uint32_t quad_count = 1;
    uint32_t texture_size = 256;
    double coverage = 1.0;
    std::string composition_path = "direct";
    uint32_t composite_passes = 0;
    double target_scale = 1.0;
    uint32_t msaa_samples = 0;
    bool transparent_overlay = true;
    std::string output_path;
    std::string config_path;
    std::string alternate_config_path;  // CLI-only path; loaded before execution.
    std::shared_ptr<Options> alternate; // Candidate B for repeated A/B/A cycles.
};

[[nodiscard]] inline bool is_cpu_scenario(std::string_view id) noexcept
{
    return id == "cpu-lua" || id == "cpu-runtime-session" || id == "cpu-flow-prediction";
}

[[nodiscard]] inline bool is_native_2d_scenario(std::string_view id) noexcept
{
    return id == "native-2d-geometry" || id == "native-2d-text-static" ||
           id == "native-2d-text-dynamic";
}

[[nodiscard]] inline bool is_shader_scenario(std::string_view id) noexcept
{
    return id == "native-shader-material" || id == "native-postprocess";
}

[[nodiscard]] UiEffectCounts ui_effect_counts(const Options& options);
bool parse_options(int argc, const char* const argv[], Options& options, std::string& error);
// Construct a canonical reference preset without changing run timing, output or platform settings.
// Every scenario switch and Quick Suite host must use this instead of copying reset fields.
[[nodiscard]] Options reference_scenario_options(const Options& base, std::string_view scenario);
// Named deterministic scaling profiles; the serialized configuration records their exact
// underlying parameters so later manual tweaks never masquerade as a fixed preset.
[[nodiscard]] bool apply_ui_scaling_preset(Options& options, std::string_view preset);
// App-specific reference selection; the portable runner accepts other Scenario IDs.
[[nodiscard]] bool validate_reference_options(const Options& options, std::string& reason);

} // namespace noveltea::benchmark
