#include "render/bgfx/bgfx_material_binder.hpp"

#include "noveltea/render/material_contract.hpp"

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

constexpr std::string_view engine_draw_texture_semantic = "engine.draw_texture";
constexpr std::string_view engine_postprocess_source_semantic = "engine.postprocess_source";
constexpr std::string_view engine_hotspot_image_semantic = "engine.hotspot_image";
constexpr std::string_view engine_hotspot_mask_semantic = "engine.hotspot_mask";
constexpr std::string_view engine_glyph_atlas_semantic = "engine.glyph_atlas";
constexpr std::string_view legacy_draw_texture_source = "$draw.texture";

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

[[nodiscard]] const MaterialContractSamplerSlot* find_contract_sampler(ShaderRole role,
                                                                       std::string_view sampler)
{
    const auto* contract = material_role_contract(to_string(role));
    if (contract == nullptr)
        return nullptr;
    const auto found = std::find_if(
        contract->samplers.begin(), contract->samplers.end(),
        [sampler](const MaterialContractSamplerSlot& slot) { return slot.name == sampler; });
    return found == contract->samplers.end() ? nullptr : &*found;
}

[[nodiscard]] bool has_single_policy(const MaterialContractPolicyValues& policy,
                                     std::string_view expected) noexcept
{
    return policy.count == 1 && policy.values[0] == expected;
}

[[nodiscard]] MaterialTextureSampler
clamp_with_source_filter(MaterialTextureSampler sampler) noexcept
{
    switch (sampler) {
    case MaterialTextureSampler::ClampNearest:
    case MaterialTextureSampler::RepeatNearest:
        return MaterialTextureSampler::ClampNearest;
    case MaterialTextureSampler::ClampLinear:
    case MaterialTextureSampler::RepeatLinear:
        return MaterialTextureSampler::ClampLinear;
    }
    return MaterialTextureSampler::ClampLinear;
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

MaterialTextureSampler resolve_draw_texture_sampler(MaterialTextureSampler material_sampler,
                                                    MaterialTextureSampler image_sampler) noexcept
{
    const bool repeat = material_sampler == MaterialTextureSampler::RepeatLinear ||
                        material_sampler == MaterialTextureSampler::RepeatNearest;
    const bool nearest = image_sampler == MaterialTextureSampler::ClampNearest ||
                         image_sampler == MaterialTextureSampler::RepeatNearest;
    if (repeat)
        return nearest ? MaterialTextureSampler::RepeatNearest
                       : MaterialTextureSampler::RepeatLinear;
    return nearest ? MaterialTextureSampler::ClampNearest : MaterialTextureSampler::ClampLinear;
}

ResolvedDrawTexture resolve_renderer_draw_texture(const QuadCommand* command,
                                                  bgfx::TextureHandle neutral_texture) noexcept
{
    ResolvedDrawTexture resolved{.texture = neutral_texture};
    if (command == nullptr)
        return resolved;

    resolved.sampler =
        resolve_draw_texture_sampler(MaterialTextureSampler::ClampLinear, command->texture_sampler);
    const auto draw_texture = bgfx::TextureHandle{command->texture.handle};
    if (command->texture.valid() && bgfx::isValid(draw_texture))
        resolved.texture = draw_texture;
    return resolved;
}

std::optional<uint64_t> material_pipeline_state(ShaderRole role) noexcept
{
    const auto* contract = material_role_contract(to_string(role));
    if (contract == nullptr || contract->pipeline_state.output_alpha != "premultiplied")
        return std::nullopt;

    constexpr uint64_t write_state = BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A;
    if (contract->pipeline_state.blend == "replace")
        return write_state;
    if (contract->pipeline_state.blend == "premultiplied-alpha")
        return write_state |
               BGFX_STATE_BLEND_FUNC(BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA);
    return std::nullopt;
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
    case ShaderInputSemantic::EnginePaintDimensions: {
        Vec2 dimensions = inputs.paint_dimensions;
        if ((dimensions.x <= 0.0f || dimensions.y <= 0.0f) && quad_command != nullptr) {
            dimensions = {quad_command->rect.width, quad_command->rect.height};
        }
        return {dimensions.x, dimensions.y, 0.0f, 0.0f};
    }
    case ShaderInputSemantic::EngineReferenceToWorldRasterScale:
        return {inputs.reference_to_world_raster_scale.x, inputs.reference_to_world_raster_scale.y,
                0.0f, 0.0f};
    case ShaderInputSemantic::EngineContextLogicalToRasterScale:
        return {inputs.context_logical_to_raster_scale.x, inputs.context_logical_to_raster_scale.y,
                0.0f, 0.0f};
    case ShaderInputSemantic::RmlUiMediaQueryResolution:
        return {inputs.rmlui_media_query_resolution, 0.0f, 0.0f, 0.0f};
    case ShaderInputSemantic::EngineViewportPixelDimensions:
        return {inputs.viewport_pixel_dimensions.x, inputs.viewport_pixel_dimensions.y, 0.0f, 0.0f};
    case ShaderInputSemantic::EnginePointerPosition:
        return {inputs.pointer_position.x, inputs.pointer_position.y, 0.0f, 0.0f};
    case ShaderInputSemantic::EnginePointerValid:
        return {inputs.pointer_valid ? 1.0f : 0.0f, 0.0f, 0.0f, 0.0f};
    case ShaderInputSemantic::EngineHotspotBounds:
        return inputs.hotspot_bounds;
    case ShaderInputSemantic::EngineHotspotHovered:
        return {inputs.hotspot_hovered ? 1.0f : 0.0f, 0.0f, 0.0f, 0.0f};
    case ShaderInputSemantic::EngineHotspotPressed:
        return {inputs.hotspot_pressed ? 1.0f : 0.0f, 0.0f, 0.0f, 0.0f};
    case ShaderInputSemantic::EngineHotspotImageDimensions:
        return {inputs.hotspot_image_dimensions.x, inputs.hotspot_image_dimensions.y, 0.0f, 0.0f};
    case ShaderInputSemantic::EngineHotspotMaskDimensions:
        return {inputs.hotspot_mask_dimensions.x, inputs.hotspot_mask_dimensions.y, 0.0f, 0.0f};
    }
    return {};
}

BgfxMaterialBinder::BgfxMaterialBinder(const assets::AssetManager& assets,
                                       BgfxShaderProgramCache& programs,
                                       bgfx::TextureHandle fallback_texture,
                                       bgfx::TextureHandle neutral_draw_texture)
    : m_assets(assets), m_programs(programs), m_fallback_texture(fallback_texture),
      m_neutral_draw_texture(neutral_draw_texture)
{
}

BgfxMaterialBinder::~BgfxMaterialBinder() { clear(); }

void BgfxMaterialBinder::clear()
{
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
    if (source == legacy_draw_texture_source) {
        if (command != nullptr) {
            const auto draw_texture = bgfx::TextureHandle{command->texture.handle};
            if (command->texture.valid() && bgfx::isValid(draw_texture))
                return draw_texture;
        }
        return m_fallback_texture;
    }

    if (!starts_with(source, "project:/") && !starts_with(source, "system:/")) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, {},
                       "unsupported material texture source '" + std::string(source) + "'");
        return m_fallback_texture;
    }

    const assets::TextureAssetRequest request{.path = std::string(source), .sampler = sampler};
    const auto* lease = m_assets.leased_texture_on_owner(request, m_asset_lookup_scope);
    if (lease == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, {},
                       "mandatory material texture lease is not resident for '" +
                           std::string(source) + "'");
        return m_fallback_texture;
    }
    lease->mark_used_on_owner();

    const auto handle = bgfx::TextureHandle{lease->asset().handle};
    if (!bgfx::isValid(handle)) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant, {},
                       "resident material texture lease contains an invalid handle for '" +
                           std::string(source) + "'");
        return m_fallback_texture;
    }
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

BgfxMaterialBindResult BgfxMaterialBinder::bind_resolved_material(
    const MaterialId& material_id, const MaterialDefinition& material,
    const ShaderProgramResolution& resolution, bgfx::ProgramHandle program,
    const BgfxMaterialBindInputs& inputs, std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    for (const auto& uniform : resolution.uniforms) {
        const MaterialUniformAssignment* assignment =
            find_uniform_assignment(material, uniform.name);
        if (uniform.binding) {
            const auto value = pack_shader_standard_input(*uniform.binding, inputs.standard_inputs,
                                                          inputs.quad_command);
            bgfx::setUniform(uniform_handle(uniform.name), value.data());
            continue;
        }
        const MaterialUniformOverride* occurrence_override = nullptr;
        const auto explicit_override = std::find_if(
            inputs.occurrence_uniform_overrides.begin(), inputs.occurrence_uniform_overrides.end(),
            [&](const MaterialUniformOverride& value) { return value.name == uniform.name; });
        if (explicit_override != inputs.occurrence_uniform_overrides.end()) {
            occurrence_override = &*explicit_override;
        } else if (inputs.quad_command != nullptr) {
            const auto found = std::find_if(
                inputs.quad_command->material_uniform_overrides.begin(),
                inputs.quad_command->material_uniform_overrides.end(),
                [&](const MaterialUniformOverride& value) { return value.name == uniform.name; });
            if (found != inputs.quad_command->material_uniform_overrides.end())
                occurrence_override = &*found;
        }
        const ShaderUniformValue* value =
            occurrence_override != nullptr
                ? &occurrence_override->value
                : (assignment != nullptr ? &assignment->value : &uniform.default_value);
        const auto packed = pack_material_uniform(*value);
        if (!packed.supported)
            continue;
        bgfx::setUniform(uniform_handle(uniform.name), packed.value.data());
    }

    for (const auto& sampler : resolution.samplers) {
        if (const auto* slot = find_contract_sampler(inputs.role, sampler.name);
            slot != nullptr && slot->semantic == engine_draw_texture_semantic) {
            const auto draw =
                resolve_renderer_draw_texture(inputs.quad_command, m_neutral_draw_texture);
            if (!bgfx::isValid(draw.texture)) {
                add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                               material_context(material_id, inputs.role),
                               "renderer-owned draw texture is unavailable");
                return {};
            }
            bgfx::setTexture(slot->stage, sampler_handle(sampler.name), draw.texture,
                             bgfx_sampler_flags(draw.sampler));
            continue;
        }
        if (const auto* slot = find_contract_sampler(inputs.role, sampler.name);
            slot != nullptr && slot->semantic == engine_postprocess_source_semantic) {
            if (!bgfx::isValid(inputs.postprocess_source)) {
                add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                               material_context(material_id, inputs.role),
                               "renderer-owned postprocess source is unavailable");
                return {};
            }
            bgfx::setTexture(slot->stage, sampler_handle(sampler.name), inputs.postprocess_source,
                             bgfx_sampler_flags(MaterialTextureSampler::ClampLinear));
            continue;
        }
        if (const auto* slot = find_contract_sampler(inputs.role, sampler.name);
            slot != nullptr && slot->source_ownership == "renderer" &&
            slot->semantic == engine_hotspot_image_semantic) {
            if (!has_single_policy(slot->address_policy, "clamp") ||
                !has_single_policy(slot->filter_policy, "inherit")) {
                add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::IncompatibleShaderRole,
                               material_context(material_id, inputs.role),
                               "hotspot image sampler contract has unsupported policy");
                return {};
            }
            if (!bgfx::isValid(inputs.hotspot_image)) {
                add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                               material_context(material_id, inputs.role),
                               "hotspot image binding is not resident");
                return {};
            }
            bgfx::setTexture(
                slot->stage, sampler_handle(sampler.name), inputs.hotspot_image,
                bgfx_sampler_flags(clamp_with_source_filter(inputs.hotspot_image_sampler)));
            continue;
        }
        if (const auto* slot = find_contract_sampler(inputs.role, sampler.name);
            slot != nullptr && slot->source_ownership == "renderer" &&
            slot->semantic == engine_hotspot_mask_semantic) {
            if (!has_single_policy(slot->address_policy, "clamp") ||
                !has_single_policy(slot->filter_policy, "nearest")) {
                add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::IncompatibleShaderRole,
                               material_context(material_id, inputs.role),
                               "hotspot mask sampler contract has unsupported policy");
                return {};
            }
            if (!bgfx::isValid(inputs.hotspot_mask)) {
                add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                               material_context(material_id, inputs.role),
                               "hotspot mask binding is not resident");
                return {};
            }
            bgfx::setTexture(slot->stage, sampler_handle(sampler.name), inputs.hotspot_mask,
                             bgfx_sampler_flags(MaterialTextureSampler::ClampNearest));
            continue;
        }
        if (const auto* slot = find_contract_sampler(inputs.role, sampler.name);
            slot != nullptr && slot->source_ownership == "renderer" &&
            slot->semantic == engine_glyph_atlas_semantic) {
            if (!has_single_policy(slot->address_policy, "clamp") ||
                !has_single_policy(slot->filter_policy, "linear")) {
                add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::IncompatibleShaderRole,
                               material_context(material_id, inputs.role),
                               "glyph atlas sampler contract has unsupported policy");
                return {};
            }
            if (!bgfx::isValid(inputs.glyph_atlas)) {
                add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                               material_context(material_id, inputs.role),
                               "glyph atlas binding is unavailable");
                return {};
            }
            bgfx::setTexture(slot->stage, sampler_handle(sampler.name), inputs.glyph_atlas,
                             bgfx_sampler_flags(MaterialTextureSampler::ClampLinear));
            continue;
        }

        const MaterialTextureOverride* occurrence_texture_override = nullptr;
        if (inputs.quad_command != nullptr) {
            const auto found = std::find_if(
                inputs.quad_command->material_texture_overrides.begin(),
                inputs.quad_command->material_texture_overrides.end(),
                [&](const MaterialTextureOverride& value) { return value.name == sampler.name; });
            if (found != inputs.quad_command->material_texture_overrides.end())
                occurrence_texture_override = &*found;
        }
        const auto* assignment = find_texture_assignment(material, sampler.name);
        if (assignment == nullptr && occurrence_texture_override == nullptr) {
            add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                           material_context(material_id, inputs.role),
                           "material sampler '" + sampler.name + "' has no texture source");
            if (bgfx::isValid(m_fallback_texture)) {
                bgfx::setTexture(sampler.stage, sampler_handle(sampler.name), m_fallback_texture,
                                 bgfx_sampler_flags(MaterialTextureSampler::ClampLinear));
            }
            continue;
        }
        const auto source = occurrence_texture_override != nullptr
                                ? std::string_view{occurrence_texture_override->source}
                                : std::string_view{assignment->source};
        const MaterialTextureSampler filtering =
            assignment != nullptr && assignment->source == legacy_draw_texture_source &&
                    inputs.quad_command != nullptr
                ? resolve_draw_texture_sampler(assignment->filtering,
                                               inputs.quad_command->texture_sampler)
                : (assignment != nullptr ? assignment->filtering
                                         : MaterialTextureSampler::ClampLinear);
        const auto texture = texture_for_source(source, inputs.quad_command, filtering, diagnostics);
        if (!bgfx::isValid(texture)) {
            if (bgfx::isValid(m_fallback_texture)) {
                bgfx::setTexture(sampler.stage, sampler_handle(sampler.name), m_fallback_texture,
                                 bgfx_sampler_flags(MaterialTextureSampler::ClampLinear));
            }
            continue;
        }
        bgfx::setTexture(sampler.stage, sampler_handle(sampler.name), texture,
                         bgfx_sampler_flags(filtering));
    }

    return BgfxMaterialBindResult{.program = program, .ok = true};
}

BgfxMaterialBindResult BgfxMaterialBinder::bind_material(
    const ShaderMaterialProject& project, const MaterialId& material_id,
    const BgfxMaterialBindInputs& inputs, std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    const auto* declared_material = find_material(project, material_id);
    if (declared_material == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::UnknownMaterial,
                       material_context(material_id, inputs.role), "unknown material");
        return {};
    }
    if (declared_material->role != inputs.role) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::IncompatibleShaderRole,
                       material_context(material_id, inputs.role),
                       "material role is '" + std::string(to_string(declared_material->role)) +
                           "', expected '" + std::string(to_string(inputs.role)) + "'");
        return {};
    }

    const assets::MaterialAssetRequest material_request{.id = material_id.string()};
    const auto* material_lease =
        m_assets.leased_material_on_owner(material_request, m_asset_lookup_scope);
    if (material_lease == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::UnknownMaterial,
                       material_context(material_id, inputs.role),
                       "mandatory material lease is not resident");
        return {};
    }
    material_lease->mark_used_on_owner();
    const auto* material = material_lease->asset().definition;
    if (material == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::UnknownMaterial,
                       material_context(material_id, inputs.role), "unknown material");
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

    const assets::ShaderProgramAssetRequest program_request{.resolution = *resolved.program};
    const auto* program_lease =
        m_assets.leased_shader_program_on_owner(program_request, m_asset_lookup_scope);
    if (program_lease == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                       material_context(material_id, inputs.role),
                       "mandatory shader-program lease is not resident");
        return {};
    }
    program_lease->mark_used_on_owner();
    const bgfx::ProgramHandle program{program_lease->asset().handle};
    if (!bgfx::isValid(program)) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                       material_context(material_id, inputs.role),
                       "resident shader-program lease contains an invalid handle");
        return {};
    }

    return bind_resolved_material(material_id, *material, *resolved.program, program, inputs,
                                  diagnostics);
}

BgfxMaterialBindResult
BgfxMaterialBinder::bind_system_material(const ShaderMaterialProject& project,
                                         const MaterialId& material_id, bgfx::ProgramHandle program,
                                         const BgfxMaterialBindInputs& inputs,
                                         std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    const auto* material = find_material(project, material_id);
    if (material == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::UnknownMaterial,
                       material_context(material_id, inputs.role), "unknown system material");
        return {};
    }
    if (material->role != inputs.role) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::IncompatibleShaderRole,
                       material_context(material_id, inputs.role),
                       "system material role is '" + std::string(to_string(material->role)) +
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
    if (!bgfx::isValid(program)) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                       material_context(material_id, inputs.role),
                       "built-in shader program is unavailable");
        return {};
    }
    return bind_resolved_material(material_id, *material, *resolved.program, program, inputs,
                                  diagnostics);
}

BgfxMaterialBindResult BgfxMaterialBinder::bind_engine_2d_material(
    const ShaderMaterialProject& project, const MaterialId& material_id, const QuadCommand& command,
    std::vector<ShaderProgramDiagnostic>* diagnostics)
{
    return bind_material(
        project, material_id,
        BgfxMaterialBindInputs{.role = ShaderRole::Engine2D,
                               .quad_command = &command,
                               .occurrence_uniform_overrides = command.material_uniform_overrides,
                               .glyph_atlas = BGFX_INVALID_HANDLE,
                               .standard_inputs = {},
                               .first_texture_stage = 0},
        diagnostics);
}

} // namespace noveltea::bgfx_backend
