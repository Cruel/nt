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
    RmlUiComposite,
    RmlUiCompositeFilter,
    RmlUiCopy,
    RmlUiOpacity,
    RmlUiColorMatrix,
    RmlUiMaskMultiply,
    RmlUiBlur,
    RmlUiDropShadow,
    RmlUiGradient,
    ImGui,
};

class BgfxShaderLoader {
public:
    explicit BgfxShaderLoader(const assets::AssetManager& assets);

    [[nodiscard]] bgfx::ShaderHandle load_shader_binary(std::string_view name,
                                                        ShaderStage stage) const;
    [[nodiscard]] bgfx::ProgramHandle load_resolved_program(std::string_view logical_base) const;
    [[nodiscard]] bgfx::ProgramHandle load_system_program(SystemShader shader) const;
    [[nodiscard]] bgfx::ProgramHandle load_project_program(std::string_view shader_id) const;
    [[nodiscard]] bgfx::ProgramHandle load_program(SystemShader shader) const;
    [[nodiscard]] const char* shader_variant() const;

private:
    [[nodiscard]] std::string shader_path(std::string_view logical_base, ShaderStage stage) const;
    [[nodiscard]] std::string system_shader_base(std::string_view name) const;

    const assets::AssetManager& m_assets;
};

[[nodiscard]] const char* system_shader_name(SystemShader shader);
[[nodiscard]] const char* shader_variant_for_renderer(bgfx::RendererType::Enum renderer,
                                                      bool web_platform);

} // namespace noveltea::bgfx_backend
