#include "render/bgfx/bgfx_shader_program_cache.hpp"

#include <cstdio>
#include <utility>

namespace noveltea::bgfx_backend {
namespace {

void add_program_diagnostic(std::vector<ShaderProgramDiagnostic>* diagnostics,
                            ShaderProgramDiagnosticCode code, std::string context,
                            std::string message)
{
    if (diagnostics != nullptr)
        diagnostics->push_back(
            ShaderProgramDiagnostic{code, std::move(context), std::move(message)});
}

[[nodiscard]] std::string program_context(const ShaderProgramResolution& resolution)
{
    if (resolution.key.kind == ShaderProgramRequestKind::Material) {
        return "material '" + resolution.key.material_id + "' role '" +
               std::string(to_string(resolution.key.role)) + "' variant '" +
               resolution.key.variant + "'";
    }
    return "direct shader pair vertex '" + resolution.key.vertex_shader.value() + "' fragment '" +
           resolution.key.fragment_shader.value() + "' variant '" + resolution.key.variant + "'";
}

} // namespace

BgfxShaderProgramCache::BgfxShaderProgramCache(const assets::AssetManager& assets)
    : m_loader(assets)
{
}

BgfxShaderProgramCache::~BgfxShaderProgramCache() { clear(); }

bgfx::ProgramHandle
BgfxShaderProgramCache::load_program(const ShaderProgramResolution& resolution,
                                     std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    const std::string key = shader_program_cache_key(resolution.key);
    if (const auto found = m_programs.find(key); found != m_programs.end())
        return found->second;

    const std::string context = program_context(resolution);
    bgfx::ShaderHandle vs = m_loader.load_shader_binary_path(resolution.vertex.path);
    if (!bgfx::isValid(vs)) {
        add_program_diagnostic(
            diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, context,
            "failed to load vertex shader binary '" + resolution.vertex.path + "'");
        return BGFX_INVALID_HANDLE;
    }

    bgfx::ShaderHandle fs = m_loader.load_shader_binary_path(resolution.fragment.path);
    if (!bgfx::isValid(fs)) {
        add_program_diagnostic(
            diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, context,
            "failed to load fragment shader binary '" + resolution.fragment.path + "'");
        bgfx::destroy(vs);
        return BGFX_INVALID_HANDLE;
    }

    bgfx::ProgramHandle program = bgfx::createProgram(vs, fs, true);
    if (!bgfx::isValid(program)) {
        add_program_diagnostic(
            diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, context,
            "bgfx failed to create program from vertex shader '" + resolution.vertex.path +
                "' and fragment shader '" + resolution.fragment.path + "'");
        std::fprintf(stderr, "[shader] failed to create runtime program %s\n", context.c_str());
        bgfx::destroy(vs);
        bgfx::destroy(fs);
        return BGFX_INVALID_HANDLE;
    }

    m_programs.emplace(key, program);
    return program;
}

void BgfxShaderProgramCache::clear()
{
    for (auto& [key, program] : m_programs) {
        if (bgfx::isValid(program))
            bgfx::destroy(program);
    }
    m_programs.clear();
}

} // namespace noveltea::bgfx_backend
