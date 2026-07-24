#pragma once

#include "noveltea/core/asset_telemetry.hpp"

namespace noveltea::bgfx_backend {

[[nodiscard]] core::AssetProfilerRendererEstimate
sample_editor_asset_profiler_renderer_memory() noexcept;

} // namespace noveltea::bgfx_backend
