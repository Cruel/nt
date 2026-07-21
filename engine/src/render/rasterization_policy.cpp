#include "noveltea/render/rasterization_policy.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

namespace noveltea {
namespace {

std::int32_t saturating_integer(double value) noexcept
{
    if (!std::isfinite(value))
        return 0;

    constexpr double minimum = static_cast<double>(std::numeric_limits<std::int32_t>::min());
    constexpr double maximum = static_cast<double>(std::numeric_limits<std::int32_t>::max());
    return static_cast<std::int32_t>(std::clamp(value, minimum, maximum));
}

struct OrderedEdges {
    double left = 0.0;
    double top = 0.0;
    double right = 0.0;
    double bottom = 0.0;
};

OrderedEdges ordered_edges(Rect rect) noexcept
{
    const double first_x = rect.x;
    const double second_x = static_cast<double>(rect.x) + rect.width;
    const double first_y = rect.y;
    const double second_y = static_cast<double>(rect.y) + rect.height;
    return {
        .left = std::min(first_x, second_x),
        .top = std::min(first_y, second_y),
        .right = std::max(first_x, second_x),
        .bottom = std::max(first_y, second_y),
    };
}

} // namespace

Rect RasterizationPolicy::snap_transformed_rect_edges(Rect transformed_rect) noexcept
{
    const OrderedEdges edges = ordered_edges(transformed_rect);
    const std::int32_t left = saturating_integer(std::round(edges.left));
    const std::int32_t top = saturating_integer(std::round(edges.top));
    const std::int32_t right = saturating_integer(std::round(edges.right));
    const std::int32_t bottom = saturating_integer(std::round(edges.bottom));
    return {
        static_cast<float>(left),
        static_cast<float>(top),
        static_cast<float>(std::max<std::int64_t>(
            static_cast<std::int64_t>(right) - static_cast<std::int64_t>(left), 0)),
        static_cast<float>(std::max<std::int64_t>(
            static_cast<std::int64_t>(bottom) - static_cast<std::int64_t>(top), 0)),
    };
}

RasterScissor RasterizationPolicy::contain_transformed_scissor(Rect transformed_rect) noexcept
{
    const OrderedEdges edges = ordered_edges(transformed_rect);
    const std::int32_t left = saturating_integer(std::floor(edges.left));
    const std::int32_t top = saturating_integer(std::floor(edges.top));
    const std::int32_t right = saturating_integer(std::ceil(edges.right));
    const std::int32_t bottom = saturating_integer(std::ceil(edges.bottom));
    return {
        .x = left,
        .y = top,
        .width = static_cast<std::int32_t>(std::min<std::int64_t>(
            std::max<std::int64_t>(static_cast<std::int64_t>(right) - left, 0),
            std::numeric_limits<std::int32_t>::max())),
        .height = static_cast<std::int32_t>(std::min<std::int64_t>(
            std::max<std::int64_t>(static_cast<std::int64_t>(bottom) - top, 0),
            std::numeric_limits<std::int32_t>::max())),
    };
}

RasterScissor RasterizationPolicy::clip_scissor(RasterScissor scissor, std::int32_t raster_width,
                                                std::int32_t raster_height) noexcept
{
    raster_width = std::max(raster_width, 0);
    raster_height = std::max(raster_height, 0);
    const std::int64_t source_right = static_cast<std::int64_t>(scissor.x) + scissor.width;
    const std::int64_t source_bottom = static_cast<std::int64_t>(scissor.y) + scissor.height;
    const std::int32_t left = std::clamp(scissor.x, 0, raster_width);
    const std::int32_t top = std::clamp(scissor.y, 0, raster_height);
    const std::int32_t right =
        static_cast<std::int32_t>(std::clamp<std::int64_t>(source_right, 0, raster_width));
    const std::int32_t bottom =
        static_cast<std::int32_t>(std::clamp<std::int64_t>(source_bottom, 0, raster_height));
    return {
        .x = left,
        .y = top,
        .width = std::max(right - left, 0),
        .height = std::max(bottom - top, 0),
    };
}

Vec2 RasterizationPolicy::snap_text_run_origin(Vec2 transformed_origin) noexcept
{
    return {
        static_cast<float>(saturating_integer(std::round(transformed_origin.x))),
        static_cast<float>(saturating_integer(std::round(transformed_origin.y))),
    };
}

} // namespace noveltea
