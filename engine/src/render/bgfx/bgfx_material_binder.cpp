#include "render/bgfx/bgfx_material_binder.hpp"

#include <SDL3/SDL_log.h>

#include <algorithm>
#include <cstdint>
#include <iterator>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <variant>

namespace noveltea::bgfx_backend {
namespace {

constexpr std::string_view draw_texture_source = "$draw.texture";

void add_diagnostic(std::vector<ShaderProgramDiagnostic>* diagnostics,
                    ShaderProgramDiagnosticCode code, std::string context, std::string message)
{
    if (diagnostics != nullptr)
        diagnostics->push_back(
            ShaderProgramDiagnostic{code, std::move(context), std::move(message)});
}

[[nodiscard]] std::string material_context(const MaterialId& material_id)
{
    return "engine-2d material '" + material_id.value() + "'";
}

[[nodiscard]] const MaterialUniformAssignment*
find_uniform_assignment(const MaterialDefinition& material, std::string_view name)
{
    const auto found = std::find_if(
        material.uniforms.begin(), material.uniforms.end(),
        [name](const MaterialUniformAssignment& assignment) { return assignment.name == name; });
    return found == material.uniforms.end() ? nullptr : &*found;
}

[[nodiscard]] const MaterialTextureAssignment*
find_texture_assignment(const MaterialDefinition& material, std::string_view name)
{
    const auto found = std::find_if(
        material.textures.begin(), material.textures.end(),
        [name](const MaterialTextureAssignment& assignment) { return assignment.sampler == name; });
    return found == material.textures.end() ? nullptr : &*found;
}

[[nodiscard]] bool starts_with(std::string_view value, std::string_view prefix) noexcept
{
    return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

[[nodiscard]] std::optional<std::string> read_asset_text(const assets::AssetManager& assets,
                                                         std::string_view source)
{
    const auto bytes = assets.read_binary(source);
    if (!bytes)
        return std::nullopt;
    return std::string(bytes.value->bytes.begin(), bytes.value->bytes.end());
}

[[nodiscard]] bgfx::TextureHandle load_ppm_texture(const assets::AssetManager& assets,
                                                   std::string_view source,
                                                   MaterialTextureSampler sampler)
{
    const auto text = read_asset_text(assets, source);
    if (!text)
        return BGFX_INVALID_HANDLE;

    std::istringstream in(*text);
    std::string magic;
    int width = 0;
    int height = 0;
    int max_value = 0;
    in >> magic >> width >> height >> max_value;
    if (magic != "P3" || width <= 0 || height <= 0 || max_value <= 0)
        return BGFX_INVALID_HANDLE;

    std::vector<uint32_t> pixels(static_cast<std::size_t>(width * height));
    for (int i = 0; i < width * height; ++i) {
        int r = 0;
        int g = 0;
        int b = 0;
        if (!(in >> r >> g >> b))
            return BGFX_INVALID_HANDLE;
        const auto scale = [max_value](int value) -> uint32_t {
            if (value < 0)
                value = 0;
            if (value > max_value)
                value = max_value;
            return static_cast<uint32_t>((value * 255) / max_value);
        };
        pixels[static_cast<std::size_t>(i)] =
            0xff000000u | (scale(b) << 16) | (scale(g) << 8) | scale(r);
    }

    return bgfx::createTexture2D(
        static_cast<uint16_t>(width), static_cast<uint16_t>(height), false, 1,
        bgfx::TextureFormat::RGBA8, bgfx_sampler_flags(sampler),
        bgfx::copy(pixels.data(), static_cast<uint32_t>(pixels.size() * sizeof(uint32_t))));
}

[[nodiscard]] bool has_texture_assignment_for_sampler(const MaterialDefinition& material,
                                                      std::string_view sampler)
{
    return find_texture_assignment(material, sampler) != nullptr;
}

} // namespace

uint64_t bgfx_sampler_flags(MaterialTextureSampler sampler) noexcept
{
    uint64_t flags = 0;
    switch (sampler) {
    case MaterialTextureSampler::ClampNearest:
        flags = BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP | BGFX_SAMPLER_MIN_POINT |
                BGFX_SAMPLER_MAG_POINT | BGFX_SAMPLER_MIP_POINT;
        break;
    case MaterialTextureSampler::ClampLinear:
        flags = BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
        break;
    case MaterialTextureSampler::RepeatNearest:
        flags = BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT | BGFX_SAMPLER_MIP_POINT;
        break;
    case MaterialTextureSampler::RepeatLinear:
        flags = 0;
        break;
    }
    return flags;
}

PackedMaterialUniform pack_material_uniform(const ShaderUniformValue& value) noexcept
{
    PackedMaterialUniform packed;
    if (const auto* scalar = std::get_if<float>(&value)) {
        packed.value = {*scalar, 0.0f, 0.0f, 0.0f};
        packed.supported = true;
    } else if (const auto* vec2 = std::get_if<std::array<float, 2>>(&value)) {
        packed.value = {(*vec2)[0], (*vec2)[1], 0.0f, 0.0f};
        packed.supported = true;
    } else if (const auto* vec3 = std::get_if<std::array<float, 3>>(&value)) {
        packed.value = {(*vec3)[0], (*vec3)[1], (*vec3)[2], 0.0f};
        packed.supported = true;
    } else if (const auto* vec4 = std::get_if<std::array<float, 4>>(&value)) {
        packed.value = *vec4;
        packed.supported = true;
    } else if (const auto* color = std::get_if<ShaderColor>(&value)) {
        packed.value = {color->r, color->g, color->b, color->a};
        packed.supported = true;
    } else if (const auto* integer = std::get_if<int>(&value)) {
        packed.value = {static_cast<float>(*integer), 0.0f, 0.0f, 0.0f};
        packed.supported = true;
    } else if (const auto* boolean = std::get_if<bool>(&value)) {
        packed.value = {*boolean ? 1.0f : 0.0f, 0.0f, 0.0f, 0.0f};
        packed.supported = true;
    }
    return packed;
}

BgfxMaterialBinder::BgfxMaterialBinder(const assets::AssetManager& assets,
                                       BgfxShaderProgramCache& programs,
                                       bgfx::TextureHandle fallback_texture)
    : m_assets(assets), m_programs(programs), m_fallback_texture(fallback_texture)
{
}

BgfxMaterialBinder::~BgfxMaterialBinder() { clear(); }

void BgfxMaterialBinder::clear()
{
    for (auto& [name, texture] : m_textures) {
        if (bgfx::isValid(texture))
            bgfx::destroy(texture);
    }
    m_textures.clear();

    for (auto& [name, sampler] : m_samplers) {
        if (bgfx::isValid(sampler))
            bgfx::destroy(sampler);
    }
    m_samplers.clear();

    for (auto& [name, uniform] : m_uniforms) {
        if (bgfx::isValid(uniform))
            bgfx::destroy(uniform);
    }
    m_uniforms.clear();
}

bgfx::UniformHandle BgfxMaterialBinder::uniform_handle(std::string_view name)
{
    const std::string key(name);
    if (const auto found = m_uniforms.find(key); found != m_uniforms.end())
        return found->second;
    const auto handle = bgfx::createUniform(key.c_str(), bgfx::UniformType::Vec4);
    m_uniforms.emplace(key, handle);
    return handle;
}

bgfx::UniformHandle BgfxMaterialBinder::sampler_handle(std::string_view name)
{
    const std::string key(name);
    if (const auto found = m_samplers.find(key); found != m_samplers.end())
        return found->second;
    const auto handle = bgfx::createUniform(key.c_str(), bgfx::UniformType::Sampler);
    m_samplers.emplace(key, handle);
    return handle;
}

bgfx::TextureHandle
BgfxMaterialBinder::texture_for_source(std::string_view source, const QuadCommand& command,
                                       MaterialTextureSampler sampler,
                                       std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    if (source == draw_texture_source) {
        const auto draw_texture = bgfx::TextureHandle{command.texture.handle};
        if (command.texture.valid() && bgfx::isValid(draw_texture))
            return draw_texture;
        return m_fallback_texture;
    }

    const std::string key = std::string(source) + "|" + std::string(to_string(sampler));
    if (const auto found = m_textures.find(key); found != m_textures.end())
        return found->second;

    if (!starts_with(source, "project:/") && !starts_with(source, "system:/")) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, {},
                       "unsupported material texture source '" + std::string(source) + "'");
        return m_fallback_texture;
    }

    const auto texture = load_ppm_texture(m_assets, source, sampler);
    if (!bgfx::isValid(texture)) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, {},
                       "failed to load material texture source '" + std::string(source) +
                           "' as an ASCII PPM texture");
        return m_fallback_texture;
    }
    m_textures.emplace(key, texture);
    return texture;
}

BgfxMaterialBindResult BgfxMaterialBinder::bind_engine_2d_material(
    const ShaderMaterialProject& project, const MaterialId& material_id, const QuadCommand& command,
    std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    const auto* material = find_material(project, material_id);
    if (material == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::UnknownMaterial,
                       material_context(material_id), "unknown engine-2d material");
        return {};
    }
    if (material->role != ShaderRole::Engine2D) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::IncompatibleShaderRole,
                       material_context(material_id),
                       "material role is '" + std::string(to_string(material->role)) +
                           "', expected 'engine-2d'");
        return {};
    }

    const auto resolved =
        resolve_material_shader_program(project, material_id, m_programs.active_variant());
    if (!resolved.program) {
        if (diagnostics != nullptr) {
            diagnostics->insert(diagnostics->end(), resolved.diagnostics.begin(),
                                resolved.diagnostics.end());
        }
        return {};
    }

    const bgfx::ProgramHandle program = m_programs.load_program(*resolved.program, diagnostics);
    if (!bgfx::isValid(program))
        return {};

    for (const auto& uniform : resolved.program->uniforms) {
        const MaterialUniformAssignment* assignment =
            find_uniform_assignment(*material, uniform.name);
        const ShaderUniformValue* value =
            assignment != nullptr ? &assignment->value : &uniform.default_value;
        if (uniform.name == "u_useTexture" && std::holds_alternative<std::monostate>(*value) &&
            has_texture_assignment_for_sampler(*material, "s_texColor")) {
            const auto use_texture = bgfx::isValid(bgfx::TextureHandle{command.texture.handle}) ||
                                     bgfx::isValid(m_fallback_texture);
            const std::array<float, 4> packed = {use_texture ? 1.0f : 0.0f, 0.0f, 0.0f, 0.0f};
            bgfx::setUniform(uniform_handle(uniform.name), packed.data());
            continue;
        }
        const auto packed = pack_material_uniform(*value);
        if (!packed.supported)
            continue;
        bgfx::setUniform(uniform_handle(uniform.name), packed.value.data());
    }

    uint8_t texture_stage = 0;
    for (const auto& sampler : resolved.program->samplers) {
        const auto* assignment = find_texture_assignment(*material, sampler.name);
        if (assignment == nullptr)
            continue;
        const auto texture =
            texture_for_source(assignment->source, command, assignment->filtering, diagnostics);
        if (!bgfx::isValid(texture))
            continue;
        bgfx::setTexture(texture_stage++, sampler_handle(sampler.name), texture,
                         bgfx_sampler_flags(assignment->filtering));
    }

    return BgfxMaterialBindResult{.program = program, .ok = true};
}

} // namespace noveltea::bgfx_backend
