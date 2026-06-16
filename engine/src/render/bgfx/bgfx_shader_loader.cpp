#include "render/bgfx/bgfx_shader_loader.hpp"

#include <SDL3/SDL_log.h>

#include <cstdio>

namespace noveltea::bgfx_backend {

BgfxShaderLoader::BgfxShaderLoader(const assets::AssetManager& assets)
    : m_assets(assets)
{
}

const char* system_shader_name(SystemShader shader)
{
    switch (shader) {
    case SystemShader::Triangle: return "triangle";
    case SystemShader::Quad: return "quad";
    case SystemShader::Text: return "text";
    case SystemShader::RmlUi: return "rmlui";
    case SystemShader::ImGui: return "imgui";
    }
    return "";
}

const char* BgfxShaderLoader::target_name() const
{
    switch (bgfx::getRendererType()) {
    case bgfx::RendererType::OpenGL:
        return "linux-glsl";
    case bgfx::RendererType::OpenGLES:
#if defined(NOVELTEA_PLATFORM_WEB)
        return "web-essl100";
#else
        return "android-essl";
#endif
    default:
        return "";
    }
}

std::string BgfxShaderLoader::shader_path(std::string_view name, ShaderStage stage) const
{
    const char* stage_suffix = stage == ShaderStage::Vertex ? "vs" : "fs";
    return "system:/shaders/bgfx/" + std::string(target_name()) + "/" + std::string(name) + "." + stage_suffix + ".bin";
}

bgfx::ShaderHandle BgfxShaderLoader::load_shader_binary(std::string_view name, ShaderStage stage) const
{
    const std::string path = shader_path(name, stage);
    auto read = m_assets.read_binary(path);
    if (!read || read->bytes.empty()) {
        std::fprintf(stderr, "[shader] failed to read %s: %s\n", path.c_str(), m_assets.last_error().c_str());
        return BGFX_INVALID_HANDLE;
    }

    const bgfx::Memory* memory = bgfx::copy(read->bytes.data(), static_cast<uint32_t>(read->bytes.size()));
    bgfx::ShaderHandle shader = bgfx::createShader(memory);
    if (!bgfx::isValid(shader)) {
        std::fprintf(stderr, "[shader] bgfx failed to create shader from %s\n", path.c_str());
    }
    return shader;
}

bgfx::ProgramHandle BgfxShaderLoader::load_program(std::string_view name) const
{
    bgfx::ShaderHandle vs = load_shader_binary(name, ShaderStage::Vertex);
    bgfx::ShaderHandle fs = load_shader_binary(name, ShaderStage::Fragment);
    if (!bgfx::isValid(vs) || !bgfx::isValid(fs)) {
        if (bgfx::isValid(vs)) bgfx::destroy(vs);
        if (bgfx::isValid(fs)) bgfx::destroy(fs);
        return BGFX_INVALID_HANDLE;
    }

    bgfx::ProgramHandle program = bgfx::createProgram(vs, fs, true);
    if (!bgfx::isValid(program)) {
        std::fprintf(stderr, "[shader] failed to create program '%.*s'\n", static_cast<int>(name.size()), name.data());
        bgfx::destroy(vs);
        bgfx::destroy(fs);
    }
    return program;
}

bgfx::ProgramHandle BgfxShaderLoader::load_program(SystemShader shader) const
{
    return load_program(system_shader_name(shader));
}

} // namespace noveltea::bgfx_backend
