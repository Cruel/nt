#pragma once

#include "noveltea/assets/asset_manager.hpp"

#include <bgfx/bgfx.h>

#include <string>
#include <string_view>

namespace noveltea::bgfx_backend {

enum class ShaderStage {
    Vertex,
    Fragment,
};

enum class SystemShader {
    Triangle,
    Quad,
    Text,
    RmlUi,
    ImGui,
};

class BgfxShaderLoader {
public:
    explicit BgfxShaderLoader(const assets::AssetManager& assets);

    [[nodiscard]] bgfx::ShaderHandle load_shader_binary(std::string_view name, ShaderStage stage) const;
    [[nodiscard]] bgfx::ProgramHandle load_program(std::string_view name) const;
    [[nodiscard]] bgfx::ProgramHandle load_program(SystemShader shader) const;
    [[nodiscard]] const char* target_name() const;

private:
    [[nodiscard]] std::string shader_path(std::string_view name, ShaderStage stage) const;

    const assets::AssetManager& m_assets;
};

[[nodiscard]] const char* system_shader_name(SystemShader shader);

} // namespace noveltea::bgfx_backend
