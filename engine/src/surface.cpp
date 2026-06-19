#include "noveltea/surface.hpp"

#include <algorithm>
#include <cmath>

namespace noveltea {
namespace {

[[nodiscard]] int positive_dimension(int value) { return std::max(value, 1); }

[[nodiscard]] float derived_scale(int framebuffer, int logical)
{
    return static_cast<float>(positive_dimension(framebuffer)) /
           static_cast<float>(positive_dimension(logical));
}

[[nodiscard]] bool valid_scale(float value) { return std::isfinite(value) && value > 0.0f; }

} // namespace

SurfaceMetrics make_surface_metrics(int logical_width, int logical_height, int framebuffer_width,
                                    int framebuffer_height)
{
    return sanitize_surface_metrics({
        logical_width,
        logical_height,
        framebuffer_width,
        framebuffer_height,
        derived_scale(framebuffer_width, logical_width),
        derived_scale(framebuffer_height, logical_height),
    });
}

SurfaceMetrics sanitize_surface_metrics(SurfaceMetrics metrics)
{
    metrics.logical_width = positive_dimension(metrics.logical_width);
    metrics.logical_height = positive_dimension(metrics.logical_height);
    metrics.framebuffer_width = positive_dimension(metrics.framebuffer_width);
    metrics.framebuffer_height = positive_dimension(metrics.framebuffer_height);

    if (!valid_scale(metrics.scale_x)) {
        metrics.scale_x = derived_scale(metrics.framebuffer_width, metrics.logical_width);
    }
    if (!valid_scale(metrics.scale_y)) {
        metrics.scale_y = derived_scale(metrics.framebuffer_height, metrics.logical_height);
    }
    return metrics;
}

Vec2 logical_to_framebuffer(Vec2 logical, const SurfaceMetrics& surface)
{
    const SurfaceMetrics s = sanitize_surface_metrics(surface);
    return {logical.x * s.scale_x, logical.y * s.scale_y};
}

Vec2 framebuffer_to_logical(Vec2 physical, const SurfaceMetrics& surface)
{
    const SurfaceMetrics s = sanitize_surface_metrics(surface);
    return {physical.x / s.scale_x, physical.y / s.scale_y};
}

Rect logical_to_framebuffer(Rect logical, const SurfaceMetrics& surface)
{
    const Vec2 origin = logical_to_framebuffer(Vec2{logical.x, logical.y}, surface);
    const Vec2 size = logical_to_framebuffer(Vec2{logical.width, logical.height}, surface);
    return {origin.x, origin.y, size.x, size.y};
}

float proportional_y(const SurfaceMetrics& surface, float fraction)
{
    return static_cast<float>(sanitize_surface_metrics(surface).logical_height) * fraction;
}

float clamp_logical(float value, float min, float max) { return std::clamp(value, min, max); }

float title_font_size(const SurfaceMetrics& surface)
{
    const SurfaceMetrics s = sanitize_surface_metrics(surface);
    const float title_box_height =
        clamp_logical(static_cast<float>(s.logical_height) * 0.15f, 72.0f, 150.0f);
    return clamp_logical(title_box_height * 0.55f, 28.0f, 72.0f);
}

Rect anchored_rect(const SurfaceMetrics& surface, Vec2 anchor, Size size, Vec2 pivot)
{
    const SurfaceMetrics s = sanitize_surface_metrics(surface);
    const Vec2 point{static_cast<float>(s.logical_width) * anchor.x,
                     static_cast<float>(s.logical_height) * anchor.y};
    return {point.x - size.width * pivot.x, point.y - size.height * pivot.y, size.width,
            size.height};
}

} // namespace noveltea
