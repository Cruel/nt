#include "noveltea/render/shader_manifest.hpp"

#include <algorithm>
#include <sstream>
#include <string>
#include <utility>

namespace noveltea {
namespace {

void add_diagnostic(std::vector<ShaderProgramDiagnostic>& diagnostics,
                    ShaderProgramDiagnosticCode code, std::string context, std::string message)
{
    diagnostics.push_back(ShaderProgramDiagnostic{code, std::move(context), std::move(message)});
}

[[nodiscard]] bool has_role(const ShaderDefinition& shader, ShaderRole role) noexcept
{
    return std::find(shader.roles.begin(), shader.roles.end(), role) != shader.roles.end();
}

[[nodiscard]] const ShaderRoleBinding* find_role_binding(const ShaderDefinition& shader,
                                                         ShaderRole role) noexcept
{
    for (const auto& binding : shader.role_bindings) {
        if (binding.role == role)
            return &binding;
    }
    return nullptr;
}

[[nodiscard]] const ShaderStageDefinition* find_stage(const ShaderDefinition& shader,
                                                      ShaderStage stage) noexcept
{
    for (const auto& stage_definition : shader.stages) {
        if (stage_definition.stage == stage)
            return &stage_definition;
    }
    return nullptr;
}

[[nodiscard]] const ShaderCompiledBinaryRef*
find_compiled_binary(const ShaderStageDefinition& stage, std::string_view variant) noexcept
{
    for (const auto& compiled : stage.compiled) {
        if (compiled.variant == variant)
            return &compiled;
    }
    return nullptr;
}

void append_unique_uniforms(std::vector<ShaderUniformDeclaration>& out,
                            const ShaderDefinition& shader)
{
    for (const auto& uniform : shader.uniforms) {
        const auto exists = std::find_if(out.begin(), out.end(), [&](const auto& existing) {
            return existing.name == uniform.name;
        });
        if (exists == out.end())
            out.push_back(uniform);
    }
}

void append_unique_samplers(std::vector<ShaderSamplerDeclaration>& out,
                            const ShaderDefinition& shader)
{
    for (const auto& sampler : shader.samplers) {
        const auto exists = std::find_if(out.begin(), out.end(), [&](const auto& existing) {
            return existing.name == sampler.name;
        });
        if (exists == out.end())
            out.push_back(sampler);
    }
}

[[nodiscard]] std::string stage_label(ShaderStage stage) { return std::string(to_string(stage)); }

[[nodiscard]] std::string role_label(ShaderRole role) { return std::string(to_string(role)); }

[[nodiscard]] std::string material_context(const MaterialId& material_id, ShaderRole role,
                                           std::string_view variant)
{
    std::ostringstream out;
    out << "material '" << material_id.string() << "' role '" << role_label(role) << "' variant '"
        << variant << "'";
    return out.str();
}

[[nodiscard]] std::string direct_context(const ShaderId& vertex_shader_id,
                                         const ShaderId& fragment_shader_id,
                                         std::string_view variant)
{
    std::ostringstream out;
    out << "direct shader pair vertex '" << vertex_shader_id.string() << "' fragment '"
        << fragment_shader_id.string() << "' variant '" << variant << "'";
    return out.str();
}

[[nodiscard]] std::optional<ShaderStageBinaryRef>
resolve_stage_binary(const ShaderMaterialProject& project, const ShaderId& shader_id,
                     ShaderStage stage, std::string_view active_variant, std::string_view context,
                     std::vector<ShaderProgramDiagnostic>& diagnostics)
{
    const ShaderDefinition* shader = find_shader(project, shader_id);
    if (shader == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::UnknownShader,
                       std::string(context),
                       "unknown " + stage_label(stage) + " shader id '" + shader_id.string() + "'");
        return std::nullopt;
    }

    const ShaderStageDefinition* stage_definition = find_stage(*shader, stage);
    if (stage_definition == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingShaderStage,
                       std::string(context),
                       "shader '" + shader_id.string() + "' has no " + stage_label(stage) +
                           " stage; expected binary path '" +
                           expected_shader_binary_path(shader_id, stage, active_variant) + "'");
        return std::nullopt;
    }

    const ShaderCompiledBinaryRef* compiled =
        find_compiled_binary(*stage_definition, active_variant);
    if (compiled == nullptr) {
        add_diagnostic(diagnostics, ShaderProgramDiagnosticCode::MissingCompiledVariant,
                       std::string(context),
                       "shader '" + shader_id.string() + "' " + stage_label(stage) +
                           " stage has no compiled binary for variant '" +
                           std::string(active_variant) + "'; expected binary path '" +
                           expected_shader_binary_path(shader_id, stage, active_variant) + "'");
        return std::nullopt;
    }

    ShaderStageBinaryRef ref;
    ref.shader = shader_id;
    ref.stage = stage;
    ref.variant = compiled->variant;
    ref.path = compiled->path;
    return ref;
}

[[nodiscard]] std::optional<ShaderProgramResolution>
make_resolution(const ShaderMaterialProject& project, ShaderProgramKey key,
                const ShaderId& vertex_shader_id, const ShaderId& fragment_shader_id,
                std::string_view context, std::vector<ShaderProgramDiagnostic>& diagnostics)
{
    auto vertex = resolve_stage_binary(project, vertex_shader_id, ShaderStage::Vertex, key.variant,
                                       context, diagnostics);
    auto fragment = resolve_stage_binary(project, fragment_shader_id, ShaderStage::Fragment,
                                         key.variant, context, diagnostics);
    if (!vertex || !fragment)
        return std::nullopt;

    key.vertex_shader = vertex_shader_id;
    key.fragment_shader = fragment_shader_id;
    key.vertex_path = vertex->path;
    key.fragment_path = fragment->path;

    ShaderProgramResolution resolution;
    resolution.key = std::move(key);
    resolution.vertex = std::move(*vertex);
    resolution.fragment = std::move(*fragment);

    if (const auto* vertex_shader = find_shader(project, vertex_shader_id)) {
        append_unique_uniforms(resolution.uniforms, *vertex_shader);
        append_unique_samplers(resolution.samplers, *vertex_shader);
    }
    if (const auto* fragment_shader = find_shader(project, fragment_shader_id)) {
        append_unique_uniforms(resolution.uniforms, *fragment_shader);
        append_unique_samplers(resolution.samplers, *fragment_shader);
    }

    return resolution;
}

} // namespace

ShaderProgramResolutionResult resolve_material_shader_program(const ShaderMaterialProject& project,
                                                              const MaterialId& material_id,
                                                              std::string_view active_variant)
{
    ShaderProgramResolutionResult result;
    if (active_variant.empty()) {
        add_diagnostic(
            result.diagnostics, ShaderProgramDiagnosticCode::UnsupportedActiveVariant,
            "material '" + material_id.string() + "'",
            "cannot resolve material shader program without an active compiled shader variant");
        return result;
    }

    const MaterialDefinition* material = find_material(project, material_id);
    if (material == nullptr) {
        add_diagnostic(result.diagnostics, ShaderProgramDiagnosticCode::UnknownMaterial,
                       "material '" + material_id.string() + "' variant '" +
                           std::string(active_variant) + "'",
                       "unknown material id '" + material_id.string() + "'");
        return result;
    }

    const ShaderDefinition* material_shader = find_shader(project, material->shader);
    const std::string context = material_context(material->id, material->role, active_variant);
    if (material_shader == nullptr) {
        add_diagnostic(result.diagnostics, ShaderProgramDiagnosticCode::UnknownShader, context,
                       "material references unknown shader id '" + material->shader.string() + "'");
        return result;
    }

    if (!has_role(*material_shader, material->role)) {
        add_diagnostic(result.diagnostics, ShaderProgramDiagnosticCode::IncompatibleShaderRole,
                       context,
                       "shader '" + material_shader->id.string() + "' does not declare role '" +
                           role_label(material->role) + "'");
        return result;
    }

    ShaderId vertex_shader_id = material_shader->id;
    ShaderId fragment_shader_id = material_shader->id;
    if (const ShaderRoleBinding* binding = find_role_binding(*material_shader, material->role)) {
        if (!binding->vertex_shader || !binding->fragment_shader) {
            add_diagnostic(result.diagnostics, ShaderProgramDiagnosticCode::IncompleteRoleBinding,
                           context,
                           "shader '" + material_shader->id.string() + "' role '" +
                               role_label(material->role) +
                               "' must provide both vertex and fragment shader ids");
            return result;
        }
        vertex_shader_id = *binding->vertex_shader;
        fragment_shader_id = *binding->fragment_shader;
    } else if (find_stage(*material_shader, ShaderStage::Vertex) == nullptr ||
               find_stage(*material_shader, ShaderStage::Fragment) == nullptr) {
        add_diagnostic(result.diagnostics, ShaderProgramDiagnosticCode::MissingRoleBinding, context,
                       "shader '" + material_shader->id.string() + "' role '" +
                           role_label(material->role) +
                           "' needs a role binding because the shader record does not contain both "
                           "vertex and fragment stages");
        return result;
    }

    ShaderProgramKey key;
    key.kind = ShaderProgramRequestKind::Material;
    key.material_id = material->id.string();
    key.role = material->role;
    key.material_shader = material->shader;
    key.variant = std::string(active_variant);

    result.program = make_resolution(project, std::move(key), vertex_shader_id, fragment_shader_id,
                                     context, result.diagnostics);
    return result;
}

ShaderProgramResolutionResult resolve_direct_shader_pair_program(
    const ShaderMaterialProject& project, const ShaderId& vertex_shader_id,
    const ShaderId& fragment_shader_id, std::string_view active_variant)
{
    ShaderProgramResolutionResult result;
    if (active_variant.empty()) {
        add_diagnostic(
            result.diagnostics, ShaderProgramDiagnosticCode::UnsupportedActiveVariant,
            direct_context(vertex_shader_id, fragment_shader_id, active_variant),
            "cannot resolve direct shader pair without an active compiled shader variant");
        return result;
    }

    const std::string context =
        direct_context(vertex_shader_id, fragment_shader_id, active_variant);
    ShaderProgramKey key;
    key.kind = ShaderProgramRequestKind::DirectShaderPair;
    key.role = ShaderRole::ActiveText;
    key.variant = std::string(active_variant);

    result.program = make_resolution(project, std::move(key), vertex_shader_id, fragment_shader_id,
                                     context, result.diagnostics);
    return result;
}

std::string shader_program_cache_key(const ShaderProgramKey& key)
{
    std::ostringstream out;
    out << to_string(key.kind) << '|';
    if (key.kind == ShaderProgramRequestKind::Material)
        out << key.material_id << '|' << to_string(key.role) << '|' << key.material_shader.string()
            << '|';
    out << key.vertex_shader.string() << '|' << key.fragment_shader.string() << '|' << key.variant
        << '|' << key.vertex_path << '|' << key.fragment_path;
    return out.str();
}

std::string expected_shader_binary_path(const ShaderId& shader_id, ShaderStage stage,
                                        std::string_view variant)
{
    const char* suffix = stage == ShaderStage::Vertex ? "vs" : "fs";
    return "shaders/bgfx/" + std::string(variant) + "/" + shader_id.string() + "." + suffix +
           ".bin";
}

std::string_view to_string(ShaderProgramRequestKind kind) noexcept
{
    switch (kind) {
    case ShaderProgramRequestKind::Material:
        return "material";
    case ShaderProgramRequestKind::DirectShaderPair:
        return "direct_shader_pair";
    }
    return "unknown";
}

std::string_view to_string(ShaderProgramDiagnosticCode code) noexcept
{
    switch (code) {
    case ShaderProgramDiagnosticCode::UnknownMaterial:
        return "unknown_material";
    case ShaderProgramDiagnosticCode::UnknownShader:
        return "unknown_shader";
    case ShaderProgramDiagnosticCode::IncompatibleShaderRole:
        return "incompatible_shader_role";
    case ShaderProgramDiagnosticCode::MissingRoleBinding:
        return "missing_role_binding";
    case ShaderProgramDiagnosticCode::IncompleteRoleBinding:
        return "incomplete_role_binding";
    case ShaderProgramDiagnosticCode::MissingShaderStage:
        return "missing_shader_stage";
    case ShaderProgramDiagnosticCode::MissingCompiledVariant:
        return "missing_compiled_variant";
    case ShaderProgramDiagnosticCode::UnsupportedActiveVariant:
        return "unsupported_active_variant";
    }
    return "unknown";
}

} // namespace noveltea
