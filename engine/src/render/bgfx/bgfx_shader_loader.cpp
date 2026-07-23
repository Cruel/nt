#include "render/bgfx/bgfx_shader_loader.hpp"

#include <SDL3/SDL_log.h>

#include <cstdint>
#include <cstdio>

namespace noveltea::bgfx_backend {

BgfxShaderLoader::BgfxShaderLoader(const assets::AssetManager& assets) : m_assets(assets) {}

const char* system_shader_name(SystemShader shader)
{
    switch (shader) {
    case SystemShader::Triangle:
        return "triangle";
    case SystemShader::Quad:
        return "quad";
    case SystemShader::Text:
        return "text";
    case SystemShader::RmlUi:
        return "rmlui";
    case SystemShader::RmlUiComposite:
        return "rmlui_composite";
    case SystemShader::RmlUiCompositeFilter:
        return "rmlui_composite_filter";
    case SystemShader::RmlUiCopy:
        return "rmlui_copy";
    case SystemShader::RmlUiOpacity:
        return "rmlui_opacity";
    case SystemShader::RmlUiColorMatrix:
        return "rmlui_color_matrix";
    case SystemShader::RmlUiMaskMultiply:
        return "rmlui_mask_multiply";
    case SystemShader::RmlUiBlur:
        return "rmlui_blur";
    case SystemShader::RmlUiDropShadow:
        return "rmlui_drop_shadow";
    case SystemShader::RmlUiGradient:
        return "rmlui_gradient";
    case SystemShader::ImGui:
        return "imgui";
    }
    return "";
}

const char* BgfxShaderLoader::shader_variant() const
{
    return shader_variant_for_renderer(bgfx::getRendererType(),
#if defined(NOVELTEA_PLATFORM_WEB)
                                       true
#else
                                       false
#endif
    );
}

const char* shader_variant_for_renderer(bgfx::RendererType::Enum renderer, bool web_platform)
{
    switch (renderer) {
    case bgfx::RendererType::OpenGL:
        return "glsl-120";
    case bgfx::RendererType::OpenGLES:
        return web_platform ? "essl-100" : "essl-300";
    default:
        return "";
    }
}

std::string BgfxShaderLoader::system_shader_base(std::string_view name) const
{
    return "system:/shaders/bgfx/" + std::string(shader_variant()) + "/" + std::string(name);
}

std::string BgfxShaderLoader::shader_path(std::string_view logical_base, ShaderStage stage) const
{
    const char* stage_suffix = stage == ShaderStage::Vertex ? "vs" : "fs";
    return std::string(logical_base) + "." + stage_suffix + ".bin";
}

bgfx::ShaderHandle BgfxShaderLoader::load_shader_binary(std::string_view name,
                                                        ShaderStage stage) const
{
    return load_shader_binary_path(shader_path(name, stage));
}

bgfx::ShaderHandle BgfxShaderLoader::load_shader_binary_path(std::string_view path) const
{
    if (shader_variant()[0] == '\0') {
        std::fprintf(stderr, "[shader] unsupported bgfx renderer for packaged shaders: %s\n",
                     bgfx::getRendererName(bgfx::getRendererType()));
        return BGFX_INVALID_HANDLE;
    }
    auto read = m_assets.read_binary(path);
    if (!read || read.value->bytes.empty() || read.value->bytes.size() > UINT32_MAX) {
        std::fprintf(stderr, "[shader] failed to read %.*s variant:%s renderer:%s error:%s\n",
                     static_cast<int>(path.size()), path.data(), shader_variant(),
                     bgfx::getRendererName(bgfx::getRendererType()), read.error.message.c_str());
        return BGFX_INVALID_HANDLE;
    }

    const bgfx::Memory* memory =
        bgfx::copy(read.value->bytes.data(), static_cast<uint32_t>(read.value->bytes.size()));
    bgfx::ShaderHandle shader = bgfx::createShader(memory);
    if (!bgfx::isValid(shader)) {
        std::fprintf(stderr, "[shader] bgfx failed to create shader from %.*s\n",
                     static_cast<int>(path.size()), path.data());
    }
    return shader;
}

bgfx::ProgramHandle BgfxShaderLoader::load_resolved_program(std::string_view name) const
{
    bgfx::ShaderHandle vs = load_shader_binary(name, ShaderStage::Vertex);
    bgfx::ShaderHandle fs = load_shader_binary(name, ShaderStage::Fragment);
    if (!bgfx::isValid(vs) || !bgfx::isValid(fs)) {
        if (bgfx::isValid(vs))
            bgfx::destroy(vs);
        if (bgfx::isValid(fs))
            bgfx::destroy(fs);
        return BGFX_INVALID_HANDLE;
    }

    bgfx::ProgramHandle program = bgfx::createProgram(vs, fs, true);
    if (!bgfx::isValid(program)) {
        std::fprintf(stderr, "[shader] failed to create program '%.*s'\n",
                     static_cast<int>(name.size()), name.data());
        bgfx::destroy(vs);
        bgfx::destroy(fs);
    }
    return program;
}

bgfx::ProgramHandle BgfxShaderLoader::load_program(SystemShader shader) const
{
    return load_system_program(shader);
}

bgfx::ProgramHandle BgfxShaderLoader::load_system_program(SystemShader shader) const
{
    return load_resolved_program(system_shader_base(system_shader_name(shader)));
}

bgfx::ProgramHandle BgfxShaderLoader::load_project_program(std::string_view shader_id) const
{
    return load_resolved_program("project:/shaders/bgfx/" + std::string(shader_variant()) + "/" +
                                 std::string(shader_id));
}

} // namespace noveltea::bgfx_backend
