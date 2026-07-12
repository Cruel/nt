#pragma once

#include "noveltea/render/shader.hpp"

#include <nlohmann/json_fwd.hpp>

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace noveltea {

inline constexpr std::string_view shader_material_schema_v1 = "noveltea.shader-materials.v1";

class MaterialId {
public:
    MaterialId() = default;
    explicit MaterialId(std::string normalized) : m_value(std::move(normalized)) {}

    [[nodiscard]] const std::string& string() const noexcept { return m_value; }
    [[nodiscard]] const std::string& value() const noexcept { return m_value; }
    [[nodiscard]] bool valid() const noexcept { return !m_value.empty(); }

    friend bool operator==(const MaterialId&, const MaterialId&) = default;

private:
    std::string m_value;
};

enum class MaterialDiagnosticSeverity {
    Warning,
    Error,
};

enum class MaterialDiagnosticCode {
    InvalidShaderId,
    InvalidMaterialId,
    InvalidJson,
    InvalidSchema,
    MissingRequiredField,
    InvalidFieldType,
    UnknownShaderRole,
    DeferredShaderRole,
    InvalidShaderSourceRef,
    InvalidCompiledBinaryRef,
    InvalidUniformDeclaration,
    InvalidUniformValue,
    InvalidSamplerDeclaration,
    InvalidTextureSlotName,
    InvalidTextureSource,
    UnsupportedSampler,
    UnknownInputBinding,
    UnsupportedBlendPolicy,
    UnknownShaderRef,
    UndeclaredUniform,
    UndeclaredSampler,
    IncompatibleShaderRole,
};

struct MaterialDiagnostic {
    MaterialDiagnosticSeverity severity = MaterialDiagnosticSeverity::Error;
    MaterialDiagnosticCode code = MaterialDiagnosticCode::InvalidJson;
    std::string path;
    std::string message;
};

struct ShaderIdParseResult {
    std::optional<ShaderId> id;
    std::vector<MaterialDiagnostic> diagnostics;

    [[nodiscard]] bool ok() const noexcept { return id.has_value() && diagnostics.empty(); }
};

struct MaterialIdParseResult {
    std::optional<MaterialId> id;
    std::vector<MaterialDiagnostic> diagnostics;

    [[nodiscard]] bool ok() const noexcept { return id.has_value() && diagnostics.empty(); }
};

enum class MaterialTextureSampler {
    ClampNearest,
    ClampLinear,
    RepeatNearest,
    RepeatLinear,
};

enum class MaterialBlendMode {
    PremultipliedAlpha,
};

struct MaterialUniformAssignment {
    std::string name;
    ShaderUniformValue value;
};

struct MaterialTextureAssignment {
    std::string sampler;
    std::string source;
    MaterialTextureSampler filtering = MaterialTextureSampler::ClampLinear;
};

struct MaterialDefinition {
    MaterialId id;
    ShaderRole role = ShaderRole::Engine2D;
    ShaderId shader;
    std::string display_name;
    std::vector<MaterialUniformAssignment> uniforms;
    std::vector<MaterialTextureAssignment> textures;
    MaterialBlendMode blend = MaterialBlendMode::PremultipliedAlpha;
    bool fallback = false;
};

struct ShaderMaterialProject {
    std::vector<ShaderDefinition> shaders;
    std::vector<MaterialDefinition> materials;
};

struct ShaderMaterialProjectParseResult {
    std::optional<ShaderMaterialProject> project;
    std::vector<MaterialDiagnostic> diagnostics;

    [[nodiscard]] bool ok() const noexcept { return project.has_value() && diagnostics.empty(); }
    [[nodiscard]] bool has_errors() const noexcept;
};

using MaterialParseResult = ShaderMaterialProjectParseResult;

[[nodiscard]] ShaderIdParseResult parse_shader_id(std::string_view reference);
[[nodiscard]] MaterialIdParseResult parse_material_id(std::string_view reference);

[[nodiscard]] ShaderMaterialProjectParseResult
parse_shader_material_project_json(std::string_view source);
[[nodiscard]] ShaderMaterialProjectParseResult
parse_shader_material_project_json_value(const nlohmann::json& value);

[[nodiscard]] const ShaderDefinition* find_shader(const ShaderMaterialProject& project,
                                                  const ShaderId& id) noexcept;
[[nodiscard]] const MaterialDefinition* find_material(const ShaderMaterialProject& project,
                                                      const MaterialId& id) noexcept;

[[nodiscard]] MaterialDefinition make_engine_2d_fallback_material();
[[nodiscard]] MaterialDefinition make_rmlui_decorator_fallback_material();

[[nodiscard]] std::string_view to_string(MaterialDiagnosticCode code) noexcept;
[[nodiscard]] std::string_view to_string(MaterialDiagnosticSeverity severity) noexcept;
[[nodiscard]] std::string_view to_string(MaterialTextureSampler sampler) noexcept;
[[nodiscard]] std::string_view to_string(MaterialBlendMode mode) noexcept;

} // namespace noveltea
