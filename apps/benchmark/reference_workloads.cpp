#include "reference_workloads.hpp"

#include <bit>
#include <cmath>

namespace noveltea::benchmark {

bool is_extended_raw_scenario(std::string_view id)
{
    return id == "raw-bgfx-clear" || id == "raw-bgfx-single-quad" || id == "raw-bgfx-textured" ||
           id == "raw-bgfx-offscreen" || id == "raw-bgfx-draw-calls";
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
    work.view_count = work.offscreen ? 2 : 1;
    work.draws_per_frame = work.draw_calls + (work.offscreen ? 1 : 0);
    work.vertices_per_frame =
        uint64_t(work.draw_calls) * work.quads_per_draw * 4 + (work.offscreen ? 4 : 0);
    work.triangles_per_frame =
        uint64_t(work.draw_calls) * work.quads_per_draw * 2 + (work.offscreen ? 2 : 0);
    work.texture_bytes = uint64_t(work.texture_size) * work.texture_size * 4 +
                         (work.offscreen ? uint64_t(render_width) * render_height * 4 : 0);
    return work;
}

} // namespace noveltea::benchmark
