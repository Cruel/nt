#pragma once

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace noveltea {

class ShaderId {
public:
    ShaderId() = default;
    explicit ShaderId(std::string normalized) : m_value(std::move(normalized)) {}

    [[nodiscard]] const std::string& value() const noexcept { return m_value; }
    [[nodiscard]] bool valid() const noexcept { return !m_value.empty(); }

    friend bool operator==(const ShaderId&, const ShaderId&) = default;

private:
    std::string m_value;
};

enum class ShaderRole {
    Engine2D,
    ActiveText,
    RmlUiDecorator,
    RmlUiFilter,
    Postprocess,
};

enum class ShaderStage {
    Vertex,
    Fragment,
};

enum class ShaderUniformType {
    Float,
    Vec2,
    Vec3,
    Vec4,
    Color,
    Int,
    Bool,
};

struct ShaderColor {
    float r = 1.0f;
    float g = 1.0f;
    float b = 1.0f;
    float a = 1.0f;
};

using ShaderUniformValue =
    std::variant<std::monostate, float, std::array<float, 2>, std::array<float, 3>,
                 std::array<float, 4>, ShaderColor, int, bool>;

enum class ShaderSamplerType {
    Texture2D,
};

enum class ShaderInputSemantic {
    EngineTime,
    RmlUiPaintDimensions,
    RmlUiDpiScale,
};

struct ShaderSourceRef {
    std::string path;

    [[nodiscard]] bool empty() const noexcept { return path.empty(); }
};

struct ShaderCompiledBinaryRef {
    std::string variant;
    std::string path;
};

struct ShaderStageDefinition {
    ShaderStage stage = ShaderStage::Fragment;
    ShaderSourceRef source;
    std::string source_text;
    std::vector<ShaderCompiledBinaryRef> compiled;
};

struct ShaderUniformDeclaration {
    std::string name;
    ShaderUniformType type = ShaderUniformType::Float;
    ShaderUniformValue default_value;
    std::optional<std::array<float, 2>> range;
    std::string editor_label;
    std::optional<ShaderInputSemantic> binding;
};

struct ShaderSamplerDeclaration {
    std::string name;
    ShaderSamplerType type = ShaderSamplerType::Texture2D;
};

struct ShaderRoleBinding {
    ShaderRole role = ShaderRole::Engine2D;
    std::optional<ShaderId> vertex_shader;
    std::optional<ShaderId> fragment_shader;
};

struct ShaderDefinition {
    ShaderId id;
    std::string display_name;
    std::vector<ShaderStageDefinition> stages;
    std::vector<ShaderUniformDeclaration> uniforms;
    std::vector<ShaderSamplerDeclaration> samplers;
    std::vector<ShaderRole> roles;
    std::vector<ShaderRoleBinding> role_bindings;
};

[[nodiscard]] std::string_view to_string(ShaderRole role) noexcept;
[[nodiscard]] std::string_view to_string(ShaderStage stage) noexcept;
[[nodiscard]] std::string_view to_string(ShaderUniformType type) noexcept;
[[nodiscard]] std::string_view to_string(ShaderSamplerType type) noexcept;
[[nodiscard]] std::string_view to_string(ShaderInputSemantic semantic) noexcept;

} // namespace noveltea
