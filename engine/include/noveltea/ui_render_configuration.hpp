#pragma once

#include <cstdint>

namespace noveltea {

// A read-only snapshot of options actually supplied to a live RmlUi bgfx
// adapter. Does not claim to measure GPU operations or backend pass counts.
struct UiRenderConfiguration {
    std::uint8_t reference_msaa_samples = 0;
    bool base_direct_compatibility_requested = false;
    bool preserve_backbuffer = false;
    bool optimized_render_path = false;
    bool output_framebuffer_bound = false;
    bool geometry_raster_snapping = false;
    bool text_raster_snapping = false;
    int viewport_width = 0;
    int viewport_height = 0;
};

} // namespace noveltea
