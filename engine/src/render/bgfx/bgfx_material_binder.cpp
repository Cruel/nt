#include "render/bgfx/bgfx_material_binder.hpp"

#include <SDL3/SDL_log.h>

#include <algorithm>
#include <cstdint>
#include <iterator>
#include <optional>
#include <string>
#include <utility>
#include <variant>

namespace noveltea::bgfx_backend {
namespace {

constexpr std::string_view draw_texture_source = "$draw.texture";
constexpr std::string_view glyph_atlas_sampler = "s_textAtlas";
constexpr std::string_view legacy_glyph_atlas_sampler = "s_glyphAtlas";

void add_diagnostic(std::vector<ShaderProgramDiagnostic>* diagnostics,
                    ShaderProgramDiagnosticCode code, std::string context, std::string message)
{
    if (diagnostics != nullptr)
        diagnostics->push_back(
            ShaderProgramDiagnostic{code, std::move(context), std::move(message)});
}

[[nodiscard]] std::string material_context(const MaterialId& material_id, ShaderRole role)
{
    return "material '" + material_id.string() + "' role '" + std::string(to_string(role)) + "'";
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

[[nodiscard]] bool is_glyph_atlas_sampler(std::string_view name) noexcept
{
    return name == glyph_atlas_sampler || name == legacy_glyph_atlas_sampler;
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

std::array<float, 4> pack_shader_standard_input(ShaderInputSemantic semantic,
                                                const ShaderStandardInputs& inputs,
                                                const QuadCommand* quad_command) noexcept
{
    switch (semantic) {
    case ShaderInputSemantic::EngineTime:
        return {inputs.time_seconds, 0.0f, 0.0f, 0.0f};
    case ShaderInputSemantic::EnginePaintDimensions:
    case ShaderInputSemantic::RmlUiPaintDimensions: {
        Vec2 dimensions = inputs.paint_dimensions;
        if ((dimensions.x <= 0.0f || dimensions.y <= 0.0f) && quad_command != nullptr) {
            dimensions = {quad_command->rect.width, quad_command->rect.height};
        }
        return {dimensions.x, dimensions.y, 0.0f, 0.0f};
    }
    case ShaderInputSemantic::EngineReferenceToWorldRasterScale:
        return {inputs.reference_to_world_raster_scale.x, inputs.reference_to_world_raster_scale.y,
                0.0f, 0.0f};
    case ShaderInputSemantic::EngineContextLogicalToUiRasterScale:
    case ShaderInputSemantic::RmlUiContextLogicalToUiRasterScale:
        return {inputs.context_logical_to_ui_raster_scale.x,
                inputs.context_logical_to_ui_raster_scale.y, 0.0f, 0.0f};
    case ShaderInputSemantic::EngineUiMediaQueryResolution:
    case ShaderInputSemantic::RmlUiMediaQueryResolution:
        return {inputs.ui_media_query_resolution, 0.0f, 0.0f, 0.0f};
    case ShaderInputSemantic::EngineViewportPixelDimensions:
    case ShaderInputSemantic::RmlUiViewportPixelDimensions:
        return {inputs.viewport_pixel_dimensions.x, inputs.viewport_pixel_dimensions.y, 0.0f, 0.0f};
    case ShaderInputSemantic::EnginePointerPosition:
        return {inputs.pointer_position.x, inputs.pointer_position.y, 0.0f, 0.0f};
    case ShaderInputSemantic::EnginePointerValid:
        return {inputs.pointer_valid ? 1.0f : 0.0f, 0.0f, 0.0f, 0.0f};
    }
    return {};
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
BgfxMaterialBinder::texture_for_source(std::string_view source, const QuadCommand* command,
                                       MaterialTextureSampler sampler,
                                       std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    if (source == draw_texture_source) {
        if (command != nullptr) {
            const auto draw_texture = bgfx::TextureHandle{command->texture.handle};
            if (command->texture.valid() && bgfx::isValid(draw_texture))
                return draw_texture;
        }
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

    const auto texture = m_assets.load_texture(
        assets::TextureAssetRequest{.path = std::string(source), .sampler = sampler});
    if (!texture || texture.value->handle == assets::invalid_typed_asset_handle) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, {},
                       "failed to load material texture source '" + std::string(source) +
                           "' through typed AssetManager texture loader");
        return m_fallback_texture;
    }

    const auto handle = bgfx::TextureHandle{texture.value->handle};
    if (!bgfx::isValid(handle)) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, {},
                       "typed AssetManager texture loader returned invalid handle for '" +
                           std::string(source) + "'");
        return m_fallback_texture;
    }
    m_textures.emplace(key, handle);
    return handle;
}

void BgfxMaterialBinder::bind_standard_uniforms(const ShaderProgramResolution& program,
                                                const ShaderStandardInputs& inputs)
{
    for (const auto& uniform : program.uniforms) {
        if (!uniform.binding) {
            continue;
        }
        const auto value = pack_shader_standard_input(*uniform.binding, inputs);
        bgfx::setUniform(uniform_handle(uniform.name), value.data());
    }
}

BgfxMaterialBindResult BgfxMaterialBinder::bind_material(
    const ShaderMaterialProject& project, const MaterialId& material_id,
    const BgfxMaterialBindInputs& inputs, std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    const auto material_asset =
        m_assets.load_material(assets::MaterialAssetRequest{.id = material_id.string()});
    const auto* material =
        material_asset ? material_asset.value->definition : find_material(project, material_id);
    if (material == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::UnknownMaterial,
                       material_context(material_id, inputs.role), "unknown material");
        return {};
    }
    if (material->role != inputs.role) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::IncompatibleShaderRole,
                       material_context(material_id, inputs.role),
                       "material role is '" + std::string(to_string(material->role)) +
                           "', expected '" + std::string(to_string(inputs.role)) + "'");
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

    const auto program_asset = m_assets.load_shader_program(
        assets::ShaderProgramAssetRequest{.resolution = *resolved.program});
    const bgfx::ProgramHandle program = program_asset
                                            ? bgfx::ProgramHandle{program_asset.value->handle}
                                            : bgfx::ProgramHandle{UINT16_MAX};
    if (!bgfx::isValid(program)) {
        if (!program_asset) {
            add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                           material_context(material_id, inputs.role), program_asset.error);
        }
        return {};
    }

    for (const auto& uniform : resolved.program->uniforms) {
        const MaterialUniformAssignment* assignment =
            find_uniform_assignment(*material, uniform.name);
        if (uniform.binding) {
            const auto value = pack_shader_standard_input(*uniform.binding, inputs.standard_inputs,
                                                          inputs.quad_command);
            bgfx::setUniform(uniform_handle(uniform.name), value.data());
            continue;
        }
        const ShaderUniformValue* value =
            assignment != nullptr ? &assignment->value : &uniform.default_value;
        if (inputs.role == ShaderRole::Engine2D && uniform.name == "u_useTexture" &&
            std::holds_alternative<std::monostate>(*value) &&
            has_texture_assignment_for_sampler(*material, "s_texColor")) {
            const bool use_texture =
                (inputs.quad_command != nullptr &&
                 bgfx::isValid(bgfx::TextureHandle{inputs.quad_command->texture.handle})) ||
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

    uint8_t texture_stage = inputs.first_texture_stage;
    for (const auto& sampler : resolved.program->samplers) {
        if (inputs.role == ShaderRole::ActiveText && is_glyph_atlas_sampler(sampler.name) &&
            bgfx::isValid(inputs.glyph_atlas)) {
            bgfx::setTexture(texture_stage++, sampler_handle(sampler.name), inputs.glyph_atlas,
                             BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP);
            continue;
        }

        const auto* assignment = find_texture_assignment(*material, sampler.name);
        if (assignment == nullptr)
            continue;
        const auto texture = texture_for_source(assignment->source, inputs.quad_command,
                                                assignment->filtering, diagnostics);
        if (!bgfx::isValid(texture))
            continue;
        bgfx::setTexture(texture_stage++, sampler_handle(sampler.name), texture,
                         bgfx_sampler_flags(assignment->filtering));
    }

    return BgfxMaterialBindResult{.program = program, .ok = true};
}

BgfxMaterialBindResult BgfxMaterialBinder::bind_engine_2d_material(
    const ShaderMaterialProject& project, const MaterialId& material_id, const QuadCommand& command,
    std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    return bind_material(project, material_id,
                         BgfxMaterialBindInputs{.role = ShaderRole::Engine2D,
                                                .quad_command = &command,
                                                .glyph_atlas = BGFX_INVALID_HANDLE,
                                                .standard_inputs = {},
                                                .first_texture_stage = 0},
                         diagnostics);
}

} // namespace noveltea::bgfx_backend
