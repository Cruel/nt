#pragma once

#include "noveltea/assets/asset_manager.hpp"

#include <memory>

namespace noveltea::bgfx_backend {

class NativeVideoTextureLoader {
public:
    explicit NativeVideoTextureLoader(const assets::AssetManager& assets);
    ~NativeVideoTextureLoader();
    [[nodiscard]] std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
    create_task(assets::TextureAssetRequest request);

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

void reset_native_video_upload_views() noexcept;

} // namespace noveltea::bgfx_backend
