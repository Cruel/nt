#include "noveltea/surface.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <numeric>

namespace noveltea {
namespace {

[[nodiscard]] int positive_host_dimension(int value) { return std::max(value, 1); }

[[nodiscard]] float derived_host_scale(int framebuffer, int logical)
{
    return static_cast<float>(positive_host_dimension(framebuffer)) /
           static_cast<float>(positive_host_dimension(logical));
}

[[nodiscard]] bool valid_positive_finite(float value)
{
    return std::isfinite(value) && value > 0.0f;
}

[[nodiscard]] int scale_edge(int edge, int source_size, int destination_size)
{
    return static_cast<int>((static_cast<std::int64_t>(edge) * destination_size + source_size / 2) /
                            source_size);
}

[[nodiscard]] AxisScale scale_between(IntegerSize destination, IntegerSize source)
{
    return {
        static_cast<float>(destination.width) / static_cast<float>(source.width),
        static_cast<float>(destination.height) / static_cast<float>(source.height),
    };
}

[[nodiscard]] Vec2 apply_scale(Vec2 point, AxisScale scale)
{
    return {point.x * scale.x, point.y * scale.y};
}

[[nodiscard]] Rect apply_scale(Rect rect, AxisScale scale)
{
    return {
        rect.x * scale.x,
        rect.y * scale.y,
        rect.width * scale.x,
        rect.height * scale.y,
    };
}

} // namespace

bool is_valid_reference_size(IntegerSize size)
{
    return size.width >= kMinimumReferenceDimension && size.width <= kMaximumReferenceDimension &&
           size.height >= kMinimumReferenceDimension && size.height <= kMaximumReferenceDimension;
}

bool is_valid_aspect_ratio(AspectRatio ratio) { return ratio.width > 0 && ratio.height > 0; }

AspectRatio normalize_aspect_ratio(AspectRatio ratio)
{
    if (!is_valid_aspect_ratio(ratio))
        return {};
    const std::uint32_t divisor = std::gcd(ratio.width, ratio.height);
    return {ratio.width / divisor, ratio.height / divisor};
}

AspectRatio reference_aspect_ratio(IntegerSize reference_size)
{
    if (!is_valid_reference_size(reference_size))
        return {};
    return normalize_aspect_ratio({static_cast<std::uint32_t>(reference_size.width),
                                   static_cast<std::uint32_t>(reference_size.height)});
}

ScreenOrientation reference_orientation(IntegerSize reference_size)
{
    return reference_size.width >= reference_size.height ? ScreenOrientation::Landscape
                                                         : ScreenOrientation::Portrait;
}

IntegerRect fit_centered_viewport(IntegerSize host_size, IntegerSize reference_size)
{
    host_size.width = positive_host_dimension(host_size.width);
    host_size.height = positive_host_dimension(host_size.height);
    const AspectRatio ratio = reference_aspect_ratio(reference_size);

    int width = host_size.width;
    int height =
        static_cast<int>((static_cast<std::int64_t>(host_size.width) * ratio.height) / ratio.width);
    if (height > host_size.height) {
        height = host_size.height;
        width = static_cast<int>((static_cast<std::int64_t>(host_size.height) * ratio.width) /
                                 ratio.height);
    }
    width = positive_host_dimension(width);
    height = positive_host_dimension(height);
    return {(host_size.width - width) / 2, (host_size.height - height) / 2, width, height};
}

IntegerSize resolve_world_raster_size(IntegerSize viewport_framebuffer_size,
                                      IntegerSize reference_size, WorldRasterPolicy policy)
{
    if (policy == WorldRasterPolicy::Native)
        return viewport_framebuffer_size;
    if (viewport_framebuffer_size.width <= reference_size.width &&
        viewport_framebuffer_size.height <= reference_size.height) {
        return viewport_framebuffer_size;
    }
    return reference_size;
}

core::Result<PresentationMetrics, std::string>
make_presentation_metrics(const HostSurfaceMetrics& host, const PresentationSettings& settings)
{
    if (!is_valid_reference_size(settings.reference.size)) {
        return core::Result<PresentationMetrics, std::string>::failure(
            "reference frame dimensions must be integers in the range 1..10000");
    }

    PresentationMetrics result;
    result.host = sanitize_host_surface_metrics(host);
    result.reference = settings.reference;
    result.viewport.reference_size = settings.reference.size;
    result.viewport.host_logical_rect =
        fit_centered_viewport(result.host.logical_size, result.reference.size);

    const IntegerRect& logical = result.viewport.host_logical_rect;
    const int left =
        scale_edge(logical.x, result.host.logical_size.width, result.host.framebuffer_size.width);
    const int right = scale_edge(logical.x + logical.width, result.host.logical_size.width,
                                 result.host.framebuffer_size.width);
    const int top =
        scale_edge(logical.y, result.host.logical_size.height, result.host.framebuffer_size.height);
    const int bottom = scale_edge(logical.y + logical.height, result.host.logical_size.height,
                                  result.host.framebuffer_size.height);
    result.viewport.host_framebuffer_rect = {left, top, right - left, bottom - top};
    result.ui_raster.size = {right - left, bottom - top};
    result.world_raster.policy = settings.world_raster_policy;
    result.world_raster.size = resolve_world_raster_size(
        result.ui_raster.size, result.reference.size, settings.world_raster_policy);
    return core::Result<PresentationMetrics, std::string>::success(std::move(result));
}

core::Result<ResolvedContextMetrics, std::string>
resolve_context_metrics(const PresentationMetrics& presentation, float runtime_ui_scale,
                        bool inherits_ui_scale)
{
    if (!is_valid_reference_size(presentation.reference.size)) {
        return core::Result<ResolvedContextMetrics, std::string>::failure(
            "cannot resolve context metrics from an invalid reference frame");
    }
    if (!valid_positive_finite(runtime_ui_scale)) {
        return core::Result<ResolvedContextMetrics, std::string>::failure(
            "runtime UI scale must be finite and positive");
    }
    if (presentation.ui_raster.size.width <= 0 || presentation.ui_raster.size.height <= 0) {
        return core::Result<ResolvedContextMetrics, std::string>::failure(
            "UI raster dimensions must be positive");
    }

    ResolvedContextMetrics result;
    result.requested_ui_scale = inherits_ui_scale ? runtime_ui_scale : 1.0f;
    result.layout_size = {
        std::max(
            1, static_cast<int>(std::floor(static_cast<double>(presentation.reference.size.width) /
                                               result.requested_ui_scale +
                                           0.5))),
        std::max(
            1, static_cast<int>(std::floor(static_cast<double>(presentation.reference.size.height) /
                                               result.requested_ui_scale +
                                           0.5))),
    };
    result.media_query_size = presentation.ui_raster.size;
    result.reference_to_context_scale = {
        static_cast<float>(result.layout_size.width) / presentation.reference.size.width,
        static_cast<float>(result.layout_size.height) / presentation.reference.size.height,
    };
    result.context_to_reference_scale = {
        static_cast<float>(presentation.reference.size.width) / result.layout_size.width,
        static_cast<float>(presentation.reference.size.height) / result.layout_size.height,
    };
    result.ui_raster_scale = {
        static_cast<float>(presentation.ui_raster.size.width) / result.layout_size.width,
        static_cast<float>(presentation.ui_raster.size.height) / result.layout_size.height,
    };
    const float realized_height_from_x = result.layout_size.height * result.ui_raster_scale.x;
    if (std::abs(realized_height_from_x - presentation.ui_raster.size.height) > 1.0f) {
        return core::Result<ResolvedContextMetrics, std::string>::failure(
            "resolved context UI raster scales materially disagree between axes");
    }
    return core::Result<ResolvedContextMetrics, std::string>::success(std::move(result));
}

PresentationTransform::PresentationTransform(PresentationMetrics presentation)
    : m_presentation(std::move(presentation))
{
}

std::optional<Vec2>
PresentationTransform::host_logical_to_normalized_game_viewport(Vec2 host_logical_point) const
{
    const IntegerRect& viewport = m_presentation.viewport.host_logical_rect;
    if (!contains(viewport, host_logical_point))
        return std::nullopt;
    return Vec2{
        (host_logical_point.x - static_cast<float>(viewport.x)) /
            static_cast<float>(viewport.width),
        (host_logical_point.y - static_cast<float>(viewport.y)) /
            static_cast<float>(viewport.height),
    };
}

Vec2 PresentationTransform::normalized_game_viewport_to_reference(
    Vec2 normalized_viewport_point) const
{
    return {
        normalized_viewport_point.x * static_cast<float>(m_presentation.reference.size.width),
        normalized_viewport_point.y * static_cast<float>(m_presentation.reference.size.height),
    };
}

Vec2 PresentationTransform::reference_to_world_raster(Vec2 reference_point) const
{
    return apply_scale(reference_point, reference_to_world_raster_scale());
}

Rect PresentationTransform::reference_to_world_raster(Rect reference_rect) const
{
    return apply_scale(reference_rect, reference_to_world_raster_scale());
}

Vec2 PresentationTransform::reference_to_native_ui_raster(Vec2 reference_point) const
{
    return apply_scale(reference_point, reference_to_native_ui_raster_scale());
}

Rect PresentationTransform::reference_to_native_ui_raster(Rect reference_rect) const
{
    return apply_scale(reference_rect, reference_to_native_ui_raster_scale());
}

Vec2 PresentationTransform::reference_to_context_logical(
    Vec2 reference_point, const ResolvedContextMetrics& context) const
{
    return apply_scale(reference_point, context.reference_to_context_scale);
}

Vec2 PresentationTransform::context_logical_to_native_ui_raster(
    Vec2 context_logical_point, const ResolvedContextMetrics& context) const
{
    return apply_scale(context_logical_point, context_logical_to_native_ui_raster_scale(context));
}

Vec2 PresentationTransform::native_ui_raster_to_context_logical(
    Vec2 native_ui_raster_point, const ResolvedContextMetrics& context) const
{
    const AxisScale scale = context_logical_to_native_ui_raster_scale(context);
    return {native_ui_raster_point.x / scale.x, native_ui_raster_point.y / scale.y};
}

Rect PresentationTransform::world_raster_to_native_game_viewport(Rect world_raster_rect) const
{
    return apply_scale(world_raster_rect, world_raster_to_native_game_viewport_scale());
}

IntegerRect PresentationTransform::fitted_viewport_crop_in_host_framebuffer() const
{
    return m_presentation.viewport.host_framebuffer_rect;
}

AxisScale PresentationTransform::reference_to_world_raster_scale() const
{
    return scale_between(m_presentation.world_raster.size, m_presentation.reference.size);
}

AxisScale PresentationTransform::reference_to_native_ui_raster_scale() const
{
    return scale_between(m_presentation.ui_raster.size, m_presentation.reference.size);
}

AxisScale PresentationTransform::world_raster_to_native_game_viewport_scale() const
{
    return scale_between(m_presentation.ui_raster.size, m_presentation.world_raster.size);
}

AxisScale PresentationTransform::context_logical_to_native_ui_raster_scale(
    const ResolvedContextMetrics& context) const
{
    return context.ui_raster_scale;
}

std::string format_presentation_metrics(const PresentationMetrics& presentation)
{
    const PresentationTransform transform{presentation};
    const AxisScale reference_to_world = transform.reference_to_world_raster_scale();
    const AxisScale reference_to_native_ui = transform.reference_to_native_ui_raster_scale();
    const AxisScale world_to_native_viewport =
        transform.world_raster_to_native_game_viewport_scale();
    char buffer[1024]{};
    std::snprintf(
        buffer, sizeof(buffer),
        "host.logical=%dx%d host.framebuffer=%dx%d "
        "host.logical_to_framebuffer=(%.6g,%.6g) reference=%dx%d "
        "viewport.host_logical=(%d,%d %dx%d) viewport.host_framebuffer=(%d,%d %dx%d) "
        "world_raster=%dx%d[%s] ui_raster=%dx%d "
        "reference_to_world_raster_scale=(%.6g,%.6g) "
        "reference_to_native_ui_raster_scale=(%.6g,%.6g) "
        "world_raster_to_native_game_viewport_scale=(%.6g,%.6g)",
        presentation.host.logical_size.width, presentation.host.logical_size.height,
        presentation.host.framebuffer_size.width, presentation.host.framebuffer_size.height,
        presentation.host.logical_to_framebuffer_scale.x,
        presentation.host.logical_to_framebuffer_scale.y, presentation.reference.size.width,
        presentation.reference.size.height, presentation.viewport.host_logical_rect.x,
        presentation.viewport.host_logical_rect.y, presentation.viewport.host_logical_rect.width,
        presentation.viewport.host_logical_rect.height,
        presentation.viewport.host_framebuffer_rect.x,
        presentation.viewport.host_framebuffer_rect.y,
        presentation.viewport.host_framebuffer_rect.width,
        presentation.viewport.host_framebuffer_rect.height, presentation.world_raster.size.width,
        presentation.world_raster.size.height,
        presentation.world_raster.policy == WorldRasterPolicy::Capped ? "capped" : "native",
        presentation.ui_raster.size.width, presentation.ui_raster.size.height, reference_to_world.x,
        reference_to_world.y, reference_to_native_ui.x, reference_to_native_ui.y,
        world_to_native_viewport.x, world_to_native_viewport.y);
    return buffer;
}

std::string format_resolved_context_metrics(const ResolvedContextMetrics& context)
{
    char buffer[512]{};
    std::snprintf(buffer, sizeof(buffer),
                  "context.requested_ui_scale=%.6g context.layout=%dx%d "
                  "context.media_query=%dx%d context.reference_to_context=(%.6g,%.6g) "
                  "context.context_to_reference=(%.6g,%.6g) "
                  "context.context_logical_to_native_ui_raster_scale=(%.6g,%.6g)",
                  context.requested_ui_scale, context.layout_size.width, context.layout_size.height,
                  context.media_query_size.width, context.media_query_size.height,
                  context.reference_to_context_scale.x, context.reference_to_context_scale.y,
                  context.context_to_reference_scale.x, context.context_to_reference_scale.y,
                  context.ui_raster_scale.x, context.ui_raster_scale.y);
    return buffer;
}

bool contains(const IntegerRect& rect, Vec2 point)
{
    return point.x >= static_cast<float>(rect.x) && point.y >= static_cast<float>(rect.y) &&
           point.x < static_cast<float>(rect.x + rect.width) &&
           point.y < static_cast<float>(rect.y + rect.height);
}

std::optional<Vec2> host_to_viewport_logical(Vec2 host_point,
                                             const PresentationMetrics& presentation)
{
    const PresentationTransform transform{presentation};
    const auto normalized = transform.host_logical_to_normalized_game_viewport(host_point);
    if (!normalized)
        return std::nullopt;
    return Vec2{normalized->x * static_cast<float>(presentation.viewport.host_logical_rect.width),
                normalized->y * static_cast<float>(presentation.viewport.host_logical_rect.height)};
}

HostSurfaceMetrics make_host_surface_metrics(int logical_width, int logical_height,
                                             int framebuffer_width, int framebuffer_height)
{
    return sanitize_host_surface_metrics({
        .logical_size = {logical_width, logical_height},
        .framebuffer_size = {framebuffer_width, framebuffer_height},
        .logical_to_framebuffer_scale =
            {
                derived_host_scale(framebuffer_width, logical_width),
                derived_host_scale(framebuffer_height, logical_height),
            },
    });
}

HostSurfaceMetrics sanitize_host_surface_metrics(HostSurfaceMetrics metrics)
{
    metrics.logical_size.width = positive_host_dimension(metrics.logical_size.width);
    metrics.logical_size.height = positive_host_dimension(metrics.logical_size.height);
    metrics.framebuffer_size.width = positive_host_dimension(metrics.framebuffer_size.width);
    metrics.framebuffer_size.height = positive_host_dimension(metrics.framebuffer_size.height);
    if (!valid_positive_finite(metrics.logical_to_framebuffer_scale.x)) {
        metrics.logical_to_framebuffer_scale.x =
            derived_host_scale(metrics.framebuffer_size.width, metrics.logical_size.width);
    }
    if (!valid_positive_finite(metrics.logical_to_framebuffer_scale.y)) {
        metrics.logical_to_framebuffer_scale.y =
            derived_host_scale(metrics.framebuffer_size.height, metrics.logical_size.height);
    }
    return metrics;
}

Vec2 host_logical_to_framebuffer(Vec2 logical, const HostSurfaceMetrics& host)
{
    const HostSurfaceMetrics sanitized = sanitize_host_surface_metrics(host);
    return {logical.x * sanitized.logical_to_framebuffer_scale.x,
            logical.y * sanitized.logical_to_framebuffer_scale.y};
}

Vec2 host_framebuffer_to_logical(Vec2 framebuffer, const HostSurfaceMetrics& host)
{
    const HostSurfaceMetrics sanitized = sanitize_host_surface_metrics(host);
    return {framebuffer.x / sanitized.logical_to_framebuffer_scale.x,
            framebuffer.y / sanitized.logical_to_framebuffer_scale.y};
}

Rect host_logical_to_framebuffer(Rect logical, const HostSurfaceMetrics& host)
{
    const Vec2 origin = host_logical_to_framebuffer(Vec2{logical.x, logical.y}, host);
    const Vec2 size = host_logical_to_framebuffer(Vec2{logical.width, logical.height}, host);
    return {origin.x, origin.y, size.x, size.y};
}

float proportional_y(const ReferenceFrameMetrics& reference, float fraction)
{
    return static_cast<float>(reference.size.height) * fraction;
}

float clamp_logical(float value, float min, float max) { return std::clamp(value, min, max); }

float title_font_size(const ReferenceFrameMetrics& reference)
{
    const float title_box_height =
        clamp_logical(static_cast<float>(reference.size.height) * 0.15f, 72.0f, 150.0f);
    return clamp_logical(title_box_height * 0.55f, 28.0f, 72.0f);
}

Rect anchored_rect(const ReferenceFrameMetrics& reference, Vec2 anchor, Size size, Vec2 pivot)
{
    const Vec2 point{static_cast<float>(reference.size.width) * anchor.x,
                     static_cast<float>(reference.size.height) * anchor.y};
    return {point.x - size.width * pivot.x, point.y - size.height * pivot.y, size.width,
            size.height};
}

} // namespace noveltea
