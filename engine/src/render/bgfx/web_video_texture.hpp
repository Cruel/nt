#pragma once

#include "render/bgfx/bgfx_typed_asset_loader.hpp"

namespace noveltea::bgfx_backend {

[[nodiscard]] std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
make_web_video_texture_task(const assets::AssetManager& assets, TexturePreparationOwner& owner,
                            assets::TextureAssetRequest request);

} // namespace noveltea::bgfx_backend
