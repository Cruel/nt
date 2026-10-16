#include "reference_workloads.hpp"

#include <algorithm>
#include <bit>
#include <cmath>

namespace noveltea::benchmark {

std::vector<QuadTile> reference_quad_partition(uint32_t quad_count)
{
    if (quad_count == 0 || quad_count > 512)
        return {};
    uint32_t columns = 1;
    while (columns * columns < quad_count)
        ++columns;
    const uint32_t rows = (quad_count + columns - 1) / columns;
    std::vector<QuadTile> tiles;
    tiles.reserve(quad_count);
    for (uint32_t row = 0; row < rows; ++row) {
        const uint32_t row_count = std::min(columns, quad_count - row * columns);
        for (uint32_t column = 0; column < row_count; ++column) {
            tiles.push_back(
                {float(column) / row_count, float(row) / rows, 1.0f / row_count, 1.0f / rows});
        }
    }
    return tiles;
}

bool is_extended_raw_scenario(std::string_view id)
{
    return id == "raw-bgfx-clear" || id == "raw-bgfx-single-quad" || id == "raw-bgfx-textured" ||
           id == "raw-bgfx-offscreen" || id == "raw-bgfx-draw-calls" ||
           id == "raw-bgfx-composition";
}

std::optional<RawWorkloadReference>
raw_workload_reference(const Options& options, uint32_t render_width, uint32_t render_height)
{
    if (!is_extended_raw_scenario(options.scenario) || render_width == 0 || render_height == 0 ||
        render_width > 8192 || render_height > 8192 || options.draw_calls < 1 ||
        options.draw_calls > 1024 || options.quad_count < 1 || options.quad_count > 512 ||
        options.texture_size < 1 || options.texture_size > 2048 ||
        !std::has_single_bit(options.texture_size) || !std::isfinite(options.coverage) ||
        options.coverage < 0.125 || options.coverage > 1.0)
        return std::nullopt;

    RawWorkloadReference work;
    work.id = options.scenario;
    if (work.id == "raw-bgfx-composition") {
        if (options.draw_calls != 64 || options.quad_count != 1 ||
            (options.composition_path != "direct" && options.composition_path != "offscreen") ||
            options.composite_passes > 4 || !std::isfinite(options.target_scale) ||
            options.target_scale < 0.25 || options.target_scale > 1.0 ||
            (options.msaa_samples != 0 && options.msaa_samples != 2 && options.msaa_samples != 4))
            return std::nullopt;
        const bool offscreen = options.composition_path == "offscreen";
        if (offscreen ? options.composite_passes == 0
                      : (options.composite_passes != 0 || options.target_scale != 1.0 ||
                         options.msaa_samples != 0))
            return std::nullopt;
        work.composition = true;
        work.composition_path = options.composition_path;
        work.offscreen = offscreen;
        work.composite_passes = options.composite_passes;
        work.target_scale = options.target_scale;
        work.msaa_samples = options.msaa_samples;
        work.transparent_overlay = options.transparent_overlay;
        work.equivalent_to_direct = options.target_scale == 1.0 && options.msaa_samples == 0;
        work.draw_calls = 1;
        work.quads_per_draw = 1;
        work.texture_size = options.texture_size;
        work.coverage = options.coverage;
        work.target_width =
            offscreen ? static_cast<uint32_t>(std::lround(render_width * options.target_scale)) : 0;
        work.target_height =
            offscreen ? static_cast<uint32_t>(std::lround(render_height * options.target_scale))
                      : 0;
        if (offscreen && (work.target_width == 0 || work.target_height == 0))
            return std::nullopt;
        work.target_count = offscreen ? std::min(options.composite_passes, 3u) : 0;
        work.target_color_bytes =
            uint64_t(work.target_width) * work.target_height * 4 * work.target_count;
        // Estimated transient MSAA storage in addition to the sampled resolved color.
        // Drivers may allocate or resolve differently; this is not measured VRAM.
        work.estimated_msaa_bytes =
            uint64_t(work.target_width) * work.target_height * 4 * work.msaa_samples;
        work.texture_bytes = uint64_t(work.texture_size) * work.texture_size * 4 +
                             work.target_color_bytes + work.estimated_msaa_bytes;
        work.covered_pixels = static_cast<uint64_t>(
            std::llround(double(render_width) * render_height * work.coverage * work.coverage));
        work.view_count = 1 + work.composite_passes + uint32_t(work.transparent_overlay);
        work.draws_per_frame = 1 + work.composite_passes + uint32_t(work.transparent_overlay);
        work.vertices_per_frame = uint64_t(work.draws_per_frame) * 4;
        work.triangles_per_frame = uint64_t(work.draws_per_frame) * 2;
        return work;
    }
    if (options.composition_path != "direct" || options.composite_passes != 0 ||
        (work.id != "raw-bgfx-offscreen" && options.target_scale != 1.0) ||
        options.msaa_samples != 0 || !options.transparent_overlay)
        return std::nullopt;
    if (work.id == "raw-bgfx-clear") {
        if (options.draw_calls != 64 || options.quad_count != 1 || options.texture_size != 256 ||
            options.coverage != 1.0)
            return std::nullopt;
        return work;
    }
    work.draw_calls = 1;
    work.quads_per_draw = 1;
    work.texture_size = 1;
    work.coverage = 0.5;
    if (work.id == "raw-bgfx-textured" || work.id == "raw-bgfx-offscreen") {
        if (options.draw_calls != 64 || options.quad_count != 1)
            return std::nullopt;
        work.texture_size = options.texture_size;
        work.coverage = options.coverage;
    } else if (work.id == "raw-bgfx-draw-calls") {
        work.draw_calls = options.draw_calls;
        work.quads_per_draw = options.quad_count;
        work.texture_size = options.texture_size;
        work.coverage = options.coverage;
    } else if (options.draw_calls != 64 || options.quad_count != 1 || options.texture_size != 256 ||
               options.coverage != 1.0) {
        return std::nullopt;
    }
    work.offscreen = work.id == "raw-bgfx-offscreen";
    if (work.offscreen && (!std::isfinite(options.target_scale) || options.target_scale < 0.25 ||
                           options.target_scale > 1.0))
        return std::nullopt;
    work.target_scale = work.offscreen ? options.target_scale : 1.0;
    work.target_width =
        work.offscreen ? static_cast<uint32_t>(std::lround(render_width * work.target_scale)) : 0;
    work.target_height =
        work.offscreen ? static_cast<uint32_t>(std::lround(render_height * work.target_scale)) : 0;
    work.target_count = work.offscreen ? 1 : 0;
    work.target_color_bytes = uint64_t(work.target_width) * work.target_height * 4;
    work.covered_pixels = static_cast<uint64_t>(
        std::llround(double(render_width) * render_height * work.coverage * work.coverage));
    work.view_count = work.offscreen ? 2 : 1;
    work.draws_per_frame = work.draw_calls + (work.offscreen ? 1 : 0);
    work.vertices_per_frame =
        uint64_t(work.draw_calls) * work.quads_per_draw * 4 + (work.offscreen ? 4 : 0);
    work.triangles_per_frame =
        uint64_t(work.draw_calls) * work.quads_per_draw * 2 + (work.offscreen ? 2 : 0);
    work.texture_bytes =
        uint64_t(work.texture_size) * work.texture_size * 4 + work.target_color_bytes;
    return work;
}

} // namespace noveltea::benchmark
