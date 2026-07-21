#pragma once

#include "noveltea/math/geometry.hpp"

#include <cstdint>

namespace noveltea {

struct RasterScissor {
    std::int32_t x = 0;
    std::int32_t y = 0;
    std::int32_t width = 0;
    std::int32_t height = 0;

    [[nodiscard]] bool empty() const noexcept { return width <= 0 || height <= 0; }

    bool operator==(const RasterScissor&) const = default;
};

class RasterizationPolicy {
public:
    // The input rectangle must already be in its target raster domain. Each far edge is snapped
    // independently so adjacent transformed rectangles sharing an edge remain continuous.
    [[nodiscard]] static Rect snap_transformed_rect_edges(Rect transformed_rect) noexcept;

    // Expands an already-transformed rectangle to integer raster edges so the resulting scissor
    // contains the complete source rectangle. This is intentionally different from geometry edge
    // snapping, which uses nearest-edge rounding.
    [[nodiscard]] static RasterScissor contain_transformed_scissor(Rect transformed_rect) noexcept;

    // Clips a raster scissor to a target raster extent without introducing another rounding rule.
    [[nodiscard]] static RasterScissor clip_scissor(RasterScissor scissor,
                                                    std::int32_t raster_width,
                                                    std::int32_t raster_height) noexcept;

    // Snaps only the run origin. Callers must add shaped glyph offsets and advances afterward so
    // kerning and fractional advances remain intact.
    [[nodiscard]] static Vec2 snap_text_run_origin(Vec2 transformed_origin) noexcept;
};

} // namespace noveltea
