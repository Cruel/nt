#include "render/bgfx/editor_asset_profiler_renderer_memory.hpp"

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

core::AssetProfilerRendererEstimate sample_editor_asset_profiler_renderer_memory() noexcept
{
    const bgfx::Stats* stats = bgfx::getStats();
    if (stats == nullptr)
        return {};

    core::AssetProfilerRendererEstimate estimate;
    if (stats->textureMemoryUsed >= 0) {
        estimate.ordinary_texture_bytes = static_cast<std::uint64_t>(stats->textureMemoryUsed);
    }
    if (stats->rtMemoryUsed >= 0)
        estimate.render_target_bytes = static_cast<std::uint64_t>(stats->rtMemoryUsed);
    return estimate;
}

} // namespace noveltea::bgfx_backend
