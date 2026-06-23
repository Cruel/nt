#pragma once

#include "noveltea/render/shader.hpp"

#include <nlohmann/json_fwd.hpp>

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace noveltea {

inline constexpr std::string_view material_schema_v1 = "noveltea.material.v1";

class MaterialId {
public:
    MaterialId() = default;
    explicit MaterialId(std::string normalized) : m_value(std::move(normalized)) {}

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
    InvalidMaterialId,
    InvalidJson,
    InvalidSchema,
    MissingRequiredField,
    InvalidFieldType,
    UnknownMaterialType,
    DeferredMaterialType,
    InvalidShaderRef,
    InvalidUniformDeclaration,
    InvalidUniformDefault,
    InvalidTextureSlotName,
    InvalidTextureSource,
    UnsupportedSampler,
    UnknownInputBinding,
    UnsupportedBlendPolicy,
};

struct MaterialDiagnostic {
    MaterialDiagnosticSeverity severity = MaterialDiagnosticSeverity::Error;
    MaterialDiagnosticCode code = MaterialDiagnosticCode::InvalidJson;
    std::string path;
    std::string message;
};

struct MaterialIdParseResult {
    std::optional<MaterialId> id;
    std::vector<MaterialDiagnostic> diagnostics;

    [[nodiscard]] bool ok() const noexcept { return id.has_value() && diagnostics.empty(); }
};

enum class MaterialType {
    Engine2D,
    RmlUiDecorator,
    RmlUiFilter,
    Postprocess,
};

enum class MaterialUniformType {
    Float,
    Vec2,
    Vec3,
    Vec4,
    Color,
    Int,
    Bool,
};

struct MaterialColor {
    float r = 1.0f;
    float g = 1.0f;
    float b = 1.0f;
    float a = 1.0f;
};

using MaterialUniformValue =
    std::variant<std::monostate, float, std::array<float, 2>, std::array<float, 3>,
                 std::array<float, 4>, MaterialColor, int, bool>;

struct MaterialUniform {
    std::string name;
    MaterialUniformType type = MaterialUniformType::Float;
    MaterialUniformValue default_value;
    std::optional<std::array<float, 2>> range;
    std::string editor_label;
};

enum class MaterialTextureSampler {
    ClampNearest,
    ClampLinear,
    RepeatNearest,
    RepeatLinear,
};

struct MaterialTextureSlot {
    std::string name;
    std::string source;
    MaterialTextureSampler sampler = MaterialTextureSampler::ClampLinear;
};

enum class MaterialInputSemantic {
    EngineTime,
    RmlUiPaintDimensions,
    RmlUiDpiScale,
};

struct MaterialInputBinding {
    std::string uniform;
    MaterialInputSemantic semantic = MaterialInputSemantic::EngineTime;
};

enum class MaterialBlendMode {
    PremultipliedAlpha,
};

struct MaterialShaderRefs {
    ShaderSourceRef vertex;
    ShaderSourceRef fragment;
};

struct MaterialAsset {
    MaterialId id;
    MaterialType type = MaterialType::Engine2D;
    std::string display_name;
    MaterialShaderRefs shader;
    std::vector<MaterialUniform> uniforms;
    std::vector<MaterialTextureSlot> textures;
    std::vector<MaterialInputBinding> inputs;
    MaterialBlendMode blend = MaterialBlendMode::PremultipliedAlpha;
    bool fallback = false;
};

struct MaterialParseResult {
    std::optional<MaterialAsset> material;
    std::vector<MaterialDiagnostic> diagnostics;

    [[nodiscard]] bool ok() const noexcept { return material.has_value() && diagnostics.empty(); }
    [[nodiscard]] bool has_errors() const noexcept;
};

[[nodiscard]] MaterialIdParseResult parse_material_id(std::string_view reference);

[[nodiscard]] MaterialParseResult parse_material_json(std::string_view source,
                                                      std::string_view material_reference = {});
[[nodiscard]] MaterialParseResult
parse_material_json_value(const nlohmann::json& value, std::string_view material_reference = {});

[[nodiscard]] MaterialAsset make_engine_2d_fallback_material();
[[nodiscard]] MaterialAsset make_rmlui_decorator_fallback_material();

[[nodiscard]] std::string_view to_string(MaterialDiagnosticCode code) noexcept;
[[nodiscard]] std::string_view to_string(MaterialDiagnosticSeverity severity) noexcept;
[[nodiscard]] std::string_view to_string(MaterialType type) noexcept;
[[nodiscard]] std::string_view to_string(MaterialUniformType type) noexcept;
[[nodiscard]] std::string_view to_string(MaterialTextureSampler sampler) noexcept;
[[nodiscard]] std::string_view to_string(MaterialInputSemantic semantic) noexcept;
[[nodiscard]] std::string_view to_string(MaterialBlendMode mode) noexcept;

} // namespace noveltea
