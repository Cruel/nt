#pragma once

#include <cstdint>
#include <string>
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
struct ReferenceScene {
    std::string id;
    uint32_t width = 1280, height = 720;
    ReferenceColor clear_color{17, 25, 36, 255};
    std::vector<ReferenceRect> rects;
    std::vector<ReferenceText> texts;
    ReferenceTexture texture;
};

constexpr uint32_t kReferenceRectCount = 3;
constexpr uint32_t kMaxReferenceRects = 256;
constexpr double kReferenceRectScale = 1.0;
[[nodiscard]] bool valid_geometry_parameters(uint32_t rect_count, double rect_scale);
[[nodiscard]] ReferenceScene geometry_reference_scene(uint32_t rect_count = kReferenceRectCount,
                                                      double rect_scale = kReferenceRectScale);
[[nodiscard]] ReferenceScene simple_ui_reference_scene();
// One exact markup generator feeds both the independent and integrated RmlUi hosts.
[[nodiscard]] std::string simple_ui_reference_markup(const ReferenceScene& scene,
                                                     float reference_scale = 1.0f);

} // namespace noveltea::benchmark
