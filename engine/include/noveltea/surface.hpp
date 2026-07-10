#pragma once

#include "noveltea/math/geometry.hpp"

#include <cstdint>
#include <optional>

namespace noveltea {

struct SurfaceMetrics {
    int logical_width = 1280;
    int logical_height = 720;
    int framebuffer_width = 1280;
    int framebuffer_height = 720;
    float scale_x = 1.0f;
    float scale_y = 1.0f;
};

enum class ScreenOrientation {
    Landscape,
    Portrait
};

struct AspectRatio {
    std::uint32_t width = 16;
    std::uint32_t height = 9;

    bool operator==(const AspectRatio&) const = default;
};

struct DisplayProfile {
    AspectRatio aspect_ratio{};
    ScreenOrientation orientation = ScreenOrientation::Landscape;
    std::uint32_t bar_color_rgba = 0x000000ff;
};

struct IntegerRect {
    int x = 0;
    int y = 0;
    int width = 1;
    int height = 1;

    bool operator==(const IntegerRect&) const = default;
};

struct PresentationMetrics {
    SurfaceMetrics host_surface{};
    SurfaceMetrics game_surface{};
    IntegerRect host_logical_viewport{};
    IntegerRect host_framebuffer_viewport{};
};

[[nodiscard]] bool is_valid_aspect_ratio(AspectRatio ratio);
[[nodiscard]] AspectRatio normalize_aspect_ratio(AspectRatio ratio);
[[nodiscard]] AspectRatio effective_aspect_ratio(const DisplayProfile& profile);
[[nodiscard]] IntegerRect fit_centered_viewport(int host_width, int host_height, AspectRatio ratio);
[[nodiscard]] PresentationMetrics make_presentation_metrics(const SurfaceMetrics& host_surface,
                                                            const DisplayProfile& profile = {});
[[nodiscard]] bool contains(const IntegerRect& rect, Vec2 point);
[[nodiscard]] std::optional<Vec2> host_to_game_logical(Vec2 host_point,
                                                       const PresentationMetrics& presentation);

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
