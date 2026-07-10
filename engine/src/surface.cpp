#include "noveltea/surface.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>

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

bool is_valid_aspect_ratio(AspectRatio ratio) { return ratio.width > 0 && ratio.height > 0; }

AspectRatio normalize_aspect_ratio(AspectRatio ratio)
{
    if (!is_valid_aspect_ratio(ratio)) {
        return {};
    }
    const std::uint32_t divisor = std::gcd(ratio.width, ratio.height);
    return {ratio.width / divisor, ratio.height / divisor};
}

AspectRatio effective_aspect_ratio(const DisplayProfile& profile)
{
    AspectRatio ratio = normalize_aspect_ratio(profile.aspect_ratio);
    if (profile.orientation == ScreenOrientation::Portrait) {
        std::swap(ratio.width, ratio.height);
    }
    return ratio;
}

IntegerRect fit_centered_viewport(int host_width, int host_height, AspectRatio ratio)
{
    host_width = positive_dimension(host_width);
    host_height = positive_dimension(host_height);
    ratio = normalize_aspect_ratio(ratio);

    // Contain fitting floors the constrained dimension. Centering also floors
    // the leading margin, so any odd spare pixel belongs to the right or bottom
    // presentation bar. This keeps the policy deterministic on every platform.
    int width = host_width;
    int height =
        static_cast<int>((static_cast<std::int64_t>(host_width) * ratio.height) / ratio.width);
    if (height > host_height) {
        height = host_height;
        width =
            static_cast<int>((static_cast<std::int64_t>(host_height) * ratio.width) / ratio.height);
    }
    width = positive_dimension(width);
    height = positive_dimension(height);
    return {(host_width - width) / 2, (host_height - height) / 2, width, height};
}

PresentationMetrics make_presentation_metrics(const SurfaceMetrics& host_surface,
                                              const DisplayProfile& profile)
{
    PresentationMetrics result;
    result.host_surface = sanitize_surface_metrics(host_surface);
    const AspectRatio ratio = effective_aspect_ratio(profile);
    result.host_logical_viewport = fit_centered_viewport(result.host_surface.logical_width,
                                                         result.host_surface.logical_height, ratio);

    // Framebuffer edges are rounded to nearest from the already-fitted logical
    // edges. Deriving both opposite edges this way avoids independently rounded
    // sizes drifting away from the logical input boundary.
    const auto scale_edge = [](int edge, int source_size, int destination_size) {
        return static_cast<int>(
            (static_cast<std::int64_t>(edge) * destination_size + source_size / 2) / source_size);
    };
    const IntegerRect& logical = result.host_logical_viewport;
    const int left = scale_edge(logical.x, result.host_surface.logical_width,
                                result.host_surface.framebuffer_width);
    const int right = scale_edge(logical.x + logical.width, result.host_surface.logical_width,
                                 result.host_surface.framebuffer_width);
    const int top = scale_edge(logical.y, result.host_surface.logical_height,
                               result.host_surface.framebuffer_height);
    const int bottom = scale_edge(logical.y + logical.height, result.host_surface.logical_height,
                                  result.host_surface.framebuffer_height);
    result.host_framebuffer_viewport = {left, top, right - left, bottom - top};
    result.game_surface =
        make_surface_metrics(logical.width, logical.height, right - left, bottom - top);
    return result;
}

bool contains(const IntegerRect& rect, Vec2 point)
{
    return point.x >= static_cast<float>(rect.x) && point.y >= static_cast<float>(rect.y) &&
           point.x < static_cast<float>(rect.x + rect.width) &&
           point.y < static_cast<float>(rect.y + rect.height);
}

std::optional<Vec2> host_to_game_logical(Vec2 host_point, const PresentationMetrics& presentation)
{
    if (!contains(presentation.host_logical_viewport, host_point)) {
        return std::nullopt;
    }
    return Vec2{host_point.x - static_cast<float>(presentation.host_logical_viewport.x),
                host_point.y - static_cast<float>(presentation.host_logical_viewport.y)};
}

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
