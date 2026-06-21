#pragma once

#include "noveltea/surface.hpp"

#include <array>
#include <cstdint>
#include <span>

namespace noveltea::ui::rmlui {

struct FbRect {
    int x = 0;
    int y = 0;
    int w = 0;
    int h = 0;
};

struct LogicalRect {
    float x = 0.0f;
    float y = 0.0f;
    float w = 0.0f;
    float h = 0.0f;
};

struct RenderBounds {
    LogicalRect logical;
    FbRect framebuffer;
};

struct FilterExpansion {
    int left = 0;
    int top = 0;
    int right = 0;
    int bottom = 0;
};

[[nodiscard]] uint64_t area(FbRect r);
[[nodiscard]] bool is_empty(FbRect r);

[[nodiscard]] FbRect intersect(FbRect a, FbRect b);
[[nodiscard]] FbRect union_rects(FbRect a, FbRect b);
[[nodiscard]] FbRect inflate(FbRect r, int x, int y);
[[nodiscard]] FbRect clamp_to_surface(FbRect r, const SurfaceMetrics& surface);
[[nodiscard]] FbRect align_outward_for_render_target(FbRect r);

[[nodiscard]] float area(LogicalRect r);
[[nodiscard]] bool is_empty(LogicalRect r);
[[nodiscard]] LogicalRect intersect(LogicalRect a, LogicalRect b);
[[nodiscard]] LogicalRect union_rects(LogicalRect a, LogicalRect b);
[[nodiscard]] LogicalRect inflate(LogicalRect r, float x, float y);

[[nodiscard]] FbRect logical_to_framebuffer(LogicalRect logical, const SurfaceMetrics& surface);
[[nodiscard]] LogicalRect framebuffer_to_logical(FbRect fb, const SurfaceMetrics& surface);

[[nodiscard]] std::array<float, 4> uv_rect_for_source_region(FbRect source_region,
                                                             int texture_width, int texture_height);

[[nodiscard]] FilterExpansion blur_expansion(float sigma);
[[nodiscard]] FilterExpansion drop_shadow_expansion(float sigma, float offset_x, float offset_y);
[[nodiscard]] FilterExpansion max_expansions(const FilterExpansion& a, const FilterExpansion& b);
[[nodiscard]] FilterExpansion add_expansions(const FilterExpansion& a, const FilterExpansion& b);
[[nodiscard]] FilterExpansion filter_chain_expansion(std::span<const FilterExpansion> expansions);
[[nodiscard]] FbRect expand_bounds(FbRect r, const FilterExpansion& expansion);

[[nodiscard]] RenderBounds compute_child_layer_bounds(const SurfaceMetrics& surface,
                                                      const RenderBounds* parent_bounds,
                                                      const FbRect* scissor_region,
                                                      bool transform_valid);

} // namespace noveltea::ui::rmlui
