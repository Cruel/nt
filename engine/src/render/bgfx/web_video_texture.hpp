#pragma once

#include "render/bgfx/bgfx_typed_asset_loader.hpp"

namespace noveltea::bgfx_backend {

[[nodiscard]] std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
make_web_video_texture_task(const assets::AssetManager& assets,
                            assets::TextureAssetRequest request);

void advance_web_video_render_epoch() noexcept;
void drain_web_video_textures_on_owner() noexcept;

} // namespace noveltea::bgfx_backend
