#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::benchmark {

struct ReferenceColor {
    uint8_t r = 0, g = 0, b = 0, a = 255;
};
struct ReferenceRect {
    std::string id;
    float x = 0, y = 0, width = 0, height = 0;
    ReferenceColor color;
};
struct ReferenceText {
    std::string id;
    std::string content;
    float x = 0, y = 0, font_size = 0;
    ReferenceColor color;
};
struct ReferenceTexture {
    std::string id;
    uint16_t width = 1, height = 1;
    ReferenceColor color{255, 255, 255, 255};
    bool linear_filter = false;
};
struct UiEffectCounts {
    uint32_t clipping = 0;
    uint32_t transforms = 0;
    uint32_t gradients = 0;
    uint32_t filters = 0;
    uint32_t masks = 0;
    uint32_t nested_layers = 0;
};

struct ReferenceScene {
    std::string id;
    uint32_t width = 1280, height = 720;
    ReferenceColor clear_color{17, 25, 36, 255};
    std::vector<ReferenceRect> rects;
    std::vector<ReferenceText> texts;
    ReferenceTexture texture;
    UiEffectCounts effects;
};

constexpr uint32_t kReferenceRectCount = 3;
constexpr uint32_t kMaxReferenceRects = 256;
constexpr double kReferenceRectScale = 1.0;
[[nodiscard]] bool valid_geometry_parameters(uint32_t rect_count, double rect_scale);
[[nodiscard]] ReferenceScene geometry_reference_scene(uint32_t rect_count = kReferenceRectCount,
                                                      double rect_scale = kReferenceRectScale);
[[nodiscard]] ReferenceScene simple_ui_reference_scene();
// Bounded reproducible UI scaling fixture shared by the standalone and Engine adapters.
[[nodiscard]] bool valid_ui_scaling_parameters(uint32_t elements, uint32_t text_lines,
                                               uint32_t visible, uint32_t empty, uint32_t hidden,
                                               std::string_view text_mode, std::string_view redraw);
[[nodiscard]] ReferenceScene ui_scaling_reference_scene(uint32_t elements, uint32_t text_lines);
[[nodiscard]] bool is_ui_scaling_scenario(std::string_view id);
[[nodiscard]] bool is_ui_effects_scenario(std::string_view id);
[[nodiscard]] bool valid_ui_effects_parameters(const UiEffectCounts& effects);
[[nodiscard]] ReferenceScene ui_effects_reference_scene(const UiEffectCounts& effects);
// Fixed-width content for per-frame text mutation; allocation/markup updates are workload work.
[[nodiscard]] std::string ui_dynamic_text(uint32_t frame, uint32_t line = 0);
// One exact markup generator feeds both the independent and integrated RmlUi hosts.
[[nodiscard]] std::string simple_ui_reference_markup(const ReferenceScene& scene,
                                                     float reference_scale = 1.0f);

} // namespace noveltea::benchmark
