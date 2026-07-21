#pragma once

#include "noveltea/core/result.hpp"
#include "noveltea/math/geometry.hpp"

#include <cstdint>
#include <optional>
#include <string>

namespace noveltea {

inline constexpr int kMinimumReferenceDimension = 1;
inline constexpr int kMaximumReferenceDimension = 10'000;

struct IntegerSize {
    int width = 1;
    int height = 1;

    bool operator==(const IntegerSize&) const = default;
};

struct IntegerRect {
    int x = 0;
    int y = 0;
    int width = 1;
    int height = 1;

    bool operator==(const IntegerRect&) const = default;
};

struct AxisScale {
    float x = 1.0f;
    float y = 1.0f;

    bool operator==(const AxisScale&) const = default;
};

struct HostSurfaceMetrics {
    IntegerSize logical_size{1280, 720};
    IntegerSize framebuffer_size{1280, 720};
    AxisScale logical_to_framebuffer_scale{};

    bool operator==(const HostSurfaceMetrics&) const = default;
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

struct ReferenceFrameMetrics {
    IntegerSize size{1920, 1080};

    bool operator==(const ReferenceFrameMetrics&) const = default;
};

struct GameViewportMetrics {
    IntegerRect host_logical_rect{};
    IntegerRect host_framebuffer_rect{};
    IntegerSize reference_size{1920, 1080};

    bool operator==(const GameViewportMetrics&) const = default;
};

enum class WorldRasterPolicy : std::uint8_t {
    Capped,
    Native
};

struct WorldRasterMetrics {
    IntegerSize size{1920, 1080};
    WorldRasterPolicy policy = WorldRasterPolicy::Capped;

    bool operator==(const WorldRasterMetrics&) const = default;
};

struct UiRasterMetrics {
    IntegerSize size{1280, 720};

    bool operator==(const UiRasterMetrics&) const = default;
};

struct PresentationSettings {
    ReferenceFrameMetrics reference{};
    WorldRasterPolicy world_raster_policy = WorldRasterPolicy::Capped;
    std::uint32_t bar_color_rgba = 0x000000ff;

    bool operator==(const PresentationSettings&) const = default;
};

struct PresentationMetrics {
    HostSurfaceMetrics host{};
    ReferenceFrameMetrics reference{};
    GameViewportMetrics viewport{};
    WorldRasterMetrics world_raster{};
    UiRasterMetrics ui_raster{};

    bool operator==(const PresentationMetrics&) const = default;
};

struct ResolvedContextMetrics {
    float requested_ui_scale = 1.0f;
    IntegerSize layout_size{1920, 1080};
    IntegerSize media_query_size{1280, 720};
    AxisScale reference_to_context_scale{};
    AxisScale context_to_reference_scale{};
    AxisScale ui_raster_scale{};

    bool operator==(const ResolvedContextMetrics&) const = default;
};

[[nodiscard]] bool is_valid_reference_size(IntegerSize size);
[[nodiscard]] bool is_valid_aspect_ratio(AspectRatio ratio);
[[nodiscard]] AspectRatio normalize_aspect_ratio(AspectRatio ratio);
[[nodiscard]] AspectRatio reference_aspect_ratio(IntegerSize reference_size);
[[nodiscard]] ScreenOrientation reference_orientation(IntegerSize reference_size);
[[nodiscard]] IntegerRect fit_centered_viewport(IntegerSize host_size, IntegerSize reference_size);
[[nodiscard]] IntegerSize resolve_world_raster_size(IntegerSize viewport_framebuffer_size,
                                                    IntegerSize reference_size,
                                                    WorldRasterPolicy policy);
[[nodiscard]] core::Result<PresentationMetrics, std::string>
make_presentation_metrics(const HostSurfaceMetrics& host, const PresentationSettings& settings);
[[nodiscard]] core::Result<ResolvedContextMetrics, std::string>
resolve_context_metrics(const PresentationMetrics& presentation, float runtime_ui_scale,
                        bool inherits_ui_scale);
[[nodiscard]] std::string format_presentation_metrics(const PresentationMetrics& presentation);
[[nodiscard]] std::string format_resolved_context_metrics(const ResolvedContextMetrics& context);

[[nodiscard]] bool contains(const IntegerRect& rect, Vec2 point);
[[nodiscard]] std::optional<Vec2> host_to_viewport_logical(Vec2 host_point,
                                                           const PresentationMetrics& presentation);

[[nodiscard]] HostSurfaceMetrics make_host_surface_metrics(int logical_width, int logical_height,
                                                           int framebuffer_width,
                                                           int framebuffer_height);
[[nodiscard]] HostSurfaceMetrics sanitize_host_surface_metrics(HostSurfaceMetrics metrics);

[[nodiscard]] Vec2 host_logical_to_framebuffer(Vec2 logical, const HostSurfaceMetrics& host);
[[nodiscard]] Vec2 host_framebuffer_to_logical(Vec2 framebuffer, const HostSurfaceMetrics& host);
[[nodiscard]] Rect host_logical_to_framebuffer(Rect logical, const HostSurfaceMetrics& host);

[[nodiscard]] float proportional_y(const ReferenceFrameMetrics& reference, float fraction);
[[nodiscard]] float clamp_logical(float value, float min, float max);
[[nodiscard]] float title_font_size(const ReferenceFrameMetrics& reference);
[[nodiscard]] Rect anchored_rect(const ReferenceFrameMetrics& reference, Vec2 anchor, Size size,
                                 Vec2 pivot = {0.5f, 0.5f});

} // namespace noveltea
