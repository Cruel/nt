#include "noveltea/render/material.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>

namespace noveltea {
namespace {

struct LogicalAssetRef {
    std::string namespace_name;
    std::string relative_path;
};

void add_diagnostic(std::vector<MaterialDiagnostic>& diagnostics, MaterialDiagnosticCode code,
                    std::string path, std::string message)
{
    diagnostics.push_back(MaterialDiagnostic{MaterialDiagnosticSeverity::Error, code,
                                             std::move(path), std::move(message)});
}

[[nodiscard]] bool has_suffix(std::string_view value, std::string_view suffix)
{
    return value.size() >= suffix.size() && value.substr(value.size() - suffix.size()) == suffix;
}

[[nodiscard]] bool has_prefix(std::string_view value, std::string_view prefix)
{
    return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

[[nodiscard]] bool valid_namespace(std::string_view value)
{
    if (value.empty())
        return false;
    for (const char c : value) {
        if (!(std::islower(static_cast<unsigned char>(c)) ||
              std::isdigit(static_cast<unsigned char>(c)) || c == '_' || c == '-')) {
            return false;
        }
    }
    return true;
}

[[nodiscard]] bool parse_logical_asset_ref(std::string_view logical, LogicalAssetRef& out)
{
    if (logical.empty() || logical.front() == '/' || logical.find('\\') != std::string_view::npos)
        return false;

    std::string_view rest = logical;
    const std::size_t scheme = logical.find(":/");
    if (scheme != std::string_view::npos) {
        const std::string_view ns = logical.substr(0, scheme);
        if (!valid_namespace(ns))
            return false;
        out.namespace_name = std::string(ns);
        rest = logical.substr(scheme + 2);
    } else if (logical.find(':') != std::string_view::npos) {
        return false;
    } else {
        out.namespace_name.clear();
    }

    if (rest.empty() || rest.front() == '/' || rest.find("//") != std::string_view::npos)
        return false;

    std::size_t start = 0;
    while (start <= rest.size()) {
        const std::size_t slash = rest.find('/', start);
        const std::string_view part =
            rest.substr(start, slash == std::string_view::npos ? slash : slash - start);
        if (part.empty() || part == "." || part == ".." ||
            part.find(':') != std::string_view::npos) {
            return false;
        }
        if (slash == std::string_view::npos)
            break;
        start = slash + 1;
    }

    out.relative_path = std::string(rest);
    return true;
}

[[nodiscard]] bool valid_asset_ref(std::string_view logical)
{
    LogicalAssetRef ignored;
    return parse_logical_asset_ref(logical, ignored);
}

[[nodiscard]] bool valid_draw_texture_ref(std::string_view value)
{
    return value == "$draw.texture";
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

[[nodiscard]] bool valid_identifier(std::string_view value)
{
    if (value.empty())
        return false;
    const auto first = static_cast<unsigned char>(value.front());
    if (!(std::isalpha(first) || value.front() == '_'))
        return false;
    return std::all_of(value.begin() + 1, value.end(), [](char c) {
        const auto ch = static_cast<unsigned char>(c);
        return std::isalnum(ch) || c == '_';
    });
}

[[nodiscard]] bool valid_uniform_name(std::string_view value)
{
    return has_prefix(value, "u_") && valid_identifier(value);
}

[[nodiscard]] bool valid_sampler_name(std::string_view value)
{
    return has_prefix(value, "s_") && valid_identifier(value);
}

[[nodiscard]] bool valid_variant(std::string_view value)
{
    if (value.empty())
        return false;
    return std::all_of(value.begin(), value.end(), [](char c) {
        const auto ch = static_cast<unsigned char>(c);
        return std::islower(ch) || std::isdigit(ch) || c == '-' || c == '_';
    });
}

[[nodiscard]] std::optional<ShaderStage> parse_shader_stage(std::string_view stage)
{
    if (stage == "vertex")
        return ShaderStage::Vertex;
    if (stage == "fragment")
        return ShaderStage::Fragment;
    return std::nullopt;
}

[[nodiscard]] std::optional<ShaderRole> parse_shader_role(std::string_view role)
{
    if (role == "engine-2d")
        return ShaderRole::Engine2D;
    if (role == "active-text")
        return ShaderRole::ActiveText;
    if (role == "rmlui-decorator")
        return ShaderRole::RmlUiDecorator;
    if (role == "rmlui-filter")
        return ShaderRole::RmlUiFilter;
    if (role == "postprocess")
        return ShaderRole::Postprocess;
    return std::nullopt;
}

[[nodiscard]] bool deferred_shader_role(ShaderRole role)
{
    return role == ShaderRole::RmlUiFilter || role == ShaderRole::Postprocess;
}

[[nodiscard]] std::optional<ShaderUniformType> parse_uniform_type(std::string_view type)
{
    if (type == "float")
        return ShaderUniformType::Float;
    if (type == "vec2")
        return ShaderUniformType::Vec2;
    if (type == "vec3")
        return ShaderUniformType::Vec3;
    if (type == "vec4")
        return ShaderUniformType::Vec4;
    if (type == "color")
        return ShaderUniformType::Color;
    if (type == "int")
        return ShaderUniformType::Int;
    if (type == "bool")
        return ShaderUniformType::Bool;
    return std::nullopt;
}

[[nodiscard]] std::optional<MaterialTextureSampler> parse_texture_sampler(std::string_view sampler)
{
    if (sampler == "clamp-nearest")
        return MaterialTextureSampler::ClampNearest;
    if (sampler == "clamp-linear")
        return MaterialTextureSampler::ClampLinear;
    if (sampler == "repeat-nearest")
        return MaterialTextureSampler::RepeatNearest;
    if (sampler == "repeat-linear")
        return MaterialTextureSampler::RepeatLinear;
    return std::nullopt;
}

[[nodiscard]] std::optional<ShaderSamplerType> parse_sampler_type(std::string_view type)
{
    if (type == "texture2d")
        return ShaderSamplerType::Texture2D;
    return std::nullopt;
}

[[nodiscard]] std::optional<ShaderInputSemantic> parse_input_semantic(std::string_view semantic)
{
    if (semantic == "engine.time")
        return ShaderInputSemantic::EngineTime;
    if (semantic == "engine.paint_dimensions")
        return ShaderInputSemantic::EnginePaintDimensions;
    if (semantic == "engine.dpi_scale")
        return ShaderInputSemantic::EngineDpiScale;
    if (semantic == "engine.pointer_position")
        return ShaderInputSemantic::EnginePointerPosition;
    if (semantic == "engine.pointer_valid")
        return ShaderInputSemantic::EnginePointerValid;
    if (semantic == "rmlui.paint_dimensions")
        return ShaderInputSemantic::RmlUiPaintDimensions;
    if (semantic == "rmlui.dpi_scale")
        return ShaderInputSemantic::RmlUiDpiScale;
    return std::nullopt;
}

[[nodiscard]] std::optional<MaterialBlendMode> parse_blend_mode(std::string_view blend)
{
    if (blend == "premultiplied-alpha")
        return MaterialBlendMode::PremultipliedAlpha;
    return std::nullopt;
}

[[nodiscard]] std::optional<float> json_float(const nlohmann::json& value)
{
    if (!value.is_number())
        return std::nullopt;
    const double number = value.get<double>();
    if (!std::isfinite(number) || number < -std::numeric_limits<float>::max() ||
        number > std::numeric_limits<float>::max()) {
        return std::nullopt;
    }
    return static_cast<float>(number);
}

[[nodiscard]] std::optional<std::array<float, 2>> parse_vec2(const nlohmann::json& value)
{
    if (!value.is_array() || value.size() != 2)
        return std::nullopt;
    const auto x = json_float(value[0]);
    const auto y = json_float(value[1]);
    if (!x || !y)
        return std::nullopt;
    return std::array<float, 2>{*x, *y};
}

[[nodiscard]] std::optional<std::array<float, 3>> parse_vec3(const nlohmann::json& value)
{
    if (!value.is_array() || value.size() != 3)
        return std::nullopt;
    const auto x = json_float(value[0]);
    const auto y = json_float(value[1]);
    const auto z = json_float(value[2]);
    if (!x || !y || !z)
        return std::nullopt;
    return std::array<float, 3>{*x, *y, *z};
}

[[nodiscard]] std::optional<std::array<float, 4>> parse_vec4(const nlohmann::json& value)
{
    if (!value.is_array() || value.size() != 4)
        return std::nullopt;
    const auto x = json_float(value[0]);
    const auto y = json_float(value[1]);
    const auto z = json_float(value[2]);
    const auto w = json_float(value[3]);
    if (!x || !y || !z || !w)
        return std::nullopt;
    return std::array<float, 4>{*x, *y, *z, *w};
}

[[nodiscard]] std::optional<int> hex_digit(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return std::nullopt;
}

[[nodiscard]] std::optional<int> parse_hex_byte(std::string_view value, std::size_t offset)
{
    const auto hi = hex_digit(value[offset]);
    const auto lo = hex_digit(value[offset + 1]);
    if (!hi || !lo)
        return std::nullopt;
    return (*hi << 4) | *lo;
}

[[nodiscard]] std::optional<ShaderColor> parse_color(std::string_view value)
{
    if (!(value.size() == 7 || value.size() == 9) || value.front() != '#')
        return std::nullopt;
    const auto r = parse_hex_byte(value, 1);
    const auto g = parse_hex_byte(value, 3);
    const auto b = parse_hex_byte(value, 5);
    const auto a = value.size() == 9 ? parse_hex_byte(value, 7) : std::optional<int>(255);
    if (!r || !g || !b || !a)
        return std::nullopt;
    constexpr float inv = 1.0f / 255.0f;
    return ShaderColor{static_cast<float>(*r) * inv, static_cast<float>(*g) * inv,
                       static_cast<float>(*b) * inv, static_cast<float>(*a) * inv};
}

[[nodiscard]] bool parse_uniform_value(const nlohmann::json& value, ShaderUniformType type,
                                       ShaderUniformValue& out)
{
    switch (type) {
    case ShaderUniformType::Float: {
        const auto parsed = json_float(value);
        if (!parsed)
            return false;
        out = *parsed;
        return true;
    }
    case ShaderUniformType::Vec2: {
        const auto parsed = parse_vec2(value);
        if (!parsed)
            return false;
        out = *parsed;
        return true;
    }
    case ShaderUniformType::Vec3: {
        const auto parsed = parse_vec3(value);
        if (!parsed)
            return false;
        out = *parsed;
        return true;
    }
    case ShaderUniformType::Vec4: {
        const auto parsed = parse_vec4(value);
        if (!parsed)
            return false;
        out = *parsed;
        return true;
    }
    case ShaderUniformType::Color:
        if (!value.is_string())
            return false;
        if (const auto parsed = parse_color(value.get<std::string_view>())) {
            out = *parsed;
            return true;
        }
        return false;
    case ShaderUniformType::Int:
        if (!value.is_number_integer())
            return false;
        out = value.get<int>();
        return true;
    case ShaderUniformType::Bool:
        if (!value.is_boolean())
            return false;
        out = value.get<bool>();
        return true;
    }
    return false;
}

[[nodiscard]] const nlohmann::json& unwrap_material_value(const nlohmann::json& json)
{
    if (json.is_object()) {
        const auto value_it = json.find("value");
        if (value_it != json.end())
            return *value_it;
    }
    return json;
}

[[nodiscard]] std::string field_path(std::string_view parent, std::string_view field)
{
    std::string path(parent);
    path += '/';
    path += field;
    return path;
}

[[nodiscard]] bool contains_role(const ShaderDefinition& shader, ShaderRole role)
{
    return std::find(shader.roles.begin(), shader.roles.end(), role) != shader.roles.end();
}

[[nodiscard]] const ShaderUniformDeclaration* find_uniform_decl(const ShaderDefinition& shader,
                                                                std::string_view name)
{
    for (const auto& uniform : shader.uniforms) {
        if (uniform.name == name)
            return &uniform;
    }
    return nullptr;
}

[[nodiscard]] const ShaderSamplerDeclaration* find_sampler_decl(const ShaderDefinition& shader,
                                                                std::string_view name)
{
    for (const auto& sampler : shader.samplers) {
        if (sampler.name == name)
            return &sampler;
    }
    return nullptr;
}

[[nodiscard]] bool valid_binary_suffix(ShaderStage stage, std::string_view path)
{
    switch (stage) {
    case ShaderStage::Vertex:
        return has_suffix(path, ".vs.bin");
    case ShaderStage::Fragment:
        return has_suffix(path, ".fs.bin");
    }
    return false;
}

void parse_shader_stage_definition(std::string_view stage_name, const nlohmann::json& stage_json,
                                   ShaderDefinition& shader,
                                   std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto stage = parse_shader_stage(stage_name);
    const std::string base_path =
        "/shaders/" + shader.id.value() + "/stages/" + std::string(stage_name);
    if (!stage) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, base_path,
                       "unsupported shader stage: " + std::string(stage_name));
        return;
    }
    if (!stage_json.is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, base_path,
                       "shader stage must be an object");
        return;
    }

    ShaderStageDefinition stage_definition;
    stage_definition.stage = *stage;

    const auto source_it = stage_json.find("source");
    if (source_it != stage_json.end()) {
        if (!source_it->is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                           field_path(base_path, "source"), "shader stage source must be a string");
        } else {
            const std::string source = source_it->get<std::string>();
            if (!valid_asset_ref(source)) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidShaderSourceRef,
                               field_path(base_path, "source"),
                               "invalid shader source reference: " + source);
            } else {
                stage_definition.source.path = source;
            }
        }
    }

    const auto source_text_it = stage_json.find("source_text");
    if (source_text_it != stage_json.end()) {
        if (!source_text_it->is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                           field_path(base_path, "source_text"),
                           "shader stage source_text must be a string");
        } else {
            stage_definition.source_text = source_text_it->get<std::string>();
        }
    }

    const auto compiled_it = stage_json.find("compiled");
    if (compiled_it != stage_json.end()) {
        if (!compiled_it->is_object()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                           field_path(base_path, "compiled"),
                           "shader stage compiled field must be an object");
        } else {
            for (const auto& [variant, binary_json] : compiled_it->items()) {
                const std::string path = field_path(field_path(base_path, "compiled"), variant);
                if (!valid_variant(variant)) {
                    add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidCompiledBinaryRef,
                                   path, "invalid compiled shader variant: " + variant);
                    continue;
                }
                if (!binary_json.is_string()) {
                    add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidCompiledBinaryRef,
                                   path, "compiled shader binary path must be a string");
                    continue;
                }
                const std::string binary = binary_json.get<std::string>();
                if (!valid_asset_ref(binary) || !valid_binary_suffix(*stage, binary)) {
                    add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidCompiledBinaryRef,
                                   path, "invalid compiled shader binary path: " + binary);
                    continue;
                }
                stage_definition.compiled.push_back(ShaderCompiledBinaryRef{variant, binary});
            }
        }
    }

    if (stage_definition.source.empty() && stage_definition.source_text.empty() &&
        stage_definition.compiled.empty()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField, base_path,
                       "shader stage must provide source, source_text, or compiled binaries");
    }

    shader.stages.push_back(std::move(stage_definition));
}

void parse_shader_uniforms(const nlohmann::json& shader_json, ShaderDefinition& shader,
                           std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto uniforms_it = shader_json.find("uniforms");
    if (uniforms_it == shader_json.end())
        return;
    const std::string base_path = "/shaders/" + shader.id.value() + "/uniforms";
    if (!uniforms_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, base_path,
                       "shader uniforms field must be an object");
        return;
    }

    std::unordered_set<std::string> seen;
    for (const auto& [name, uniform_json] : uniforms_it->items()) {
        const std::string path = base_path + "/" + name;
        if (!valid_uniform_name(name)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration, path,
                           "invalid shader uniform name: " + name);
            continue;
        }
        if (!seen.insert(name).second) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration, path,
                           "duplicate shader uniform name: " + name);
            continue;
        }
        if (!uniform_json.is_object()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration, path,
                           "shader uniform declaration must be an object");
            continue;
        }

        const auto type_it = uniform_json.find("type");
        if (type_it == uniform_json.end()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField,
                           field_path(path, "type"),
                           "shader uniform is missing required type field");
            continue;
        }
        if (!type_it->is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration,
                           field_path(path, "type"), "shader uniform type must be a string");
            continue;
        }
        const auto uniform_type = parse_uniform_type(type_it->get<std::string_view>());
        if (!uniform_type) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration,
                           field_path(path, "type"),
                           "unsupported shader uniform type: " + type_it->get<std::string>());
            continue;
        }

        ShaderUniformDeclaration uniform;
        uniform.name = name;
        uniform.type = *uniform_type;

        const auto default_it = uniform_json.find("default");
        if (default_it != uniform_json.end() &&
            !parse_uniform_value(*default_it, *uniform_type, uniform.default_value)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformValue,
                           field_path(path, "default"),
                           "shader uniform default does not match declared type");
        }

        const auto range_it = uniform_json.find("range");
        if (range_it != uniform_json.end()) {
            const auto range = parse_vec2(*range_it);
            if (!range) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration,
                               field_path(path, "range"),
                               "shader uniform range must be a finite two-number array");
            } else {
                uniform.range = *range;
            }
        }

        const auto binding_it = uniform_json.find("binding");
        if (binding_it != uniform_json.end()) {
            if (!binding_it->is_string()) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration,
                               field_path(path, "binding"),
                               "shader uniform binding must be a string");
            } else if (const auto binding =
                           parse_input_semantic(binding_it->get<std::string_view>())) {
                uniform.binding = *binding;
            } else {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownInputBinding,
                               field_path(path, "binding"),
                               "unsupported shader uniform binding: " +
                                   binding_it->get<std::string>());
            }
        }

        const auto editor_it = uniform_json.find("editor");
        if (editor_it != uniform_json.end() && editor_it->is_object()) {
            const auto label_it = editor_it->find("label");
            if (label_it != editor_it->end() && label_it->is_string())
                uniform.editor_label = label_it->get<std::string>();
        }

        shader.uniforms.push_back(std::move(uniform));
    }
}

void parse_shader_samplers(const nlohmann::json& shader_json, ShaderDefinition& shader,
                           std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto samplers_it = shader_json.find("samplers");
    if (samplers_it == shader_json.end())
        return;
    const std::string base_path = "/shaders/" + shader.id.value() + "/samplers";
    if (!samplers_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, base_path,
                       "shader samplers field must be an object");
        return;
    }

    std::unordered_set<std::string> seen;
    for (const auto& [name, sampler_json] : samplers_it->items()) {
        const std::string path = base_path + "/" + name;
        if (!valid_sampler_name(name)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidSamplerDeclaration, path,
                           "invalid shader sampler name: " + name);
            continue;
        }
        if (!seen.insert(name).second) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidSamplerDeclaration, path,
                           "duplicate shader sampler name: " + name);
            continue;
        }
        if (!sampler_json.is_object()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidSamplerDeclaration, path,
                           "shader sampler declaration must be an object");
            continue;
        }

        ShaderSamplerDeclaration sampler;
        sampler.name = name;
        const auto type_it = sampler_json.find("type");
        if (type_it != sampler_json.end()) {
            if (!type_it->is_string()) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidSamplerDeclaration,
                               field_path(path, "type"), "shader sampler type must be a string");
                continue;
            }
            const auto type = parse_sampler_type(type_it->get<std::string_view>());
            if (!type) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::UnsupportedSampler,
                               field_path(path, "type"),
                               "unsupported shader sampler type: " + type_it->get<std::string>());
                continue;
            }
            sampler.type = *type;
        }
        shader.samplers.push_back(std::move(sampler));
    }
}

void parse_shader_roles(const nlohmann::json& shader_json, ShaderDefinition& shader,
                        std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto roles_it = shader_json.find("roles");
    const std::string base_path = "/shaders/" + shader.id.value() + "/roles";
    if (roles_it == shader_json.end()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField, base_path,
                       "shader is missing required roles field");
        return;
    }

    std::unordered_set<std::string> seen;
    auto add_role = [&](std::string_view role_value,
                        std::string path) -> std::optional<ShaderRole> {
        const auto role = parse_shader_role(role_value);
        if (!role) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownShaderRole, path,
                           "unsupported shader role: " + std::string(role_value));
            return std::nullopt;
        }
        if (deferred_shader_role(*role)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::DeferredShaderRole, path,
                           "shader role is recognized but deferred: " + std::string(role_value));
            return std::nullopt;
        }
        const std::string normalized(to_string(*role));
        if (!seen.insert(normalized).second)
            return *role;
        shader.roles.push_back(*role);
        return *role;
    };

    if (roles_it->is_array()) {
        for (std::size_t index = 0; index < roles_it->size(); ++index) {
            const auto& role_json = (*roles_it)[index];
            const std::string path = base_path + "/" + std::to_string(index);
            if (!role_json.is_string()) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, path,
                               "shader role entry must be a string");
                continue;
            }
            add_role(role_json.get<std::string_view>(), path);
        }
        return;
    }

    if (!roles_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, base_path,
                       "shader roles field must be an array or object");
        return;
    }

    for (const auto& [role_name, binding_json] : roles_it->items()) {
        const std::string path = base_path + "/" + role_name;
        const auto role = add_role(role_name, path);
        if (!role)
            continue;
        if (!binding_json.is_object()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, path,
                           "role binding must be an object");
            continue;
        }
        ShaderRoleBinding binding;
        binding.role = *role;
        for (const std::string_view stage_name :
             {std::string_view("vertex"), std::string_view("fragment")}) {
            const auto stage_it = binding_json.find(stage_name);
            if (stage_it == binding_json.end())
                continue;
            const std::string stage_path = field_path(path, stage_name);
            if (!stage_it->is_string()) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, stage_path,
                               "role shader id must be a string");
                continue;
            }
            const auto parsed_id = parse_shader_id(stage_it->get<std::string_view>());
            if (!parsed_id.ok()) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidShaderId, stage_path,
                               "invalid role shader id: " + stage_it->get<std::string>());
                continue;
            }
            if (stage_name == "vertex")
                binding.vertex_shader = *parsed_id.id;
            else
                binding.fragment_shader = *parsed_id.id;
        }
        shader.role_bindings.push_back(std::move(binding));
    }
}

void parse_shader_definition(std::string_view id, const nlohmann::json& shader_json,
                             ShaderMaterialProject& project,
                             std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto parsed_id = parse_shader_id(id);
    if (!parsed_id.ok()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidShaderId,
                       "/shaders/" + std::string(id), "invalid shader id: " + std::string(id));
        return;
    }
    if (!shader_json.is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                       "/shaders/" + std::string(id), "shader definition must be an object");
        return;
    }

    ShaderDefinition shader;
    shader.id = *parsed_id.id;

    const auto display_it = shader_json.find("display_name");
    if (display_it != shader_json.end()) {
        if (display_it->is_string())
            shader.display_name = display_it->get<std::string>();
        else
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                           "/shaders/" + shader.id.value() + "/display_name",
                           "shader display_name must be a string");
    }

    const auto stages_it = shader_json.find("stages");
    if (stages_it == shader_json.end()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField,
                       "/shaders/" + shader.id.value() + "/stages",
                       "shader is missing required stages field");
    } else if (!stages_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                       "/shaders/" + shader.id.value() + "/stages",
                       "shader stages field must be an object");
    } else {
        for (const auto& [stage_name, stage_json] : stages_it->items())
            parse_shader_stage_definition(stage_name, stage_json, shader, diagnostics);
    }

    parse_shader_uniforms(shader_json, shader, diagnostics);
    parse_shader_samplers(shader_json, shader, diagnostics);
    parse_shader_roles(shader_json, shader, diagnostics);

    project.shaders.push_back(std::move(shader));
}

void parse_material_uniforms(const nlohmann::json& material_json, const ShaderDefinition* shader,
                             MaterialDefinition& material,
                             std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto uniforms_it = material_json.find("uniforms");
    if (uniforms_it == material_json.end())
        return;
    const std::string base_path = "/materials/" + material.id.value() + "/uniforms";
    if (!uniforms_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, base_path,
                       "material uniforms field must be an object");
        return;
    }

    for (const auto& [name, assignment_json] : uniforms_it->items()) {
        const std::string path = base_path + "/" + name;
        if (!valid_uniform_name(name)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration, path,
                           "invalid material uniform name: " + name);
            continue;
        }
        if (shader == nullptr) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownShaderRef, path,
                           "cannot validate material uniform without a known shader");
            continue;
        }
        const auto* declaration = find_uniform_decl(*shader, name);
        if (declaration == nullptr) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UndeclaredUniform, path,
                           "material assigns undeclared shader uniform: " + name);
            continue;
        }

        MaterialUniformAssignment assignment;
        assignment.name = name;
        if (!parse_uniform_value(unwrap_material_value(assignment_json), declaration->type,
                                 assignment.value)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformValue, path,
                           "material uniform value does not match shader declaration: " + name);
            continue;
        }
        material.uniforms.push_back(std::move(assignment));
    }
}

void parse_material_textures(const nlohmann::json& material_json, const ShaderDefinition* shader,
                             MaterialDefinition& material,
                             std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto textures_it = material_json.find("textures");
    if (textures_it == material_json.end())
        return;
    const std::string base_path = "/materials/" + material.id.value() + "/textures";
    if (!textures_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, base_path,
                       "material textures field must be an object");
        return;
    }

    for (const auto& [name, texture_json] : textures_it->items()) {
        const std::string path = base_path + "/" + name;
        if (!valid_sampler_name(name)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidTextureSlotName, path,
                           "invalid material sampler name: " + name);
            continue;
        }
        if (shader == nullptr) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownShaderRef, path,
                           "cannot validate material texture without a known shader");
            continue;
        }
        if (find_sampler_decl(*shader, name) == nullptr) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UndeclaredSampler, path,
                           "material assigns undeclared shader sampler: " + name);
            continue;
        }

        MaterialTextureAssignment assignment;
        assignment.sampler = name;
        const nlohmann::json* source_json = &texture_json;
        if (texture_json.is_object()) {
            const auto source_it = texture_json.find("source");
            if (source_it == texture_json.end()) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField,
                               field_path(path, "source"),
                               "material texture assignment is missing source");
                continue;
            }
            source_json = &*source_it;
            const auto sampler_it = texture_json.find("sampler");
            if (sampler_it != texture_json.end()) {
                if (!sampler_it->is_string()) {
                    add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                                   field_path(path, "sampler"),
                                   "material texture sampler must be a string");
                    continue;
                }
                const auto sampler = parse_texture_sampler(sampler_it->get<std::string_view>());
                if (!sampler) {
                    add_diagnostic(diagnostics, MaterialDiagnosticCode::UnsupportedSampler,
                                   field_path(path, "sampler"),
                                   "unsupported material texture sampler: " +
                                       sampler_it->get<std::string>());
                    continue;
                }
                assignment.filtering = *sampler;
            }
        }
        if (!source_json->is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidTextureSource, path,
                           "material texture source must be a string");
            continue;
        }
        assignment.source = source_json->get<std::string>();
        if (!valid_draw_texture_ref(assignment.source) && !valid_asset_ref(assignment.source)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidTextureSource, path,
                           "invalid material texture source: " + assignment.source);
            continue;
        }
        material.textures.push_back(std::move(assignment));
    }
}

void parse_material_definition(std::string_view id, const nlohmann::json& material_json,
                               ShaderMaterialProject& project,
                               std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto parsed_id = parse_material_id(id);
    if (!parsed_id.ok()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidMaterialId,
                       "/materials/" + std::string(id), "invalid material id: " + std::string(id));
        return;
    }
    if (!material_json.is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                       "/materials/" + std::string(id), "material definition must be an object");
        return;
    }

    MaterialDefinition material;
    material.id = *parsed_id.id;
    const std::string base_path = "/materials/" + material.id.value();

    const auto display_it = material_json.find("display_name");
    if (display_it != material_json.end()) {
        if (display_it->is_string())
            material.display_name = display_it->get<std::string>();
        else
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                           field_path(base_path, "display_name"),
                           "material display_name must be a string");
    }

    const auto role_it = material_json.find("role");
    if (role_it == material_json.end()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField,
                       field_path(base_path, "role"), "material is missing required role field");
    } else if (!role_it->is_string()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                       field_path(base_path, "role"), "material role must be a string");
    } else if (const auto role = parse_shader_role(role_it->get<std::string_view>())) {
        material.role = *role;
        if (deferred_shader_role(*role)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::DeferredShaderRole,
                           field_path(base_path, "role"),
                           "shader role is recognized but deferred: " +
                               role_it->get<std::string>());
        }
    } else {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownShaderRole,
                       field_path(base_path, "role"),
                       "unsupported material shader role: " + role_it->get<std::string>());
    }

    const auto shader_it = material_json.find("shader");
    const ShaderDefinition* shader = nullptr;
    if (shader_it == material_json.end()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField,
                       field_path(base_path, "shader"), "material is missing required shader id");
    } else if (!shader_it->is_string()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                       field_path(base_path, "shader"), "material shader must be a string id");
    } else {
        const auto parsed_shader_id = parse_shader_id(shader_it->get<std::string_view>());
        if (!parsed_shader_id.ok()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidShaderId,
                           field_path(base_path, "shader"),
                           "invalid material shader id: " + shader_it->get<std::string>());
        } else {
            material.shader = *parsed_shader_id.id;
            shader = find_shader(project, material.shader);
            if (shader == nullptr) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownShaderRef,
                               field_path(base_path, "shader"),
                               "material references unknown shader id: " + material.shader.value());
            } else if (!contains_role(*shader, material.role)) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::IncompatibleShaderRole,
                               field_path(base_path, "role"),
                               "material role " + std::string(to_string(material.role)) +
                                   " is not supported by shader " + shader->id.value());
            }
        }
    }

    const auto blend_it = material_json.find("blend");
    if (blend_it != material_json.end()) {
        if (!blend_it->is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                           field_path(base_path, "blend"), "material blend must be a string");
        } else if (const auto blend = parse_blend_mode(blend_it->get<std::string_view>())) {
            material.blend = *blend;
        } else {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UnsupportedBlendPolicy,
                           field_path(base_path, "blend"),
                           "unsupported material blend policy: " + blend_it->get<std::string>());
        }
    }

    parse_material_uniforms(material_json, shader, material, diagnostics);
    parse_material_textures(material_json, shader, material, diagnostics);

    project.materials.push_back(std::move(material));
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

ShaderMaterialProjectParseResult parse_shader_material_project_json(std::string_view source)
{
    try {
        const auto value = nlohmann::json::parse(source);
        return parse_shader_material_project_json_value(value);
    } catch (const nlohmann::json::parse_error& error) {
        ShaderMaterialProjectParseResult result;
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidJson, "",
                       std::string("invalid shader/material JSON: ") + error.what());
        return result;
    }
}

ShaderMaterialProjectParseResult
parse_shader_material_project_json_value(const nlohmann::json& value)
{
    ShaderMaterialProjectParseResult result;
    ShaderMaterialProject project;

    if (!value.is_object()) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidFieldType, "",
                       "shader/material schema root must be an object");
        return result;
    }

    const auto schema_it = value.find("schema");
    if (schema_it == value.end()) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::MissingRequiredField, "/schema",
                       "shader/material schema is missing required schema field");
    } else if (!schema_it->is_string() ||
               schema_it->get<std::string_view>() != shader_material_schema_v1) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidSchema, "/schema",
                       "shader/material schema must be noveltea.shader-materials.v1");
    }

    const auto shaders_it = value.find("shaders");
    if (shaders_it == value.end()) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::MissingRequiredField, "/shaders",
                       "shader/material schema is missing required shaders object");
    } else if (!shaders_it->is_object()) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidFieldType, "/shaders",
                       "shaders field must be an object");
    } else {
        for (const auto& [id, shader_json] : shaders_it->items())
            parse_shader_definition(id, shader_json, project, result.diagnostics);
    }

    const auto materials_it = value.find("materials");
    if (materials_it != value.end()) {
        if (!materials_it->is_object()) {
            add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                           "/materials", "materials field must be an object");
        } else {
            for (const auto& [id, material_json] : materials_it->items())
                parse_material_definition(id, material_json, project, result.diagnostics);
        }
    }

    if (!result.has_errors())
        result.project = std::move(project);
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
    case ShaderInputSemantic::EngineDpiScale:
        return "engine.dpi_scale";
    case ShaderInputSemantic::EnginePointerPosition:
        return "engine.pointer_position";
    case ShaderInputSemantic::EnginePointerValid:
        return "engine.pointer_valid";
    case ShaderInputSemantic::RmlUiPaintDimensions:
        return "rmlui.paint_dimensions";
    case ShaderInputSemantic::RmlUiDpiScale:
        return "rmlui.dpi_scale";
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
