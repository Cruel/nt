#pragma once

#include "noveltea/math/geometry.hpp"

namespace noveltea {

struct SurfaceMetrics {
    int logical_width = 1280;
    int logical_height = 720;
    int framebuffer_width = 1280;
    int framebuffer_height = 720;
    float scale_x = 1.0f;
    float scale_y = 1.0f;
};

[[nodiscard]] SurfaceMetrics make_surface_metrics(int logical_width, int logical_height,
                                                  int framebuffer_width, int framebuffer_height);

[[nodiscard]] SurfaceMetrics sanitize_surface_metrics(SurfaceMetrics metrics);

[[nodiscard]] Vec2 logical_to_framebuffer(Vec2 logical, const SurfaceMetrics& surface);
[[nodiscard]] Vec2 framebuffer_to_logical(Vec2 physical, const SurfaceMetrics& surface);
[[nodiscard]] Rect logical_to_framebuffer(Rect logical, const SurfaceMetrics& surface);

[[nodiscard]] float proportional_y(const SurfaceMetrics& surface, float fraction);
[[nodiscard]] float clamp_logical(float value, float min, float max);
[[nodiscard]] float title_font_size(const SurfaceMetrics& surface);
[[nodiscard]] Rect anchored_rect(const SurfaceMetrics& surface, Vec2 anchor, Size size,
                                 Vec2 pivot = {0.5f, 0.5f});

} // namespace noveltea
