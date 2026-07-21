#include "noveltea/render/material.hpp"

#include <algorithm>
#include <cctype>
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
    case MaterialDiagnosticCode::UnknownShaderRef:
        return "unknown_shader_ref";
    case MaterialDiagnosticCode::UndeclaredUniform:
        return "undeclared_uniform";
    case MaterialDiagnosticCode::UndeclaredSampler:
        return "undeclared_sampler";
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
    case ShaderInputSemantic::EngineContextLogicalToUiRasterScale:
        return "engine.context_logical_to_ui_raster_scale";
    case ShaderInputSemantic::EngineUiMediaQueryResolution:
        return "engine.ui_media_query_resolution";
    case ShaderInputSemantic::EngineViewportPixelDimensions:
        return "engine.viewport_pixel_dimensions";
    case ShaderInputSemantic::EnginePointerPosition:
        return "engine.pointer_position";
    case ShaderInputSemantic::EnginePointerValid:
        return "engine.pointer_valid";
    case ShaderInputSemantic::RmlUiPaintDimensions:
        return "rmlui.paint_dimensions";
    case ShaderInputSemantic::RmlUiContextLogicalToUiRasterScale:
        return "rmlui.context_logical_to_ui_raster_scale";
    case ShaderInputSemantic::RmlUiMediaQueryResolution:
        return "rmlui.media_query_resolution";
    case ShaderInputSemantic::RmlUiViewportPixelDimensions:
        return "rmlui.viewport_pixel_dimensions";
    }
    return "unknown";
}

std::string_view to_string(MaterialBlendMode mode) noexcept
{
    switch (mode) {
    case MaterialBlendMode::PremultipliedAlpha:
        return "premultiplied-alpha";
    }
    return "unknown";
}

} // namespace noveltea
