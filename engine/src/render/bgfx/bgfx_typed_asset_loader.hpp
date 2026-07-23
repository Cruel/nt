#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"

#include <bgfx/bgfx.h>

#include <memory>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea::bgfx_backend {

struct Rgba8MipChain {
    std::vector<std::uint8_t> bytes;
    std::uint8_t mip_count = 0;
};

struct PreparedTextureUpload {
    assets::TextureAssetRequest request;
    std::vector<std::uint8_t> bytes;
    std::uint16_t width = 0;
    std::uint16_t height = 0;
    std::uint8_t mip_count = 0;
};

struct PreparedShaderProgram {
    assets::ShaderProgramAssetRequest request;
    assets::AssetBytes vertex_bytes;
    assets::AssetBytes fragment_bytes;
};

class TexturePreparationOwner {
public:
    virtual ~TexturePreparationOwner() = default;
    [[nodiscard]] virtual core::Result<assets::PreparedAsset<assets::TextureAsset>,
                                       core::Diagnostics>
    finalize_texture_on_owner(PreparedTextureUpload prepared) noexcept = 0;
};

class ShaderMaterialPreparationOwner {
public:
    virtual ~ShaderMaterialPreparationOwner() = default;
    [[nodiscard]] virtual core::Result<assets::PreparedAsset<assets::ShaderProgramAsset>,
                                       core::Diagnostics>
    finalize_shader_program_on_owner(PreparedShaderProgram prepared) noexcept = 0;
    [[nodiscard]] virtual core::Result<assets::PreparedAsset<assets::MaterialAsset>,
                                       core::Diagnostics>
    finalize_material_on_owner(assets::MaterialAssetRequest request, MaterialDefinition material,
                               std::uint64_t prepared_cpu_bytes) noexcept = 0;
};

class TexturePreparationTask final : public assets::AssetPreparationTask<assets::TextureAsset> {
public:
    TexturePreparationTask(const assets::AssetManager& assets, TexturePreparationOwner& owner,
                           assets::TextureAssetRequest request);
    ~TexturePreparationTask() override;

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override;
    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override;
    [[nodiscard]] core::Result<assets::PreparedAsset<assets::TextureAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

template<class T> class ShaderMaterialPreparationTask;

template<>
class ShaderMaterialPreparationTask<assets::ShaderProgramAsset> final
    : public assets::AssetPreparationTask<assets::ShaderProgramAsset> {
public:
    ShaderMaterialPreparationTask(const assets::AssetManager& assets,
                                  ShaderMaterialPreparationOwner& owner,
                                  assets::ShaderProgramAssetRequest request);
    ~ShaderMaterialPreparationTask() override;

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override;
    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override;
    [[nodiscard]] core::Result<assets::PreparedAsset<assets::ShaderProgramAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

template<>
class ShaderMaterialPreparationTask<assets::MaterialAsset> final
    : public assets::AssetPreparationTask<assets::MaterialAsset> {
public:
    ShaderMaterialPreparationTask(ShaderMaterialPreparationOwner& owner,
                                  assets::MaterialAssetRequest request,
                                  std::optional<MaterialDefinition> material,
                                  std::string preparation_error = {});
    ~ShaderMaterialPreparationTask() override;

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override;
    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override;
    [[nodiscard]] core::Result<assets::PreparedAsset<assets::MaterialAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

[[nodiscard]] bool texture_sampler_uses_linear_filtering(MaterialTextureSampler sampler) noexcept;
[[nodiscard]] Rgba8MipChain build_rgba8_mip_chain(std::span<const std::uint8_t> base_level,
                                                  std::uint16_t width, std::uint16_t height);

class BgfxTypedAssetLoader final : public assets::TextureAssetLoader,
                                   public assets::ShaderProgramAssetLoader,
                                   public assets::MaterialAssetLoader,
                                   private TexturePreparationOwner,
                                   private ShaderMaterialPreparationOwner {
public:
    BgfxTypedAssetLoader(const assets::AssetManager& assets, BgfxShaderProgramCache& programs);
    ~BgfxTypedAssetLoader() override;

    void set_shader_material_project(const ShaderMaterialProject* project);
    void set_fallback_texture(bgfx::TextureHandle texture);
    void clear_textures();

    [[nodiscard]] assets::AssetLoadResult<assets::TextureAsset>
    load_texture(const assets::TextureAssetRequest& request) override;
    [[nodiscard]] std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
    create_texture_preparation_task(const assets::TextureAssetRequest& request) override;
    [[nodiscard]] assets::AssetLoadResult<assets::ShaderProgramAsset>
    load_shader_program(const assets::ShaderProgramAssetRequest& request) override;
    [[nodiscard]] std::unique_ptr<assets::AssetPreparationTask<assets::ShaderProgramAsset>>
    create_shader_program_preparation_task(
        const assets::ShaderProgramAssetRequest& request) override;
    [[nodiscard]] assets::AssetLoadResult<assets::MaterialAsset>
    load_material(const assets::MaterialAssetRequest& request) override;
    [[nodiscard]] std::unique_ptr<assets::AssetPreparationTask<assets::MaterialAsset>>
    create_material_preparation_task(const assets::MaterialAssetRequest& request) override;

private:
    struct CachedTexture {
        bgfx::TextureHandle handle = BGFX_INVALID_HANDLE;
        uint16_t width = 0;
        uint16_t height = 0;
        uint8_t mip_count = 1;
    };

    [[nodiscard]] assets::AssetLoadResult<assets::TextureAsset>
    load_decoded_texture(const assets::TextureAssetRequest& request);
    [[nodiscard]] core::Result<assets::PreparedAsset<assets::TextureAsset>, core::Diagnostics>
    finalize_texture_on_owner(PreparedTextureUpload prepared) noexcept override;
    [[nodiscard]] core::Result<assets::PreparedAsset<assets::ShaderProgramAsset>, core::Diagnostics>
    finalize_shader_program_on_owner(PreparedShaderProgram prepared) noexcept override;
    [[nodiscard]] core::Result<assets::PreparedAsset<assets::MaterialAsset>, core::Diagnostics>
    finalize_material_on_owner(assets::MaterialAssetRequest request, MaterialDefinition material,
                               std::uint64_t prepared_cpu_bytes) noexcept override;

    const assets::AssetManager& m_assets;
    BgfxShaderProgramCache& m_programs;
    const ShaderMaterialProject* m_shader_materials = nullptr;
    bgfx::TextureHandle m_fallback_texture = BGFX_INVALID_HANDLE;
    std::unordered_map<std::string, CachedTexture> m_textures;
};

} // namespace noveltea::bgfx_backend
