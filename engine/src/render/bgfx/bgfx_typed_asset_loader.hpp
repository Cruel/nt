#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"

#include <bgfx/bgfx.h>

#include <string>
#include <span>
#include <unordered_map>
#include <vector>

namespace noveltea::bgfx_backend {

struct Rgba8MipChain {
    std::vector<std::uint8_t> bytes;
    std::uint8_t mip_count = 0;
};

[[nodiscard]] bool texture_sampler_uses_linear_filtering(MaterialTextureSampler sampler) noexcept;
[[nodiscard]] Rgba8MipChain build_rgba8_mip_chain(std::span<const std::uint8_t> base_level,
                                                  std::uint16_t width, std::uint16_t height);

class BgfxTypedAssetLoader final : public assets::TextureAssetLoader,
                                   public assets::ShaderProgramAssetLoader,
                                   public assets::MaterialAssetLoader {
public:
    BgfxTypedAssetLoader(const assets::AssetManager& assets, BgfxShaderProgramCache& programs);
    ~BgfxTypedAssetLoader() override;

    void set_shader_material_project(const ShaderMaterialProject* project);
    void set_fallback_texture(bgfx::TextureHandle texture);
    void clear_textures();

    [[nodiscard]] assets::AssetLoadResult<assets::TextureAsset>
    load_texture(const assets::TextureAssetRequest& request) override;
    [[nodiscard]] assets::AssetLoadResult<assets::ShaderProgramAsset>
    load_shader_program(const assets::ShaderProgramAssetRequest& request) override;
    [[nodiscard]] assets::AssetLoadResult<assets::MaterialAsset>
    load_material(const assets::MaterialAssetRequest& request) override;

private:
    struct CachedTexture {
        bgfx::TextureHandle handle = BGFX_INVALID_HANDLE;
        uint16_t width = 0;
        uint16_t height = 0;
        uint8_t mip_count = 1;
    };

    [[nodiscard]] assets::AssetLoadResult<assets::TextureAsset>
    load_decoded_texture(const assets::TextureAssetRequest& request);

    const assets::AssetManager& m_assets;
    BgfxShaderProgramCache& m_programs;
    const ShaderMaterialProject* m_shader_materials = nullptr;
    bgfx::TextureHandle m_fallback_texture = BGFX_INVALID_HANDLE;
    std::unordered_map<std::string, CachedTexture> m_textures;
};

} // namespace noveltea::bgfx_backend
