#pragma once

#include "benchmark_options.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace noveltea::benchmark {

// Stable Stage 2 raw-bgfx references. Counts describe actual work submitted
// per presented frame, not inferred GPU execution or confirmed presentation.
struct RawWorkloadReference {
    std::string id;
    uint32_t draw_calls = 0;
    uint32_t quads_per_draw = 0;
    uint32_t texture_size = 0;
    double coverage = 0.0;
    bool offscreen = false;
    bool composition = false;
    std::string composition_path;
    uint32_t composite_passes = 0;
    double target_scale = 1.0;
    uint32_t target_width = 0;
    uint32_t target_height = 0;
    uint32_t target_count = 0;
    uint32_t msaa_samples = 0;
    bool transparent_overlay = false;
    bool equivalent_to_direct = false;
    uint64_t target_color_bytes = 0;
    uint64_t estimated_msaa_bytes = 0;
    uint64_t covered_pixels = 0;
    uint32_t view_count = 1;
    uint32_t draws_per_frame = 0;
    uint64_t vertices_per_frame = 0;
    uint64_t triangles_per_frame = 0;
    uint64_t texture_bytes = 0;
};

[[nodiscard]] bool is_extended_raw_scenario(std::string_view id);
[[nodiscard]] std::optional<RawWorkloadReference>
raw_workload_reference(const Options& options, uint32_t render_width, uint32_t render_height);

} // namespace noveltea::benchmark
