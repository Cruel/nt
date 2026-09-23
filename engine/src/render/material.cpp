#include "noveltea/render/material.hpp"

#include "noveltea/render/material_contract.hpp"

#include "noveltea/core/rich_text.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cctype>
#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace noveltea {
namespace {

void add_diagnostic(std::vector<MaterialDiagnostic>& diagnostics, MaterialDiagnosticCode code,
                    std::string path, std::string message)
{
    diagnostics.push_back(MaterialDiagnostic{MaterialDiagnosticSeverity::Error, code,
                                             std::move(path), std::move(message)});
}

[[nodiscard]] bool valid_schema_segment(std::string_view segment)
{
    if (segment.empty() || segment == "." || segment == "..")
        return false;
    const auto first = static_cast<unsigned char>(segment.front());
    if (!(std::isalnum(first) || segment.front() == '_'))
        return false;
    return std::all_of(segment.begin() + 1, segment.end(), [](char c) {
        const auto ch = static_cast<unsigned char>(c);
        return std::isalnum(ch) || c == '_' || c == '-';
    });
}

[[nodiscard]] bool valid_schema_id(std::string_view value)
{
    if (value.empty() || value.front() == '/' || value.find('\\') != std::string_view::npos ||
        value.find(':') != std::string_view::npos || value.find("//") != std::string_view::npos ||
        value.find('.') != std::string_view::npos) {
        return false;
    }

    std::size_t start = 0;
    while (start <= value.size()) {
        const std::size_t slash = value.find('/', start);
        const std::string_view part =
            value.substr(start, slash == std::string_view::npos ? slash : slash - start);
        if (!valid_schema_segment(part))
            return false;
        if (slash == std::string_view::npos)
            break;
        start = slash + 1;
    }
    return true;
}

[[nodiscard]] const ShaderRoleBinding* find_role_binding(const ShaderDefinition& shader,
                                                         ShaderRole role) noexcept
{
    const auto found = std::find_if(shader.role_bindings.begin(), shader.role_bindings.end(),
                                    [&](const auto& value) { return value.role == role; });
    return found == shader.role_bindings.end() ? nullptr : &*found;
}

void append_unique_uniforms(std::vector<const ShaderUniformDeclaration*>& out,
                            const ShaderDefinition& shader)
{
    for (const auto& uniform : shader.uniforms) {
        const auto found = std::find_if(
            out.begin(), out.end(), [&](const auto* value) { return value->name == uniform.name; });
        if (found == out.end())
            out.push_back(&uniform);
    }
}

void append_unique_samplers(std::vector<const ShaderSamplerDeclaration*>& out,
                            const ShaderDefinition& shader)
{
    for (const auto& sampler : shader.samplers) {
        const auto found = std::find_if(
            out.begin(), out.end(), [&](const auto* value) { return value->name == sampler.name; });
        if (found == out.end())
            out.push_back(&sampler);
    }
}

[[nodiscard]] bool
collect_effective_interface(const ShaderMaterialProject& project,
                            const MaterialDefinition& material,
                            std::vector<const ShaderUniformDeclaration*>& uniforms,
                            std::vector<const ShaderSamplerDeclaration*>& samplers,
                            std::vector<MaterialDiagnostic>& diagnostics, std::string_view path)
{
    const auto* shader = find_shader(project, material.shader);
    if (shader == nullptr) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownShaderRef, std::string(path),
                       "ActiveText material '" + material.id.string() +
                           "' references unknown shader '" + material.shader.string() + "'");
        return false;
    }
    if (std::find(shader->roles.begin(), shader->roles.end(), ShaderRole::ActiveText) ==
        shader->roles.end()) {
        add_diagnostic(
            diagnostics, MaterialDiagnosticCode::IncompatibleShaderRole, std::string(path),
            "material '" + material.id.string() + "' shader does not declare the active-text role");
        return false;
    }

    if (const auto* binding = find_role_binding(*shader, ShaderRole::ActiveText)) {
        if (!binding->vertex_shader || !binding->fragment_shader) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::IncompatibleShaderRole,
                           std::string(path),
                           "material '" + material.id.string() +
                               "' has an incomplete active-text role binding");
            return false;
        }
        const auto* vertex = find_shader(project, *binding->vertex_shader);
        const auto* fragment = find_shader(project, *binding->fragment_shader);
        if (vertex == nullptr || fragment == nullptr) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownShaderRef, std::string(path),
                           "material '" + material.id.string() +
                               "' active-text role binding references an unknown shader");
            return false;
        }
        append_unique_uniforms(uniforms, *vertex);
        append_unique_uniforms(uniforms, *fragment);
        append_unique_samplers(samplers, *vertex);
        append_unique_samplers(samplers, *fragment);
    } else {
        append_unique_uniforms(uniforms, *shader);
        append_unique_samplers(samplers, *shader);
    }
    return true;
}

[[nodiscard]] std::optional<float> parse_float_literal(std::string_view value)
{
    std::string owned(value);
    char* end = nullptr;
    const float parsed = std::strtof(owned.c_str(), &end);
    if (end == owned.c_str() || end != owned.c_str() + owned.size() || !std::isfinite(parsed))
        return std::nullopt;
    return parsed;
}

[[nodiscard]] std::vector<std::string_view> split_tuple(std::string_view value)
{
    std::vector<std::string_view> parts;
    std::size_t start = 0;
    while (start <= value.size()) {
        const auto end = value.find(',', start);
        parts.push_back(value.substr(start, end == std::string_view::npos ? value.size() - start
                                                                          : end - start));
        if (end == std::string_view::npos)
            break;
        start = end + 1;
    }
    return parts;
}

template<std::size_t N>
[[nodiscard]] std::optional<std::array<float, N>> parse_float_tuple(std::string_view value)
{
    const auto parts = split_tuple(value);
    if (parts.size() != N)
        return std::nullopt;
    std::array<float, N> result{};
    for (std::size_t index = 0; index < N; ++index) {
        const auto parsed = parse_float_literal(parts[index]);
        if (!parsed)
            return std::nullopt;
        result[index] = *parsed;
    }
    return result;
}

[[nodiscard]] std::optional<core::RichTextMaterialColor> parse_color_literal(std::string_view value)
{
    if (value.size() == 9 && value.front() == '#') {
        const auto hex = [](char c) -> int {
            if (c >= '0' && c <= '9')
                return c - '0';
            if (c >= 'a' && c <= 'f')
                return c - 'a' + 10;
            if (c >= 'A' && c <= 'F')
                return c - 'A' + 10;
            return -1;
        };
        std::array<float, 4> channels{};
        for (std::size_t index = 0; index < channels.size(); ++index) {
            const int high = hex(value[1 + index * 2]);
            const int low = hex(value[2 + index * 2]);
            if (high < 0 || low < 0)
                return std::nullopt;
            channels[index] = static_cast<float>(high * 16 + low) / 255.0f;
        }
        return core::RichTextMaterialColor{channels[0], channels[1], channels[2], channels[3]};
    }
    const auto tuple = parse_float_tuple<4>(value);
    if (!tuple)
        return std::nullopt;
    return core::RichTextMaterialColor{(*tuple)[0], (*tuple)[1], (*tuple)[2], (*tuple)[3]};
}

[[nodiscard]] std::optional<core::RichTextMaterialValue>
parse_material_override_value(ShaderUniformType type, std::string_view value)
{
    switch (type) {
    case ShaderUniformType::Float:
        if (const auto parsed = parse_float_literal(value))
            return core::RichTextMaterialValue{*parsed};
        break;
    case ShaderUniformType::Vec2:
        if (const auto parsed = parse_float_tuple<2>(value))
            return core::RichTextMaterialValue{*parsed};
        break;
    case ShaderUniformType::Vec3:
        if (const auto parsed = parse_float_tuple<3>(value))
            return core::RichTextMaterialValue{*parsed};
        break;
    case ShaderUniformType::Vec4:
        if (const auto parsed = parse_float_tuple<4>(value))
            return core::RichTextMaterialValue{*parsed};
        break;
    case ShaderUniformType::Color:
        if (const auto parsed = parse_color_literal(value))
            return core::RichTextMaterialValue{*parsed};
        break;
    case ShaderUniformType::Int: {
        int parsed = 0;
        const auto result = std::from_chars(value.data(), value.data() + value.size(), parsed);
        if (result.ec == std::errc{} && result.ptr == value.data() + value.size() &&
            parsed >= -16777216 && parsed <= 16777216) {
            return core::RichTextMaterialValue{parsed};
        }
        break;
    }
    case ShaderUniformType::Bool:
        if (value == "true")
            return core::RichTextMaterialValue{true};
        if (value == "false")
            return core::RichTextMaterialValue{false};
        break;
    }
    return std::nullopt;
}

} // namespace

bool ShaderMaterialProjectParseResult::has_errors() const noexcept
{
    return std::any_of(diagnostics.begin(), diagnostics.end(), [](const MaterialDiagnostic& item) {
        return item.severity == MaterialDiagnosticSeverity::Error;
    });
}

ShaderIdParseResult parse_shader_id(std::string_view reference)
{
    ShaderIdParseResult result;
    if (!valid_schema_id(reference)) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidShaderId, "",
                       "shader id must be a safe project schema id, not a file path: " +
                           std::string(reference));
        return result;
    }
    result.id = ShaderId(std::string(reference));
    return result;
}

MaterialIdParseResult parse_material_id(std::string_view reference)
{
    MaterialIdParseResult result;
    if (!valid_schema_id(reference)) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidMaterialId, "",
                       "material id must be a safe project schema id, not a file path: " +
                           std::string(reference));
        return result;
    }
    result.id = MaterialId(std::string(reference));
    return result;
}

const ShaderDefinition* find_shader(const ShaderMaterialProject& project,
                                    const ShaderId& id) noexcept
{
    for (const auto& shader : project.shaders) {
        if (shader.id == id)
            return &shader;
    }
    return nullptr;
}

const MaterialDefinition* find_material(const ShaderMaterialProject& project,
                                        const MaterialId& id) noexcept
{
    for (const auto& material : project.materials) {
        if (material.id == id)
            return &material;
    }
    return nullptr;
}

std::vector<MaterialDiagnostic>
resolve_active_text_material_occurrences(const ShaderMaterialProject& project,
                                         core::RichTextDocument& document)
{
    std::vector<MaterialDiagnostic> diagnostics;
    for (std::size_t run_index = 0; run_index < document.runs.size(); ++run_index) {
        auto& style = document.runs[run_index].style;
        style.material_overrides.clear();
        if (style.material_id.empty())
            continue;

        const std::string run_path = "/runs/" + std::to_string(run_index) + "/style/material";
        const auto parsed_id = parse_material_id(style.material_id);
        if (!parsed_id.id) {
            for (const auto& item : parsed_id.diagnostics) {
                add_diagnostic(diagnostics, item.code, run_path + "/id", item.message);
            }
            continue;
        }
        const auto* material = find_material(project, *parsed_id.id);
        if (material == nullptr) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownMaterialRef,
                           run_path + "/id",
                           "unknown ActiveText material '" + style.material_id + "'");
            continue;
        }
        if (material->role != ShaderRole::ActiveText) {
            add_diagnostic(
                diagnostics, MaterialDiagnosticCode::IncompatibleShaderRole, run_path + "/id",
                "material '" + style.material_id + "' has role '" +
                    std::string(to_string(material->role)) + "', expected 'active-text'");
            continue;
        }

        std::vector<const ShaderUniformDeclaration*> uniforms;
        std::vector<const ShaderSamplerDeclaration*> samplers;
        if (!collect_effective_interface(project, *material, uniforms, samplers, diagnostics,
                                         run_path + "/id")) {
            continue;
        }

        for (const auto& attribute : style.material_attributes) {
            const std::string attribute_path = run_path + "/" + attribute.name;
            const auto uniform =
                std::find_if(uniforms.begin(), uniforms.end(),
                             [&](const auto* item) { return item->name == attribute.name; });
            if (uniform == uniforms.end()) {
                const auto sampler =
                    std::find_if(samplers.begin(), samplers.end(),
                                 [&](const auto* item) { return item->name == attribute.name; });
                if (sampler != samplers.end()) {
                    add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidMaterialOverride,
                                   attribute_path,
                                   "ActiveText material occurrence cannot override sampler '" +
                                       attribute.name + "'");
                } else {
                    add_diagnostic(
                        diagnostics, MaterialDiagnosticCode::UndeclaredUniform, attribute_path,
                        "material '" + style.material_id + "' has no ordinary parameter named '" +
                            attribute.name + "'");
                }
                continue;
            }
            if ((*uniform)->binding) {
                add_diagnostic(
                    diagnostics, MaterialDiagnosticCode::RendererOwnedOverride, attribute_path,
                    "ActiveText material occurrence cannot override renderer or semantic input '" +
                        attribute.name + "'");
                continue;
            }
            const auto parsed = parse_material_override_value((*uniform)->type, attribute.value);
            if (!parsed) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidMaterialOverride,
                               attribute_path,
                               "invalid " + std::string(to_string((*uniform)->type)) + " value '" +
                                   attribute.value + "' for parameter '" + attribute.name + "'");
                continue;
            }
            style.material_overrides.push_back(
                core::RichTextMaterialOverride{attribute.name, *parsed});
        }
        std::sort(style.material_overrides.begin(), style.material_overrides.end(),
                  [](const auto& lhs, const auto& rhs) { return lhs.name < rhs.name; });
    }
    return diagnostics;
}

MaterialDefinition make_engine_2d_fallback_material()
{
    MaterialDefinition material;
    material.id = MaterialId("system/fallback/engine_2d_error");
    material.role = ShaderRole::Engine2D;
    material.shader = ShaderId("system/fallback/engine_2d_error");
    material.display_name = "Engine 2D Error Material";
    material.fallback = true;
    material.uniforms.push_back(
        MaterialUniformAssignment{"u_tint", ShaderColor{1.0f, 0.0f, 1.0f, 1.0f}});
    return material;
}

MaterialDefinition make_rmlui_decorator_fallback_material()
{
    MaterialDefinition material;
    material.id = MaterialId("system/fallback/rmlui_decorator_error");
    material.role = ShaderRole::RmlUiDecorator;
    material.shader = ShaderId("system/fallback/rmlui_decorator_error");
    material.display_name = "RmlUi Decorator Error Material";
    material.fallback = true;
    material.uniforms.push_back(
        MaterialUniformAssignment{"u_tint", ShaderColor{1.0f, 0.0f, 1.0f, 1.0f}});
    return material;
}

ShaderMaterialProject make_builtin_active_text_material_project()
{
    const auto system_binary = [](std::string variant, std::string path) {
        return ShaderCompiledBinaryRef::trusted_system(std::move(variant), std::move(path));
    };
    const auto stage = [&](ShaderStage shader_stage, std::string_view suffix) {
        ShaderStageDefinition result;
        result.stage = shader_stage;
        result.compiled = {
            system_binary("glsl-330",
                          "system:/shaders/bgfx/glsl-330/text." + std::string(suffix) + ".bin"),
            system_binary("essl-300",
                          "system:/shaders/bgfx/essl-300/text." + std::string(suffix) + ".bin"),
            system_binary("metal",
                          "system:/shaders/bgfx/metal/text." + std::string(suffix) + ".bin"),
        };
        return result;
    };

    ShaderDefinition shader;
    shader.id = ShaderId(std::string(builtin_active_text_material_id));
    shader.display_name = "Built-in ActiveText";
    shader.roles = {ShaderRole::ActiveText};
    shader.stages = {stage(ShaderStage::Vertex, "vs"), stage(ShaderStage::Fragment, "fs")};
    shader.samplers.push_back(
        ShaderSamplerDeclaration{.name = "s_textAtlas", .stage = 0, .binding = std::nullopt});
    if (const auto* preset = material_preset_contract("active-text")) {
        shader.interface_contract = std::string(preset->contract_identity);
        shader.interface_fingerprint = std::string(preset->contract_fingerprint);
    }

    MaterialDefinition material;
    material.id = MaterialId(std::string(builtin_active_text_material_id));
    material.role = ShaderRole::ActiveText;
    material.shader = shader.id;
    material.display_name = "Built-in ActiveText";
    material.fallback = true;

    ShaderMaterialProject project;
    project.shaders.push_back(std::move(shader));
    project.materials.push_back(std::move(material));
    return project;
}

ShaderMaterialProject make_builtin_hotspot_material_project()
{
    const auto system_binary = [](std::string variant, std::string path) {
        return ShaderCompiledBinaryRef::trusted_system(std::move(variant), std::move(path));
    };
    const auto stage = [&](ShaderStage shader_stage, std::string_view program,
                           std::string_view suffix) {
        ShaderStageDefinition result;
        result.stage = shader_stage;
        result.compiled = {
            system_binary("glsl-330", "system:/shaders/bgfx/glsl-330/" + std::string(program) +
                                          "." + std::string(suffix) + ".bin"),
            system_binary("essl-300", "system:/shaders/bgfx/essl-300/" + std::string(program) +
                                          "." + std::string(suffix) + ".bin"),
            system_binary("metal", "system:/shaders/bgfx/metal/" + std::string(program) + "." +
                                       std::string(suffix) + ".bin"),
        };
        return result;
    };
    const auto uniform = [](std::string name, ShaderUniformType type, ShaderInputSemantic binding) {
        return ShaderUniformDeclaration{.name = std::move(name),
                                        .type = type,
                                        .default_value = std::monostate{},
                                        .range = {},
                                        .editor_label = {},
                                        .binding = binding};
    };
    const auto make_shader = [&](std::string id, std::string display_name, std::string program,
                                 bool custom) {
        ShaderDefinition shader;
        shader.id = ShaderId(std::move(id));
        shader.display_name = std::move(display_name);
        shader.roles = {ShaderRole::HotspotOverlay};
        shader.stages = {stage(ShaderStage::Vertex, program, "vs"),
                         stage(ShaderStage::Fragment, program, "fs")};
        shader.uniforms = {
            uniform("u_time", ShaderUniformType::Float, ShaderInputSemantic::EngineTime),
            uniform("u_hotspotBounds", ShaderUniformType::Vec4,
                    ShaderInputSemantic::EngineHotspotBounds),
            uniform("u_hotspotHovered", ShaderUniformType::Bool,
                    ShaderInputSemantic::EngineHotspotHovered),
            uniform("u_hotspotPressed", ShaderUniformType::Bool,
                    ShaderInputSemantic::EngineHotspotPressed),
            uniform("u_hotspotImageDimensions", ShaderUniformType::Vec2,
                    ShaderInputSemantic::EngineHotspotImageDimensions),
            uniform("u_hotspotMaskDimensions", ShaderUniformType::Vec2,
                    ShaderInputSemantic::EngineHotspotMaskDimensions),
        };
        shader.samplers.push_back(
            ShaderSamplerDeclaration{.name = "s_hotspotImage",
                                     .stage = 0,
                                     .binding = ShaderSamplerSemantic::EngineHotspotImage});
        if (custom)
            shader.samplers.push_back(
                ShaderSamplerDeclaration{.name = "s_hotspotMask",
                                         .stage = 1,
                                         .binding = ShaderSamplerSemantic::EngineHotspotMask});
        return shader;
    };

    ShaderMaterialProject project;
    project.shaders.push_back(make_shader(std::string(builtin_hotspot_alpha_material_id),
                                          "Built-in Alpha Hotspot", "hotspot_alpha", false));
    project.shaders.push_back(make_shader(std::string(builtin_hotspot_custom_material_id),
                                          "Built-in Custom Hotspot", "hotspot_custom", true));
    project.materials.push_back(
        MaterialDefinition{.id = MaterialId(std::string(builtin_hotspot_alpha_material_id)),
                           .role = ShaderRole::HotspotOverlay,
                           .shader = ShaderId(std::string(builtin_hotspot_alpha_material_id)),
                           .display_name = "Built-in Alpha Hotspot",
                           .uniforms = {},
                           .textures = {},
                           .fallback = true});
    project.materials.push_back(
        MaterialDefinition{.id = MaterialId(std::string(builtin_hotspot_custom_material_id)),
                           .role = ShaderRole::HotspotOverlay,
                           .shader = ShaderId(std::string(builtin_hotspot_custom_material_id)),
                           .display_name = "Built-in Custom Hotspot",
                           .uniforms = {},
                           .textures = {},
                           .fallback = true});
    return project;
}

std::string_view to_string(MaterialDiagnosticCode code) noexcept
{
    switch (code) {
    case MaterialDiagnosticCode::InvalidShaderId:
        return "invalid_shader_id";
    case MaterialDiagnosticCode::InvalidMaterialId:
        return "invalid_material_id";
    case MaterialDiagnosticCode::InvalidJson:
        return "invalid_json";
    case MaterialDiagnosticCode::InvalidSchema:
        return "invalid_schema";
    case MaterialDiagnosticCode::MissingRequiredField:
        return "missing_required_field";
    case MaterialDiagnosticCode::InvalidFieldType:
        return "invalid_field_type";
    case MaterialDiagnosticCode::UnknownShaderRole:
        return "unknown_shader_role";
    case MaterialDiagnosticCode::DeferredShaderRole:
        return "deferred_shader_role";
    case MaterialDiagnosticCode::InvalidShaderSourceRef:
        return "invalid_shader_source_ref";
    case MaterialDiagnosticCode::InvalidCompiledBinaryRef:
        return "invalid_compiled_binary_ref";
    case MaterialDiagnosticCode::InvalidUniformDeclaration:
        return "invalid_uniform_declaration";
    case MaterialDiagnosticCode::InvalidUniformValue:
        return "invalid_uniform_value";
    case MaterialDiagnosticCode::InvalidSamplerDeclaration:
        return "invalid_sampler_declaration";
    case MaterialDiagnosticCode::InvalidTextureSlotName:
        return "invalid_texture_slot_name";
    case MaterialDiagnosticCode::InvalidTextureSource:
        return "invalid_texture_source";
    case MaterialDiagnosticCode::UnsupportedSampler:
        return "unsupported_sampler";
    case MaterialDiagnosticCode::UnknownInputBinding:
        return "unknown_input_binding";
    case MaterialDiagnosticCode::UnsupportedBlendPolicy:
        return "unsupported_blend_policy";
    case MaterialDiagnosticCode::InvalidPostprocessScope:
        return "invalid_postprocess_scope";
    case MaterialDiagnosticCode::UnknownShaderRef:
        return "unknown_shader_ref";
    case MaterialDiagnosticCode::UnknownMaterialRef:
        return "unknown_material_ref";
    case MaterialDiagnosticCode::UndeclaredUniform:
        return "undeclared_uniform";
    case MaterialDiagnosticCode::UndeclaredSampler:
        return "undeclared_sampler";
    case MaterialDiagnosticCode::RendererOwnedOverride:
        return "renderer_owned_override";
    case MaterialDiagnosticCode::InvalidMaterialOverride:
        return "invalid_material_override";
    case MaterialDiagnosticCode::IncompatibleShaderRole:
        return "incompatible_shader_role";
    }
    return "unknown";
}

std::string_view to_string(MaterialDiagnosticSeverity severity) noexcept
{
    switch (severity) {
    case MaterialDiagnosticSeverity::Warning:
        return "warning";
    case MaterialDiagnosticSeverity::Error:
        return "error";
    }
    return "unknown";
}

std::string_view to_string(ShaderRole role) noexcept
{
    switch (role) {
    case ShaderRole::Engine2D:
        return "engine-2d";
    case ShaderRole::ActiveText:
        return "active-text";
    case ShaderRole::RmlUiDecorator:
        return "rmlui-decorator";
    case ShaderRole::RmlUiFilter:
        return "rmlui-filter";
    case ShaderRole::Postprocess:
        return "postprocess";
    case ShaderRole::HotspotOverlay:
        return "hotspot-overlay";
    }
    return "unknown";
}

std::string_view to_string(ShaderStage stage) noexcept
{
    switch (stage) {
    case ShaderStage::Vertex:
        return "vertex";
    case ShaderStage::Fragment:
        return "fragment";
    }
    return "unknown";
}

std::string_view to_string(ShaderUniformType type) noexcept
{
    switch (type) {
    case ShaderUniformType::Float:
        return "float";
    case ShaderUniformType::Vec2:
        return "vec2";
    case ShaderUniformType::Vec3:
        return "vec3";
    case ShaderUniformType::Vec4:
        return "vec4";
    case ShaderUniformType::Color:
        return "color";
    case ShaderUniformType::Int:
        return "int";
    case ShaderUniformType::Bool:
        return "bool";
    }
    return "unknown";
}

std::string_view to_string(MaterialTextureSampler sampler) noexcept
{
    switch (sampler) {
    case MaterialTextureSampler::ClampNearest:
        return "clamp-nearest";
    case MaterialTextureSampler::ClampLinear:
        return "clamp-linear";
    case MaterialTextureSampler::RepeatNearest:
        return "repeat-nearest";
    case MaterialTextureSampler::RepeatLinear:
        return "repeat-linear";
    }
    return "unknown";
}

std::string_view to_string(ShaderSamplerType type) noexcept
{
    switch (type) {
    case ShaderSamplerType::Texture2D:
        return "texture2d";
    }
    return "unknown";
}

std::string_view to_string(ShaderInputSemantic semantic) noexcept
{
    switch (semantic) {
    case ShaderInputSemantic::EngineTime:
        return "engine.time";
    case ShaderInputSemantic::EnginePaintDimensions:
        return "engine.paint_dimensions";
    case ShaderInputSemantic::EngineReferenceToWorldRasterScale:
        return "engine.reference_to_world_raster_scale";
    case ShaderInputSemantic::EngineContextLogicalToRasterScale:
        return "engine.context_logical_to_raster_scale";
    case ShaderInputSemantic::EngineViewportPixelDimensions:
        return "engine.viewport_pixel_dimensions";
    case ShaderInputSemantic::EnginePointerPosition:
        return "engine.pointer_position";
    case ShaderInputSemantic::EnginePointerValid:
        return "engine.pointer_valid";
    case ShaderInputSemantic::RmlUiMediaQueryResolution:
        return "rmlui.media_query_resolution";
    case ShaderInputSemantic::EngineHotspotBounds:
        return "engine.hotspot_bounds";
    case ShaderInputSemantic::EngineHotspotHovered:
        return "engine.hotspot_hovered";
    case ShaderInputSemantic::EngineHotspotPressed:
        return "engine.hotspot_pressed";
    case ShaderInputSemantic::EngineHotspotImageDimensions:
        return "engine.hotspot_image_dimensions";
    case ShaderInputSemantic::EngineHotspotMaskDimensions:
        return "engine.hotspot_mask_dimensions";
    }
    return "unknown";
}

std::string_view to_string(ShaderSamplerSemantic semantic) noexcept
{
    switch (semantic) {
    case ShaderSamplerSemantic::EngineHotspotImage:
        return "engine.hotspot_image";
    case ShaderSamplerSemantic::EngineHotspotMask:
        return "engine.hotspot_mask";
    }
    return "unknown";
}

std::string_view to_string(PostprocessScope scope) noexcept
{
    switch (scope) {
    case PostprocessScope::World:
        return "world";
    case PostprocessScope::FullGameViewport:
        return "full-game-viewport";
    }
    return "world";
}

} // namespace noveltea
