#pragma once

#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_bounds.hpp"

#include "noveltea/surface.hpp"

namespace noveltea::ui::rmlui {

using rmlui_bgfx::add_expansions;
using rmlui_bgfx::align_outward_for_render_target;
using rmlui_bgfx::apply_mask_constraints;
using rmlui_bgfx::area;
using rmlui_bgfx::blur_expansion;
using rmlui_bgfx::clamp_to_surface;
using rmlui_bgfx::compute_child_layer_bounds;
using rmlui_bgfx::compute_indexed_geometry_bounds;
using rmlui_bgfx::compute_mask_uv_transform;
using rmlui_bgfx::compute_transformed_geometry_bounds;
using rmlui_bgfx::ConservativeMaskBounds;
using rmlui_bgfx::drop_shadow_expansion;
using rmlui_bgfx::expand_bounds;
using rmlui_bgfx::FbRect;
using rmlui_bgfx::filter_chain_expansion;
using rmlui_bgfx::FilterExpansion;
using rmlui_bgfx::framebuffer_to_logical;
using rmlui_bgfx::GeometryBoundsResult;
using rmlui_bgfx::GeometryBoundsStatus;
using rmlui_bgfx::inflate;
using rmlui_bgfx::intersect;
using rmlui_bgfx::intersects;
using rmlui_bgfx::is_empty;
using rmlui_bgfx::logical_to_framebuffer;
using rmlui_bgfx::LogicalRect;
using rmlui_bgfx::max_expansions;
using rmlui_bgfx::RenderBounds;
using rmlui_bgfx::union_rects;
using rmlui_bgfx::update_conservative_mask_bounds;
using rmlui_bgfx::uv_rect_for_source_region;

[[nodiscard]] inline rmlui_bgfx::SurfaceMetrics
to_rmlui_bgfx_surface(const noveltea::SurfaceMetrics& surface)
{
    return rmlui_bgfx::SurfaceMetrics{surface.logical_width,     surface.logical_height,
                                      surface.framebuffer_width, surface.framebuffer_height,
                                      surface.scale_x,           surface.scale_y};
}

[[nodiscard]] inline FbRect clamp_to_surface(FbRect rect, const noveltea::SurfaceMetrics& surface)
{
    return rmlui_bgfx::clamp_to_surface(rect, to_rmlui_bgfx_surface(surface));
}

[[nodiscard]] inline FbRect logical_to_framebuffer(LogicalRect logical,
                                                   const noveltea::SurfaceMetrics& surface)
{
    return rmlui_bgfx::logical_to_framebuffer(logical, to_rmlui_bgfx_surface(surface));
}

[[nodiscard]] inline LogicalRect framebuffer_to_logical(FbRect fb,
                                                        const noveltea::SurfaceMetrics& surface)
{
    return rmlui_bgfx::framebuffer_to_logical(fb, to_rmlui_bgfx_surface(surface));
}

[[nodiscard]] inline GeometryBoundsResult
compute_transformed_geometry_bounds(LogicalRect local_bounds, Rml::Vector2f translation,
                                    const Rml::Matrix4f* transform,
                                    const noveltea::SurfaceMetrics& surface)
{
    return rmlui_bgfx::compute_transformed_geometry_bounds(local_bounds, translation, transform,
                                                           to_rmlui_bgfx_surface(surface));
}

[[nodiscard]] inline RenderBounds
compute_child_layer_bounds(const noveltea::SurfaceMetrics& surface,
                           const RenderBounds* parent_bounds, const FbRect* scissor_region,
                           bool transform_valid)
{
    return rmlui_bgfx::compute_child_layer_bounds(to_rmlui_bgfx_surface(surface), parent_bounds,
                                                  scissor_region, transform_valid);
}

} // namespace noveltea::ui::rmlui
