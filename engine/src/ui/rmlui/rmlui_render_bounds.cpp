#include "ui/rmlui/rmlui_render_bounds.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace noveltea::ui::rmlui {

// ---------------------------------------------------------------------------
// FbRect helpers
// ---------------------------------------------------------------------------

uint64_t area(FbRect r)
{
    if (r.w <= 0 || r.h <= 0)
        return 0;
    return uint64_t(r.w) * uint64_t(r.h);
}

bool is_empty(FbRect r) { return r.w <= 0 || r.h <= 0; }

FbRect intersect(FbRect a, FbRect b)
{
    const int l = std::max(a.x, b.x);
    const int t = std::max(a.y, b.y);
    const int r = std::min(a.x + a.w, b.x + b.w);
    const int b2 = std::min(a.y + a.h, b.y + b.h);
    if (r <= l || b2 <= t)
        return {0, 0, 0, 0};
    return {l, t, r - l, b2 - t};
}

FbRect union_rects(FbRect a, FbRect b)
{
    if (is_empty(a))
        return b;
    if (is_empty(b))
        return a;
    const int l = std::min(a.x, b.x);
    const int t = std::min(a.y, b.y);
    const int r = std::max(a.x + a.w, b.x + b.w);
    const int b2 = std::max(a.y + a.h, b.y + b.h);
    return {l, t, r - l, b2 - t};
}

FbRect inflate(FbRect r, int x, int y)
{
    if (is_empty(r))
        return r;
    const int l = r.x - x;
    const int t = r.y - y;
    const int ri = r.x + r.w + x;
    const int b2 = r.y + r.h + y;
    if (ri <= l || b2 <= t)
        return {0, 0, 0, 0};
    return {l, t, ri - l, b2 - t};
}

FbRect clamp_to_surface(FbRect r, const SurfaceMetrics& surface)
{
    const int sw = std::max(surface.framebuffer_width, 0);
    const int sh = std::max(surface.framebuffer_height, 0);
    const int l = std::clamp(r.x, 0, sw);
    const int t = std::clamp(r.y, 0, sh);
    const int ri = std::clamp(r.x + r.w, 0, sw);
    const int b2 = std::clamp(r.y + r.h, 0, sh);
    if (ri <= l || b2 <= t)
        return {0, 0, 0, 0};
    return {l, t, ri - l, b2 - t};
}

FbRect align_outward_for_render_target(FbRect r)
{
    if (r.w <= 0 || r.h <= 0)
        return {0, 0, 0, 0};
    return {r.x, r.y, std::max(r.w, 1), std::max(r.h, 1)};
}

// ---------------------------------------------------------------------------
// LogicalRect helpers
// ---------------------------------------------------------------------------

float area(LogicalRect r)
{
    if (r.w <= 0.0f || r.h <= 0.0f)
        return 0.0f;
    return r.w * r.h;
}

bool is_empty(LogicalRect r) { return r.w <= 0.0f || r.h <= 0.0f; }

LogicalRect intersect(LogicalRect a, LogicalRect b)
{
    const float l = std::max(a.x, b.x);
    const float t = std::max(a.y, b.y);
    const float r = std::min(a.x + a.w, b.x + b.w);
    const float b2 = std::min(a.y + a.h, b.y + b.h);
    if (r <= l || b2 <= t)
        return {0.0f, 0.0f, 0.0f, 0.0f};
    return {l, t, r - l, b2 - t};
}

LogicalRect union_rects(LogicalRect a, LogicalRect b)
{
    if (is_empty(a))
        return b;
    if (is_empty(b))
        return a;
    const float l = std::min(a.x, b.x);
    const float t = std::min(a.y, b.y);
    const float r = std::max(a.x + a.w, b.x + b.w);
    const float b2 = std::max(a.y + a.h, b.y + b.h);
    return {l, t, r - l, b2 - t};
}

LogicalRect inflate(LogicalRect r, float x, float y)
{
    if (is_empty(r))
        return r;
    const float l = r.x - x;
    const float t = r.y - y;
    const float ri = r.x + r.w + x;
    const float b2 = r.y + r.h + y;
    if (ri <= l || b2 <= t)
        return {0.0f, 0.0f, 0.0f, 0.0f};
    return {l, t, ri - l, b2 - t};
}

// ---------------------------------------------------------------------------
// Coordinate conversion
// ---------------------------------------------------------------------------

FbRect logical_to_framebuffer(LogicalRect logical, const SurfaceMetrics& surface)
{
    const SurfaceMetrics s = sanitize_surface_metrics(surface);
    const int left = int(std::floor(logical.x * s.scale_x));
    const int top = int(std::floor(logical.y * s.scale_y));
    const int right = int(std::ceil((logical.x + logical.w) * s.scale_x));
    const int bottom = int(std::ceil((logical.y + logical.h) * s.scale_y));
    if (right <= left || bottom <= top) {
        return {0, 0, 0, 0};
    }
    return {left, top, right - left, bottom - top};
}

LogicalRect framebuffer_to_logical(FbRect fb, const SurfaceMetrics& surface)
{
    const SurfaceMetrics s = sanitize_surface_metrics(surface);
    return {float(fb.x) / s.scale_x, float(fb.y) / s.scale_y, float(fb.w) / s.scale_x,
            float(fb.h) / s.scale_y};
}

// ---------------------------------------------------------------------------
// UV calculation
// ---------------------------------------------------------------------------

std::array<float, 4> uv_rect_for_source_region(FbRect source_region, int texture_width,
                                               int texture_height)
{
    if (texture_width <= 0 || texture_height <= 0)
        return {0.0f, 0.0f, 0.0f, 0.0f};
    const float tw = float(texture_width);
    const float th = float(texture_height);
    return {float(source_region.x) / tw, float(source_region.y) / th,
            float(source_region.x + source_region.w) / tw,
            float(source_region.y + source_region.h) / th};
}

// ---------------------------------------------------------------------------
// Filter expansion
// ---------------------------------------------------------------------------

FilterExpansion blur_expansion(float sigma)
{
    if (sigma <= 0.0f)
        return {};
    const int radius = int(std::ceil(sigma * 3.0f));
    return {radius, radius, radius, radius};
}

FilterExpansion drop_shadow_expansion(float sigma, float offset_x, float offset_y)
{
    FilterExpansion exp;
    const int blur_radius = (sigma > 0.0f) ? int(std::ceil(sigma * 3.0f)) : 0;
    exp.left = std::max(0, blur_radius + (offset_x < 0.0f ? int(std::ceil(-offset_x)) : 0));
    exp.top = std::max(0, blur_radius + (offset_y < 0.0f ? int(std::ceil(-offset_y)) : 0));
    exp.right = std::max(0, blur_radius + (offset_x > 0.0f ? int(std::ceil(offset_x)) : 0));
    exp.bottom = std::max(0, blur_radius + (offset_y > 0.0f ? int(std::ceil(offset_y)) : 0));
    return exp;
}

FilterExpansion max_expansions(const FilterExpansion& a, const FilterExpansion& b)
{
    return {std::max(a.left, b.left), std::max(a.top, b.top), std::max(a.right, b.right),
            std::max(a.bottom, b.bottom)};
}

FilterExpansion add_expansions(const FilterExpansion& a, const FilterExpansion& b)
{
    return {a.left + b.left, a.top + b.top, a.right + b.right, a.bottom + b.bottom};
}

FilterExpansion filter_chain_expansion(std::span<const FilterExpansion> expansions)
{
    FilterExpansion total;
    for (const auto& exp : expansions) {
        total = add_expansions(total, exp);
    }
    return total;
}

FbRect expand_bounds(FbRect r, const FilterExpansion& expansion)
{
    if (is_empty(r))
        return r;
    const int l = r.x - expansion.left;
    const int t = r.y - expansion.top;
    const int ri = r.x + r.w + expansion.right;
    const int b2 = r.y + r.h + expansion.bottom;
    if (ri <= l || b2 <= t)
        return {0, 0, 0, 0};
    return {l, t, ri - l, b2 - t};
}

} // namespace noveltea::ui::rmlui
