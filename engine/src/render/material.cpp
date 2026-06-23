#include "noveltea/render/material.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <charconv>
#include <cctype>
#include <cmath>
#include <limits>
#include <optional>
#include <string>
#include <string_view>

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

[[nodiscard]] bool valid_texture_slot_name(std::string_view value)
{
    return has_prefix(value, "s_") && valid_identifier(value);
}

[[nodiscard]] std::optional<MaterialType> parse_material_type(std::string_view type)
{
    if (type == "engine-2d")
        return MaterialType::Engine2D;
    if (type == "rmlui-decorator")
        return MaterialType::RmlUiDecorator;
    if (type == "rmlui-filter")
        return MaterialType::RmlUiFilter;
    if (type == "postprocess")
        return MaterialType::Postprocess;
    return std::nullopt;
}

[[nodiscard]] bool deferred_material_type(MaterialType type)
{
    return type == MaterialType::RmlUiFilter || type == MaterialType::Postprocess;
}

[[nodiscard]] std::optional<MaterialUniformType> parse_uniform_type(std::string_view type)
{
    if (type == "float")
        return MaterialUniformType::Float;
    if (type == "vec2")
        return MaterialUniformType::Vec2;
    if (type == "vec3")
        return MaterialUniformType::Vec3;
    if (type == "vec4")
        return MaterialUniformType::Vec4;
    if (type == "color")
        return MaterialUniformType::Color;
    if (type == "int")
        return MaterialUniformType::Int;
    if (type == "bool")
        return MaterialUniformType::Bool;
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

[[nodiscard]] std::optional<MaterialInputSemantic> parse_input_semantic(std::string_view semantic)
{
    if (semantic == "engine.time")
        return MaterialInputSemantic::EngineTime;
    if (semantic == "rmlui.paint_dimensions")
        return MaterialInputSemantic::RmlUiPaintDimensions;
    if (semantic == "rmlui.dpi_scale")
        return MaterialInputSemantic::RmlUiDpiScale;
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

[[nodiscard]] std::optional<MaterialColor> parse_color(std::string_view value)
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
    return MaterialColor{static_cast<float>(*r) * inv, static_cast<float>(*g) * inv,
                         static_cast<float>(*b) * inv, static_cast<float>(*a) * inv};
}

[[nodiscard]] bool parse_uniform_default(const nlohmann::json& value, MaterialUniformType type,
                                         MaterialUniformValue& out)
{
    switch (type) {
    case MaterialUniformType::Float: {
        const auto parsed = json_float(value);
        if (!parsed)
            return false;
        out = *parsed;
        return true;
    }
    case MaterialUniformType::Vec2: {
        const auto parsed = parse_vec2(value);
        if (!parsed)
            return false;
        out = *parsed;
        return true;
    }
    case MaterialUniformType::Vec3: {
        const auto parsed = parse_vec3(value);
        if (!parsed)
            return false;
        out = *parsed;
        return true;
    }
    case MaterialUniformType::Vec4: {
        const auto parsed = parse_vec4(value);
        if (!parsed)
            return false;
        out = *parsed;
        return true;
    }
    case MaterialUniformType::Color:
        if (!value.is_string())
            return false;
        if (const auto parsed = parse_color(value.get<std::string_view>())) {
            out = *parsed;
            return true;
        }
        return false;
    case MaterialUniformType::Int:
        if (!value.is_number_integer())
            return false;
        out = value.get<int>();
        return true;
    case MaterialUniformType::Bool:
        if (!value.is_boolean())
            return false;
        out = value.get<bool>();
        return true;
    }
    return false;
}

[[nodiscard]] std::string field_path(std::string_view parent, std::string_view field)
{
    std::string path(parent);
    path += '/';
    path += field;
    return path;
}

void parse_shader_refs(const nlohmann::json& root, MaterialAsset& material,
                       std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto shader_it = root.find("shader");
    if (shader_it == root.end()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField, "/shader",
                       "material is missing required shader object");
        return;
    }
    if (!shader_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, "/shader",
                       "material shader field must be an object");
        return;
    }

    for (const std::string_view stage :
         {std::string_view("vertex"), std::string_view("fragment")}) {
        const auto stage_it = shader_it->find(stage);
        const std::string path = field_path("/shader", stage);
        if (stage_it == shader_it->end()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField, path,
                           "material shader is missing required " + std::string(stage) +
                               " source reference");
            continue;
        }
        if (!stage_it->is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, path,
                           "material shader " + std::string(stage) +
                               " source reference must be a string");
            continue;
        }
        const std::string source = stage_it->get<std::string>();
        if (!valid_asset_ref(source)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidShaderRef, path,
                           "invalid material shader " + std::string(stage) +
                               " source reference: " + source);
            continue;
        }
        if (stage == "vertex")
            material.shader.vertex.path = source;
        else
            material.shader.fragment.path = source;
    }
}

void parse_uniforms(const nlohmann::json& root, MaterialAsset& material,
                    std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto uniforms_it = root.find("uniforms");
    if (uniforms_it == root.end())
        return;
    if (!uniforms_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, "/uniforms",
                       "material uniforms field must be an object");
        return;
    }

    for (const auto& [name, uniform_json] : uniforms_it->items()) {
        const std::string path = "/uniforms/" + name;
        if (!valid_uniform_name(name)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration, path,
                           "invalid material uniform name: " + name);
            continue;
        }
        if (!uniform_json.is_object()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration, path,
                           "material uniform declaration must be an object");
            continue;
        }
        const auto type_it = uniform_json.find("type");
        if (type_it == uniform_json.end()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField,
                           field_path(path, "type"),
                           "material uniform is missing required type field");
            continue;
        }
        if (!type_it->is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration,
                           field_path(path, "type"), "material uniform type must be a string");
            continue;
        }
        const auto uniform_type = parse_uniform_type(type_it->get<std::string_view>());
        if (!uniform_type) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration,
                           field_path(path, "type"),
                           "unsupported material uniform type: " + type_it->get<std::string>());
            continue;
        }

        MaterialUniform uniform;
        uniform.name = name;
        uniform.type = *uniform_type;

        const auto default_it = uniform_json.find("default");
        if (default_it == uniform_json.end()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField,
                           field_path(path, "default"),
                           "material uniform is missing required default value");
            continue;
        }
        if (!parse_uniform_default(*default_it, *uniform_type, uniform.default_value)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDefault,
                           field_path(path, "default"),
                           "material uniform default does not match type " +
                               std::string(to_string(*uniform_type)));
            continue;
        }

        const auto range_it = uniform_json.find("range");
        if (range_it != uniform_json.end()) {
            const auto range = parse_vec2(*range_it);
            if (!range || (*range)[0] > (*range)[1]) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration,
                               field_path(path, "range"),
                               "material uniform range must be [min, max] numbers with min <= max");
                continue;
            }
            uniform.range = *range;
        }

        const auto editor_it = uniform_json.find("editor");
        if (editor_it != uniform_json.end()) {
            if (!editor_it->is_object()) {
                add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration,
                               field_path(path, "editor"),
                               "material uniform editor field must be an object");
                continue;
            }
            const auto label_it = editor_it->find("label");
            if (label_it != editor_it->end()) {
                if (!label_it->is_string()) {
                    add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration,
                                   field_path(field_path(path, "editor"), "label"),
                                   "material uniform editor label must be a string");
                    continue;
                }
                uniform.editor_label = label_it->get<std::string>();
            }
        }

        material.uniforms.push_back(std::move(uniform));
    }
}

void parse_textures(const nlohmann::json& root, MaterialAsset& material,
                    std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto textures_it = root.find("textures");
    if (textures_it == root.end())
        return;
    if (!textures_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, "/textures",
                       "material textures field must be an object");
        return;
    }

    for (const auto& [name, texture_json] : textures_it->items()) {
        const std::string path = "/textures/" + name;
        if (!valid_texture_slot_name(name)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidTextureSlotName, path,
                           "invalid material texture slot name: " + name);
            continue;
        }
        if (!texture_json.is_object()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, path,
                           "material texture slot declaration must be an object");
            continue;
        }

        MaterialTextureSlot slot;
        slot.name = name;

        const auto source_it = texture_json.find("source");
        if (source_it == texture_json.end()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField,
                           field_path(path, "source"),
                           "material texture slot is missing required source field");
            continue;
        }
        if (!source_it->is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidTextureSource,
                           field_path(path, "source"),
                           "material texture slot source must be a string");
            continue;
        }
        slot.source = source_it->get<std::string>();
        if (slot.source != "$draw.texture" && !valid_asset_ref(slot.source)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidTextureSource,
                           field_path(path, "source"),
                           "invalid material texture source: " + slot.source);
            continue;
        }

        const auto sampler_it = texture_json.find("sampler");
        if (sampler_it == texture_json.end()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField,
                           field_path(path, "sampler"),
                           "material texture slot is missing required sampler field");
            continue;
        }
        if (!sampler_it->is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UnsupportedSampler,
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
        slot.sampler = *sampler;
        material.textures.push_back(std::move(slot));
    }
}

void parse_inputs(const nlohmann::json& root, MaterialAsset& material,
                  std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto inputs_it = root.find("inputs");
    if (inputs_it == root.end())
        return;
    if (!inputs_it->is_object()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidFieldType, "/inputs",
                       "material inputs field must be an object");
        return;
    }

    for (const auto& [name, semantic_json] : inputs_it->items()) {
        const std::string path = "/inputs/" + name;
        if (!valid_uniform_name(name)) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::InvalidUniformDeclaration, path,
                           "material input binding key must be a uniform name: " + name);
            continue;
        }
        if (!semantic_json.is_string()) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownInputBinding, path,
                           "material input binding value must be a string");
            continue;
        }
        const auto semantic = parse_input_semantic(semantic_json.get<std::string_view>());
        if (!semantic) {
            add_diagnostic(diagnostics, MaterialDiagnosticCode::UnknownInputBinding, path,
                           "unknown material input binding: " + semantic_json.get<std::string>());
            continue;
        }
        material.inputs.push_back(MaterialInputBinding{name, *semantic});
    }
}

void parse_blend(const nlohmann::json& root, MaterialAsset& material,
                 std::vector<MaterialDiagnostic>& diagnostics)
{
    const auto blend_it = root.find("blend");
    if (blend_it == root.end()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::MissingRequiredField, "/blend",
                       "material is missing required blend policy");
        return;
    }
    if (!blend_it->is_string()) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::UnsupportedBlendPolicy, "/blend",
                       "material blend policy must be a string");
        return;
    }
    const auto blend = parse_blend_mode(blend_it->get<std::string_view>());
    if (!blend) {
        add_diagnostic(diagnostics, MaterialDiagnosticCode::UnsupportedBlendPolicy, "/blend",
                       "unsupported material blend policy: " + blend_it->get<std::string>());
        return;
    }
    material.blend = *blend;
}

} // namespace

bool MaterialParseResult::has_errors() const noexcept
{
    return std::any_of(diagnostics.begin(), diagnostics.end(),
                       [](const MaterialDiagnostic& diagnostic) {
                           return diagnostic.severity == MaterialDiagnosticSeverity::Error;
                       });
}

MaterialIdParseResult parse_material_id(std::string_view reference)
{
    MaterialIdParseResult result;
    if (reference.empty()) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidMaterialId, "",
                       "material id is empty");
        return result;
    }

    LogicalAssetRef parsed;
    if (!parse_logical_asset_ref(reference, parsed)) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidMaterialId, "",
                       "invalid material id: " + std::string(reference));
        return result;
    }

    std::string ns = parsed.namespace_name.empty() ? "project" : parsed.namespace_name;
    std::string relative = std::move(parsed.relative_path);

    if (parsed.namespace_name.empty()) {
        if (!has_prefix(relative, "materials/"))
            relative = "materials/" + relative;
        if (!has_suffix(relative, ".ntmat")) {
            const std::size_t slash = relative.rfind('/');
            const std::string_view filename = slash == std::string::npos
                                                  ? std::string_view(relative)
                                                  : std::string_view(relative).substr(slash + 1);
            if (filename.find('.') != std::string_view::npos) {
                add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidMaterialId, "",
                               "material id must use .ntmat extension: " + std::string(reference));
                return result;
            }
            relative += ".ntmat";
        }
    }

    if (!has_prefix(relative, "materials/")) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidMaterialId, "",
                       "explicit material id must reference materials/: " + std::string(reference));
        return result;
    }
    if (!has_suffix(relative, ".ntmat")) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidMaterialId, "",
                       "material id must use .ntmat extension: " + std::string(reference));
        return result;
    }

    LogicalAssetRef normalized_ref;
    const std::string normalized = ns + ":/" + relative;
    if (!parse_logical_asset_ref(normalized, normalized_ref)) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidMaterialId, "",
                       "invalid normalized material id: " + normalized);
        return result;
    }

    result.id = MaterialId(normalized);
    return result;
}

MaterialParseResult parse_material_json(std::string_view source,
                                        std::string_view material_reference)
{
    try {
        const nlohmann::json value = nlohmann::json::parse(source.begin(), source.end());
        return parse_material_json_value(value, material_reference);
    } catch (const nlohmann::json::parse_error& error) {
        MaterialParseResult result;
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidJson, "",
                       std::string("invalid material JSON: ") + error.what());
        return result;
    }
}

MaterialParseResult parse_material_json_value(const nlohmann::json& value,
                                              std::string_view material_reference)
{
    MaterialParseResult result;
    MaterialAsset material;

    if (!material_reference.empty()) {
        MaterialIdParseResult id_result = parse_material_id(material_reference);
        result.diagnostics.insert(result.diagnostics.end(), id_result.diagnostics.begin(),
                                  id_result.diagnostics.end());
        if (id_result.id)
            material.id = std::move(*id_result.id);
    }

    if (!value.is_object()) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidFieldType, "",
                       "material JSON root must be an object");
        return result;
    }

    const auto schema_it = value.find("schema");
    if (schema_it == value.end()) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::MissingRequiredField, "/schema",
                       "material is missing required schema field");
    } else if (!schema_it->is_string() ||
               schema_it->get<std::string_view>() != material_schema_v1) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidSchema, "/schema",
                       "material schema must be noveltea.material.v1");
    }

    const auto type_it = value.find("type");
    if (type_it == value.end()) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::MissingRequiredField, "/type",
                       "material is missing required type field");
    } else if (!type_it->is_string()) {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidFieldType, "/type",
                       "material type field must be a string");
    } else if (const auto type = parse_material_type(type_it->get<std::string_view>())) {
        material.type = *type;
        if (deferred_material_type(*type)) {
            add_diagnostic(
                result.diagnostics, MaterialDiagnosticCode::DeferredMaterialType, "/type",
                "material type is recognized but deferred: " + type_it->get<std::string>());
        }
    } else {
        add_diagnostic(result.diagnostics, MaterialDiagnosticCode::UnknownMaterialType, "/type",
                       "unknown material type: " + type_it->get<std::string>());
    }

    const auto display_name_it = value.find("display_name");
    if (display_name_it != value.end()) {
        if (!display_name_it->is_string()) {
            add_diagnostic(result.diagnostics, MaterialDiagnosticCode::InvalidFieldType,
                           "/display_name", "material display_name must be a string");
        } else {
            material.display_name = display_name_it->get<std::string>();
        }
    }

    parse_shader_refs(value, material, result.diagnostics);
    parse_uniforms(value, material, result.diagnostics);
    parse_textures(value, material, result.diagnostics);
    parse_inputs(value, material, result.diagnostics);
    parse_blend(value, material, result.diagnostics);

    if (!result.has_errors())
        result.material = std::move(material);
    return result;
}

MaterialAsset make_engine_2d_fallback_material()
{
    MaterialAsset material;
    material.id = MaterialId("system:/materials/fallback/engine_2d_error.ntmat");
    material.type = MaterialType::Engine2D;
    material.display_name = "Engine 2D Fallback";
    material.shader.vertex.path = "system:/shaders/materials/engine_2d.vs.sc";
    material.shader.fragment.path = "system:/shaders/materials/fallback_checker.fs.sc";
    material.blend = MaterialBlendMode::PremultipliedAlpha;
    material.fallback = true;
    material.uniforms.push_back(MaterialUniform{"u_tint", MaterialUniformType::Color,
                                                MaterialColor{1.0f, 0.0f, 1.0f, 1.0f}, std::nullopt,
                                                "Tint"});
    return material;
}

MaterialAsset make_rmlui_decorator_fallback_material()
{
    MaterialAsset material;
    material.id = MaterialId("system:/materials/fallback/rmlui_decorator_error.ntmat");
    material.type = MaterialType::RmlUiDecorator;
    material.display_name = "RmlUi Decorator Fallback";
    material.shader.vertex.path = "system:/shaders/materials/rmlui_decorator.vs.sc";
    material.shader.fragment.path = "system:/shaders/materials/fallback_checker.fs.sc";
    material.blend = MaterialBlendMode::PremultipliedAlpha;
    material.fallback = true;
    material.inputs.push_back(
        MaterialInputBinding{"u_dimensions", MaterialInputSemantic::RmlUiPaintDimensions});
    material.uniforms.push_back(MaterialUniform{"u_tint", MaterialUniformType::Color,
                                                MaterialColor{1.0f, 0.0f, 1.0f, 1.0f}, std::nullopt,
                                                "Tint"});
    return material;
}

std::string_view to_string(MaterialDiagnosticCode code) noexcept
{
    switch (code) {
    case MaterialDiagnosticCode::InvalidMaterialId:
        return "invalid-material-id";
    case MaterialDiagnosticCode::InvalidJson:
        return "invalid-json";
    case MaterialDiagnosticCode::InvalidSchema:
        return "invalid-schema";
    case MaterialDiagnosticCode::MissingRequiredField:
        return "missing-required-field";
    case MaterialDiagnosticCode::InvalidFieldType:
        return "invalid-field-type";
    case MaterialDiagnosticCode::UnknownMaterialType:
        return "unknown-material-type";
    case MaterialDiagnosticCode::DeferredMaterialType:
        return "deferred-material-type";
    case MaterialDiagnosticCode::InvalidShaderRef:
        return "invalid-shader-ref";
    case MaterialDiagnosticCode::InvalidUniformDeclaration:
        return "invalid-uniform-declaration";
    case MaterialDiagnosticCode::InvalidUniformDefault:
        return "invalid-uniform-default";
    case MaterialDiagnosticCode::InvalidTextureSlotName:
        return "invalid-texture-slot-name";
    case MaterialDiagnosticCode::InvalidTextureSource:
        return "invalid-texture-source";
    case MaterialDiagnosticCode::UnsupportedSampler:
        return "unsupported-sampler";
    case MaterialDiagnosticCode::UnknownInputBinding:
        return "unknown-input-binding";
    case MaterialDiagnosticCode::UnsupportedBlendPolicy:
        return "unsupported-blend-policy";
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

std::string_view to_string(MaterialType type) noexcept
{
    switch (type) {
    case MaterialType::Engine2D:
        return "engine-2d";
    case MaterialType::RmlUiDecorator:
        return "rmlui-decorator";
    case MaterialType::RmlUiFilter:
        return "rmlui-filter";
    case MaterialType::Postprocess:
        return "postprocess";
    }
    return "unknown";
}

std::string_view to_string(MaterialUniformType type) noexcept
{
    switch (type) {
    case MaterialUniformType::Float:
        return "float";
    case MaterialUniformType::Vec2:
        return "vec2";
    case MaterialUniformType::Vec3:
        return "vec3";
    case MaterialUniformType::Vec4:
        return "vec4";
    case MaterialUniformType::Color:
        return "color";
    case MaterialUniformType::Int:
        return "int";
    case MaterialUniformType::Bool:
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

std::string_view to_string(MaterialInputSemantic semantic) noexcept
{
    switch (semantic) {
    case MaterialInputSemantic::EngineTime:
        return "engine.time";
    case MaterialInputSemantic::RmlUiPaintDimensions:
        return "rmlui.paint_dimensions";
    case MaterialInputSemantic::RmlUiDpiScale:
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
