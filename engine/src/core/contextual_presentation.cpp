#include "noveltea/core/presentation_contracts.hpp"

#include <algorithm>
#include <cmath>

namespace noveltea::core {
namespace {
double finite_non_negative(double value) noexcept
{
    return std::isfinite(value) && value > 0.0 ? value : 0.0;
}

double aligned(double start, double extent, double popup_extent,
               ContextualAnchorAlignment alignment) noexcept
{
    switch (alignment) {
    case ContextualAnchorAlignment::Start:
        return start;
    case ContextualAnchorAlignment::Center:
        return start + (extent - popup_extent) * 0.5;
    case ContextualAnchorAlignment::End:
        return start + extent - popup_extent;
    }
    return start;
}

TriggerPoint nearest_point(TriggerRect bounds, TriggerPoint point) noexcept
{
    return {std::clamp(point.x, bounds.x, bounds.x + bounds.width),
            std::clamp(point.y, bounds.y, bounds.y + bounds.height)};
}
} // namespace

LayoutLogicalTriggerContext resolve_layout_trigger_context(const TriggerContext& context,
                                                           double logical_width,
                                                           double logical_height) noexcept
{
    const double width = finite_non_negative(logical_width);
    const double height = finite_non_negative(logical_height);
    LayoutLogicalTriggerContext result{.pointer = std::nullopt,
                                       .source_bounds = std::nullopt,
                                       .viewport = {0.0, 0.0, width, height}};
    if (context.pointer)
        result.pointer = TriggerPoint{context.pointer->x * width, context.pointer->y * height};
    if (context.source_bounds)
        result.source_bounds = TriggerRect{
            context.source_bounds->x * width, context.source_bounds->y * height,
            context.source_bounds->width * width, context.source_bounds->height * height};
    return result;
}

TriggerPoint resolve_contextual_anchor(const LayoutLogicalTriggerContext& context,
                                       const ContextualAnchorRequest& request) noexcept
{
    const double popup_width = finite_non_negative(request.popup_width);
    const double popup_height = finite_non_negative(request.popup_height);
    const double gap = finite_non_negative(request.gap);
    const double padding = finite_non_negative(request.viewport_padding);

    TriggerPoint pointer =
        context.pointer.value_or(TriggerPoint{context.viewport.x + context.viewport.width * 0.5,
                                              context.viewport.y + context.viewport.height * 0.5});
    TriggerRect source =
        context.source_bounds.value_or(TriggerRect{pointer.x, pointer.y, 0.0, 0.0});

    if (request.source == ContextualAnchorSource::Pointer)
        source = {pointer.x, pointer.y, 0.0, 0.0};
    else if (request.source == ContextualAnchorSource::NearestSourcePoint) {
        const TriggerPoint nearest = nearest_point(source, pointer);
        source = {nearest.x, nearest.y, 0.0, 0.0};
    }

    TriggerPoint result;
    switch (request.side) {
    case ContextualAnchorSide::Top:
        result = {aligned(source.x, source.width, popup_width, request.alignment),
                  source.y - gap - popup_height};
        break;
    case ContextualAnchorSide::Right:
        result = {source.x + source.width + gap,
                  aligned(source.y, source.height, popup_height, request.alignment)};
        break;
    case ContextualAnchorSide::Bottom:
        result = {aligned(source.x, source.width, popup_width, request.alignment),
                  source.y + source.height + gap};
        break;
    case ContextualAnchorSide::Left:
        result = {source.x - gap - popup_width,
                  aligned(source.y, source.height, popup_height, request.alignment)};
        break;
    }

    if (request.viewport_safe) {
        const double min_x = context.viewport.x + padding;
        const double min_y = context.viewport.y + padding;
        const double max_x =
            std::max(min_x, context.viewport.x + context.viewport.width - padding - popup_width);
        const double max_y =
            std::max(min_y, context.viewport.y + context.viewport.height - padding - popup_height);
        result.x = std::clamp(result.x, min_x, max_x);
        result.y = std::clamp(result.y, min_y, max_y);
    }
    return result;
}

} // namespace noveltea::core
