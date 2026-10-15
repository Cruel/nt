#include "reference_scene.hpp"

#include <cmath>
#include <string>
#include <utility>

namespace noveltea::benchmark {

bool valid_geometry_parameters(uint32_t rect_count, double rect_scale)
{
    return rect_count >= 1 && rect_count <= kMaxReferenceRects && std::isfinite(rect_scale) &&
           rect_scale >= 0.25 && rect_scale <= 1.0;
}

ReferenceScene geometry_reference_scene(uint32_t rect_count, double rect_scale)
{
    ReferenceScene scene;
    scene.id = "geometry-reference";
    scene.texture.id = "solid-white";
    if (!valid_geometry_parameters(rect_count, rect_scale))
        return scene;
    scene.rects.reserve(rect_count);
    // The first three items are a fixed visual reference across renderer adapters.
    const ReferenceRect fixed[] = {
        {"primary", 700, 130, 340, 210, {225, 101, 102, 255}},
        {"secondary", 860, 370, 260, 130, {75, 185, 235, 255}},
        {"accent", 300, 410, 310, 170, {235, 184, 85, 255}},
    };
    for (uint32_t i = 0; i < rect_count; ++i) {
        ReferenceRect rect;
        if (i < 3) {
            rect = fixed[i];
        } else {
            // Independent deterministic tiles: no random seed, animation, or frame time.
            const uint32_t cell = i - 3;
            rect.id = "tile-" + std::to_string(cell);
            rect.x = 75.0f + static_cast<float>(cell % 16) * 67.0f;
            rect.y = 66.0f + static_cast<float>(cell / 16) * 36.0f;
            rect.width = 38;
            rect.height = 22;
            rect.color = {static_cast<uint8_t>(60 + (cell * 23) % 170),
                          static_cast<uint8_t>(70 + (cell * 43) % 160),
                          static_cast<uint8_t>(90 + (cell * 17) % 140), 255};
        }
        const float scale = static_cast<float>(rect_scale);
        rect.x += rect.width * (1.0f - scale) * 0.5f;
        rect.y += rect.height * (1.0f - scale) * 0.5f;
        rect.width *= scale;
        rect.height *= scale;
        scene.rects.push_back(std::move(rect));
    }
    return scene;
}

ReferenceScene simple_ui_reference_scene()
{
    auto scene = geometry_reference_scene();
    scene.id = "simple-ui-reference";
    scene.texts.push_back({"title", "NovelTea UI reference", 90, 120, 32, {245, 245, 245, 255}});
    return scene;
}

} // namespace noveltea::benchmark
