#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/render/quad_batch.hpp"
#include "noveltea/render/shader_manifest.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"

#include <bgfx/bgfx.h>

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea::bgfx_backend {

struct PackedMaterialUniform {
    std::array<float, 4> value{};
    bool supported = false;
};

[[nodiscard]] uint64_t bgfx_sampler_flags(MaterialTextureSampler sampler) noexcept;
[[nodiscard]] PackedMaterialUniform pack_material_uniform(const ShaderUniformValue& value) noexcept;

struct BgfxMaterialBindInputs {
    ShaderRole role = ShaderRole::Engine2D;
    const QuadCommand* quad_command = nullptr;
    bgfx::TextureHandle glyph_atlas = BGFX_INVALID_HANDLE;
    ShaderStandardInputs standard_inputs{};
    uint8_t first_texture_stage = 0;
};

struct BgfxMaterialBindResult {
    bgfx::ProgramHandle program = BGFX_INVALID_HANDLE;
    bool ok = false;
};

class BgfxMaterialBinder {
public:
    BgfxMaterialBinder(const assets::AssetManager& assets, BgfxShaderProgramCache& programs,
                       bgfx::TextureHandle fallback_texture);
    ~BgfxMaterialBinder();

    BgfxMaterialBinder(const BgfxMaterialBinder&) = delete;
    BgfxMaterialBinder& operator=(const BgfxMaterialBinder&) = delete;

    [[nodiscard]] BgfxMaterialBindResult
    bind_material(const ShaderMaterialProject& project, const MaterialId& material_id,
                  const BgfxMaterialBindInputs& inputs,
                  std::vector<ShaderProgramDiagnostic>* diagnostics = nullptr);

    [[nodiscard]] BgfxMaterialBindResult
    bind_engine_2d_material(const ShaderMaterialProject& project, const MaterialId& material_id,
                            const QuadCommand& command,
                            std::vector<ShaderProgramDiagnostic>* diagnostics = nullptr);

    void bind_standard_uniforms(const ShaderProgramResolution& program,
                                const ShaderStandardInputs& inputs);

    [[nodiscard]] bgfx::UniformHandle sampler_handle_for(std::string_view name)
    {
        return sampler_handle(name);
    }

    void clear();

private:
    [[nodiscard]] bgfx::UniformHandle uniform_handle(std::string_view name);
    [[nodiscard]] bgfx::UniformHandle sampler_handle(std::string_view name);
    [[nodiscard]] bgfx::TextureHandle
    texture_for_source(std::string_view source, const QuadCommand* command,
                       MaterialTextureSampler sampler,
                       std::vector<ShaderProgramDiagnostic>* diagnostics);

    const assets::AssetManager& m_assets;
    BgfxShaderProgramCache& m_programs;
    bgfx::TextureHandle m_fallback_texture = BGFX_INVALID_HANDLE;
    std::unordered_map<std::string, bgfx::UniformHandle> m_uniforms;
    std::unordered_map<std::string, bgfx::UniformHandle> m_samplers;
    std::unordered_map<std::string, bgfx::TextureHandle> m_textures;
};

} // namespace noveltea::bgfx_backend
