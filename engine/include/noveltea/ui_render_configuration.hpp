#pragma once

#include <cstdint>

namespace noveltea {

// Renderer callback activity sampled during benchmark preparation, before timed
// frames. Counts describe real RmlUi -> bgfx-adapter calls, not confirmed GPU
// pixels, shader execution time, or application presentation.
struct UiEffectActivity {
    uint32_t clipping_calls = 0;
    uint32_t transforms = 0;
    uint32_t gradient_draws = 0;
    uint32_t filtered_composites = 0;
    uint32_t mask_saves = 0;
    uint32_t layer_pushes = 0;
    uint32_t max_layer_depth = 0;
    uint32_t backend_errors = 0;
};

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
