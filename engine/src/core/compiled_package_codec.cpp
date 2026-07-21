#include "noveltea/core/compiled_package.hpp"
#include "noveltea/core/compiled_package_codec.hpp"

#include "noveltea/core/json_access.hpp"
#include "noveltea/core/package_export.hpp"
#include "noveltea/render/shader_manifest.hpp"
#include "noveltea/render/material_codec.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace noveltea::core {
namespace {

constexpr std::string_view package_format = "noveltea.runtime-package";
constexpr std::string_view shader_schema = "noveltea.shader-materials.v1";

class Decoder {
public:
    Decoder(std::string source, std::string prefix)
        : m_source(std::move(source)), m_prefix(std::move(prefix))
    {
    }

    void error(std::string_view suffix, std::string message, std::string pointer)
    {
        m_diagnostics.push_back(Diagnostic{.code = m_prefix + "." + std::string(suffix),
                                           .message = std::move(message),
                                           .severity = ErrorSeverity::Error,
                                           .source_path = m_source,
                                           .json_pointer = std::move(pointer)});
    }

    bool object(const nlohmann::json& value, std::string_view pointer,
                std::initializer_list<std::string_view> fields)
    {
        if (!value.is_object()) {
            error("type", "Expected an object.", std::string(pointer));
            return false;
        }
        for (auto it = value.begin(); it != value.end(); ++it) {
            if (std::find(fields.begin(), fields.end(), std::string_view(it.key())) == fields.end())
                error("unknown_field", "Unknown field '" + it.key() + "'.",
                      child(pointer, it.key()));
        }
        return true;
    }

    const nlohmann::json* required(const nlohmann::json& object, std::string_view field,
                                   std::string_view pointer)
    {
        const auto* value = json_access::member(object, field);
        if (!value)
            error("missing_field", "Missing required field '" + std::string(field) + "'.",
                  child(pointer, field));
        return value;
    }

    std::optional<std::string> string(const nlohmann::json& value, std::string_view pointer,
                                      bool nonempty = false)
    {
        auto result = json_access::get<std::string>(value);
        if (!result || (nonempty && result->empty())) {
            error("type", nonempty ? "Expected a non-empty string." : "Expected a string.",
                  std::string(pointer));
            return std::nullopt;
        }
        return result;
    }

    std::optional<bool> boolean(const nlohmann::json& value, std::string_view pointer)
    {
        auto result = json_access::get<bool>(value);
        if (!result)
            error("type", "Expected a boolean.", std::string(pointer));
        return result;
    }

    std::optional<double> finite_number(const nlohmann::json& value, std::string_view pointer)
    {
        auto result = json_access::get<double>(value);
        if (!result || !std::isfinite(*result)) {
            error("type", "Expected a finite number.", std::string(pointer));
            return std::nullopt;
        }
        return result;
    }

    template<class T>
    std::optional<T> integer(const nlohmann::json& value, std::string_view pointer, bool positive)
    {
        auto result = json_access::get<T>(value);
        if (!result || (positive && *result == 0)) {
            error("type",
                  positive ? "Expected a positive integer." : "Expected a nonnegative integer.",
                  std::string(pointer));
            return std::nullopt;
        }
        return result;
    }

    static std::string child(std::string_view parent, std::string_view field)
    {
        std::string result(parent);
        result.push_back('/');
        for (const char c : field) {
            if (c == '~')
                result += "~0";
            else if (c == '/')
                result += "~1";
            else
                result.push_back(c);
        }
        return result;
    }

    [[nodiscard]] bool failed() const noexcept { return !m_diagnostics.empty(); }
    [[nodiscard]] Diagnostics take() { return std::move(m_diagnostics); }

private:
    std::string m_source;
    std::string m_prefix;
    Diagnostics m_diagnostics;
};

bool is_lower_hex(std::string_view value)
{
    return value.size() == 8 && std::all_of(value.begin(), value.end(), [](const char c) {
               return std::isdigit(static_cast<unsigned char>(c)) || (c >= 'a' && c <= 'f');
           });
}

std::optional<compiled::DisplayOrientation>
decode_orientation(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    auto text = decoder.string(value, pointer);
    if (!text)
        return std::nullopt;
    if (*text == "landscape")
        return compiled::DisplayOrientation::Landscape;
    if (*text == "portrait")
        return compiled::DisplayOrientation::Portrait;
    decoder.error("unknown_value", "Unknown orientation '" + *text + "'.", std::string(pointer));
    return std::nullopt;
}

std::optional<RuntimePackageDisplay> decode_display(Decoder& decoder, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"reference_resolution", "world_raster_policy", "bar_color"}))
        return std::nullopt;
    const auto* resolution = decoder.required(value, "reference_resolution", pointer);
    const auto* raster = decoder.required(value, "world_raster_policy", pointer);
    const auto* color = decoder.required(value, "bar_color", pointer);
    std::optional<std::uint32_t> width;
    std::optional<std::uint32_t> height;
    if (resolution && decoder.object(*resolution, Decoder::child(pointer, "reference_resolution"),
                                     {"width", "height"})) {
        const auto* width_value =
            decoder.required(*resolution, "width", Decoder::child(pointer, "reference_resolution"));
        const auto* height_value = decoder.required(
            *resolution, "height", Decoder::child(pointer, "reference_resolution"));
        if (width_value)
            width = decoder.integer<std::uint32_t>(
                *width_value, Decoder::child(pointer, "reference_resolution/width"), true);
        if (height_value)
            height = decoder.integer<std::uint32_t>(
                *height_value, Decoder::child(pointer, "reference_resolution/height"), true);
        if (width && *width > compiled::max_reference_resolution_dimension) {
            decoder.error("out_of_range", "Reference resolution dimensions must not exceed 10000.",
                          Decoder::child(pointer, "reference_resolution/width"));
            width.reset();
        }
        if (height && *height > compiled::max_reference_resolution_dimension) {
            decoder.error("out_of_range", "Reference resolution dimensions must not exceed 10000.",
                          Decoder::child(pointer, "reference_resolution/height"));
            height.reset();
        }
    }
    std::optional<compiled::WorldRasterPolicy> decoded_raster;
    if (raster) {
        auto text = decoder.string(*raster, Decoder::child(pointer, "world_raster_policy"));
        if (text && *text == "capped")
            decoded_raster = compiled::WorldRasterPolicy::Capped;
        else if (text && *text == "native")
            decoded_raster = compiled::WorldRasterPolicy::Native;
        else if (text)
            decoder.error("unknown_value", "Unknown world raster policy '" + *text + "'.",
                          Decoder::child(pointer, "world_raster_policy"));
    }
    auto decoded_color =
        color ? decoder.string(*color, Decoder::child(pointer, "bar_color"), true) : std::nullopt;
    if (!width || !height || !decoded_raster || !decoded_color)
        return std::nullopt;
    return RuntimePackageDisplay{{*width, *height}, *decoded_raster, std::move(*decoded_color)};
}

std::optional<RuntimePackageAccessibility>
decode_accessibility(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"ui_scale", "text_scale"}))
        return std::nullopt;
    const auto decode_policy =
        [&](std::string_view name) -> std::optional<compiled::AccessibilityScalePolicy> {
        const auto* policy = decoder.required(value, name, pointer);
        const auto policy_pointer = Decoder::child(pointer, name);
        if (!policy || !decoder.object(*policy, policy_pointer, {"enabled", "minimum", "maximum"}))
            return std::nullopt;
        const auto* enabled_value = decoder.required(*policy, "enabled", policy_pointer);
        const auto* minimum_value = decoder.required(*policy, "minimum", policy_pointer);
        const auto* maximum_value = decoder.required(*policy, "maximum", policy_pointer);
        auto enabled = enabled_value ? decoder.boolean(*enabled_value,
                                                       Decoder::child(policy_pointer, "enabled"))
                                     : std::nullopt;
        auto minimum =
            minimum_value
                ? decoder.finite_number(*minimum_value, Decoder::child(policy_pointer, "minimum"))
                : std::nullopt;
        auto maximum =
            maximum_value
                ? decoder.finite_number(*maximum_value, Decoder::child(policy_pointer, "maximum"))
                : std::nullopt;
        if (!enabled || !minimum || !maximum)
            return std::nullopt;
        if (*minimum <= 0.0 || *maximum <= 0.0 || *minimum > *maximum ||
            (*enabled && (*minimum > 1.0 || *maximum < 1.0))) {
            decoder.error("invalid_range",
                          "Accessibility scale ranges must be positive, ordered, and include 1.0 "
                          "when enabled.",
                          policy_pointer);
            return std::nullopt;
        }
        return compiled::AccessibilityScalePolicy{*enabled, *minimum, *maximum};
    };
    auto ui = decode_policy("ui_scale");
    auto text = decode_policy("text_scale");
    if (!ui || !text)
        return std::nullopt;
    return RuntimePackageAccessibility{*ui, *text};
}

std::optional<std::vector<std::string>>
decode_strings(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_array()) {
        decoder.error("type", "Expected an array.", std::string(pointer));
        return std::nullopt;
    }
    std::vector<std::string> result;
    std::unordered_set<std::string> seen;
    for (std::size_t index = 0; index < value.size(); ++index) {
        const auto* item = json_access::element(value, index);
        auto text =
            item ? decoder.string(*item, Decoder::child(pointer, std::to_string(index)), true)
                 : std::nullopt;
        if (!text)
            continue;
        if (!seen.insert(*text).second)
            decoder.error("duplicate", "Duplicate value '" + *text + "'.",
                          Decoder::child(pointer, std::to_string(index)));
        result.push_back(std::move(*text));
    }
    return result;
}

std::optional<RuntimePackagePlatformLaunch>
decode_platform(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"orientation", "desktop", "web", "android"}))
        return std::nullopt;
    const auto* orientation_value = decoder.required(value, "orientation", pointer);
    const auto* desktop = decoder.required(value, "desktop", pointer);
    const auto* web = decoder.required(value, "web", pointer);
    const auto* android = decoder.required(value, "android", pointer);
    auto orientation = orientation_value
                           ? decode_orientation(decoder, *orientation_value,
                                                Decoder::child(pointer, "orientation"))
                           : std::nullopt;
    RuntimePackageDesktopLaunch desktop_result;
    bool desktop_ok = desktop && decoder.object(*desktop, Decoder::child(pointer, "desktop"),
                                                {"initialWidth", "initialHeight", "arguments"});
    if (desktop_ok) {
        const auto* width =
            decoder.required(*desktop, "initialWidth", Decoder::child(pointer, "desktop"));
        const auto* height =
            decoder.required(*desktop, "initialHeight", Decoder::child(pointer, "desktop"));
        const auto* arguments =
            decoder.required(*desktop, "arguments", Decoder::child(pointer, "desktop"));
        auto decoded_width =
            width ? decoder.integer<std::uint32_t>(
                        *width, Decoder::child(pointer, "desktop/initialWidth"), true)
                  : std::nullopt;
        auto decoded_height =
            height ? decoder.integer<std::uint32_t>(
                         *height, Decoder::child(pointer, "desktop/initialHeight"), true)
                   : std::nullopt;
        auto decoded_arguments =
            arguments
                ? decode_strings(decoder, *arguments, Decoder::child(pointer, "desktop/arguments"))
                : std::nullopt;
        desktop_ok = decoded_width && decoded_height && decoded_arguments;
        if (desktop_ok)
            desktop_result = {*decoded_width, *decoded_height, std::move(*decoded_arguments)};
    }

    RuntimePackageWebLaunch web_result;
    bool web_ok =
        web && decoder.object(*web, Decoder::child(pointer, "web"), {"orientation", "query"});
    if (web_ok) {
        const auto* web_orientation =
            decoder.required(*web, "orientation", Decoder::child(pointer, "web"));
        const auto* query = decoder.required(*web, "query", Decoder::child(pointer, "web"));
        auto decoded_orientation =
            web_orientation ? decode_orientation(decoder, *web_orientation,
                                                 Decoder::child(pointer, "web/orientation"))
                            : std::nullopt;
        auto decoded_query =
            query ? decoder.string(*query, Decoder::child(pointer, "web/query"), true)
                  : std::nullopt;
        web_ok = decoded_orientation && decoded_query;
        if (web_ok)
            web_result = {*decoded_orientation, std::move(*decoded_query)};
    }

    RuntimePackageAndroidLaunch android_result;
    bool android_ok =
        android && decoder.object(*android, Decoder::child(pointer, "android"),
                                  {"orientation", "gradleProperty", "screenOrientation"});
    if (android_ok) {
        const auto* android_orientation =
            decoder.required(*android, "orientation", Decoder::child(pointer, "android"));
        const auto* property =
            decoder.required(*android, "gradleProperty", Decoder::child(pointer, "android"));
        const auto* screen =
            decoder.required(*android, "screenOrientation", Decoder::child(pointer, "android"));
        auto decoded_orientation =
            android_orientation ? decode_orientation(decoder, *android_orientation,
                                                     Decoder::child(pointer, "android/orientation"))
                                : std::nullopt;
        auto decoded_property =
            property
                ? decoder.string(*property, Decoder::child(pointer, "android/gradleProperty"), true)
                : std::nullopt;
        auto decoded_screen =
            screen ? decoder.string(*screen, Decoder::child(pointer, "android/screenOrientation"),
                                    true)
                   : std::nullopt;
        android_ok = decoded_orientation && decoded_property && decoded_screen;
        if (android_ok)
            android_result = {*decoded_orientation, std::move(*decoded_property),
                              std::move(*decoded_screen)};
    }
    if (!orientation || !desktop_ok || !web_ok || !android_ok)
        return std::nullopt;
    if (desktop_result.initial_width == 0 || desktop_result.initial_height == 0 ||
        web_result.orientation != *orientation || android_result.orientation != *orientation) {
        decoder.error("inconsistent_platform", "Platform launch orientations must agree.",
                      std::string(pointer));
        return std::nullopt;
    }
    return RuntimePackagePlatformLaunch{*orientation, std::move(desktop_result),
                                        std::move(web_result), std::move(android_result)};
}

void validate_shader_manifest_shape(Decoder& decoder, const nlohmann::json& root)
{
    if (!decoder.object(root, "", {"schema", "shaders", "materials"}))
        return;
    (void)decoder.required(root, "schema", "");
    const auto* shaders = decoder.required(root, "shaders", "");
    const auto* materials = decoder.required(root, "materials", "");
    if (shaders && shaders->is_object()) {
        for (auto shader = shaders->begin(); shader != shaders->end(); ++shader) {
            const auto base = Decoder::child("/shaders", shader.key());
            if (!decoder.object(*shader, base,
                                {"display_name", "stages", "uniforms", "samplers", "roles"}))
                continue;
            if (const auto* stages = json_access::member(*shader, "stages");
                stages && stages->is_object()) {
                for (auto stage = stages->begin(); stage != stages->end(); ++stage)
                    decoder.object(*stage, Decoder::child(base + "/stages", stage.key()),
                                   {"source", "source_text", "compiled"});
            }
            if (const auto* uniforms = json_access::member(*shader, "uniforms");
                uniforms && uniforms->is_object()) {
                for (auto uniform = uniforms->begin(); uniform != uniforms->end(); ++uniform) {
                    const auto path = Decoder::child(base + "/uniforms", uniform.key());
                    if (decoder.object(*uniform, path,
                                       {"type", "default", "range", "binding", "editor"})) {
                        if (const auto* editor = json_access::member(*uniform, "editor"))
                            decoder.object(*editor, path + "/editor", {"label"});
                    }
                }
            }
            if (const auto* samplers = json_access::member(*shader, "samplers");
                samplers && samplers->is_object()) {
                for (auto sampler = samplers->begin(); sampler != samplers->end(); ++sampler)
                    decoder.object(*sampler, Decoder::child(base + "/samplers", sampler.key()),
                                   {"type"});
            }
            if (const auto* roles = json_access::member(*shader, "roles");
                roles && roles->is_object()) {
                for (auto role = roles->begin(); role != roles->end(); ++role)
                    decoder.object(*role, Decoder::child(base + "/roles", role.key()),
                                   {"vertex", "fragment"});
            }
        }
    }
    if (materials && materials->is_object()) {
        for (auto material = materials->begin(); material != materials->end(); ++material) {
            const auto base = Decoder::child("/materials", material.key());
            if (!decoder.object(
                    *material, base,
                    {"display_name", "role", "shader", "uniforms", "textures", "blend"}))
                continue;
            if (const auto* textures = json_access::member(*material, "textures");
                textures && textures->is_object()) {
                for (auto texture = textures->begin(); texture != textures->end(); ++texture) {
                    if (texture->is_object())
                        decoder.object(*texture, Decoder::child(base + "/textures", texture.key()),
                                       {"source", "sampler"});
                }
            }
        }
    }
}

void append_material_diagnostics(Diagnostics& output, const std::vector<MaterialDiagnostic>& input,
                                 std::string_view source)
{
    for (const auto& item : input) {
        output.push_back(Diagnostic{.code = "shader_material." + std::string(to_string(item.code)),
                                    .message = item.message,
                                    .severity = ErrorSeverity::Error,
                                    .source_path = std::string(source),
                                    .json_pointer = item.path});
    }
}

} // namespace

Result<RuntimePackageManifest, Diagnostics>
decode_runtime_package_manifest(const nlohmann::json& value, std::string source_path)
{
    Decoder decoder(std::move(source_path), "runtime_package");
    RuntimePackageManifest output;
    if (!decoder.object(value, "",
                        {"format", "format_version", "kind", "created_by", "project", "display",
                         "accessibility", "platform", "shader_variants", "shader_materials",
                         "entries", "checksums"}))
        return Result<RuntimePackageManifest, Diagnostics>::failure(decoder.take());

    const auto* format = decoder.required(value, "format", "");
    const auto* version = decoder.required(value, "format_version", "");
    const auto* kind = decoder.required(value, "kind", "");
    const auto* created_by = decoder.required(value, "created_by", "");
    const auto* project = decoder.required(value, "project", "");
    const auto* display = decoder.required(value, "display", "");
    const auto* accessibility = decoder.required(value, "accessibility", "");
    const auto* variants = decoder.required(value, "shader_variants", "");
    const auto* entries = decoder.required(value, "entries", "");

    auto decoded_format = format ? decoder.string(*format, "/format") : std::nullopt;
    if (decoded_format && *decoded_format != package_format)
        decoder.error("unsupported_schema", "Unsupported runtime package format.", "/format");
    auto decoded_version =
        version ? decoder.integer<std::uint32_t>(*version, "/format_version", true) : std::nullopt;
    if (decoded_version && *decoded_version != 2)
        decoder.error("unsupported_version", "Unsupported runtime package version.",
                      "/format_version");
    auto decoded_kind = kind ? decoder.string(*kind, "/kind") : std::nullopt;
    if (decoded_kind) {
        if (*decoded_kind == "runtime")
            output.kind = RuntimePackageKind::Runtime;
        else if (*decoded_kind == "editable")
            output.kind = RuntimePackageKind::Editable;
        else
            decoder.error("unknown_value", "Unknown package kind '" + *decoded_kind + "'.",
                          "/kind");
    }
    if (created_by) {
        auto decoded = decoder.string(*created_by, "/created_by", true);
        if (decoded)
            output.created_by = std::move(*decoded);
    }
    if (project && decoder.object(*project, "/project", {"name", "version"})) {
        const auto* name = decoder.required(*project, "name", "/project");
        const auto* project_version = decoder.required(*project, "version", "/project");
        auto decoded_name = name ? decoder.string(*name, "/project/name", true) : std::nullopt;
        auto decoded_project_version =
            project_version ? decoder.string(*project_version, "/project/version", true)
                            : std::nullopt;
        if (decoded_name)
            output.project.name = std::move(*decoded_name);
        if (decoded_project_version)
            output.project.version = std::move(*decoded_project_version);
    }
    if (variants) {
        auto decoded = decode_strings(decoder, *variants, "/shader_variants");
        if (decoded)
            output.shader_variants = std::move(*decoded);
    }
    if (display)
        output.display = decode_display(decoder, *display, "/display");
    if (accessibility)
        output.accessibility = decode_accessibility(decoder, *accessibility, "/accessibility");
    if (const auto* platform = json_access::member(value, "platform"))
        output.platform = decode_platform(decoder, *platform, "/platform");
    if (const auto* shader_materials = json_access::member(value, "shader_materials")) {
        if (decoder.object(*shader_materials, "/shader_materials",
                           {"entry", "schema", "sources_stripped"})) {
            const auto* entry = decoder.required(*shader_materials, "entry", "/shader_materials");
            const auto* schema = decoder.required(*shader_materials, "schema", "/shader_materials");
            const auto* stripped =
                decoder.required(*shader_materials, "sources_stripped", "/shader_materials");
            auto decoded_entry =
                entry ? decoder.string(*entry, "/shader_materials/entry", true) : std::nullopt;
            auto decoded_schema =
                schema ? decoder.string(*schema, "/shader_materials/schema", true) : std::nullopt;
            auto decoded_stripped =
                stripped ? decoder.boolean(*stripped, "/shader_materials/sources_stripped")
                         : std::nullopt;
            if (decoded_entry && !ProjectPackageWriter::is_allowed_package_path(*decoded_entry))
                decoder.error(
                    "invalid_path",
                    "Shader/material entry path is unsafe or outside the runtime package layout.",
                    "/shader_materials/entry");
            if (decoded_schema && *decoded_schema != shader_schema)
                decoder.error("unsupported_schema", "Unsupported shader/material schema.",
                              "/shader_materials/schema");
            if (decoded_entry && decoded_schema && decoded_stripped)
                output.shader_materials = RuntimePackageShaderMaterials{
                    std::move(*decoded_entry), std::move(*decoded_schema), *decoded_stripped};
        }
    }

    std::unordered_map<std::string, std::string> checksums;
    if (const auto* checksum_object = json_access::member(value, "checksums")) {
        if (!checksum_object->is_object())
            decoder.error("type", "Expected an object.", "/checksums");
        else {
            for (auto checksum = checksum_object->begin(); checksum != checksum_object->end();
                 ++checksum) {
                const auto path = Decoder::child("/checksums", checksum.key());
                auto text = decoder.string(*checksum, path);
                if (!ProjectPackageWriter::is_safe_package_path(checksum.key()))
                    decoder.error("unsafe_path", "Checksum path is unsafe.", path);
                if (text && !is_lower_hex(*text))
                    decoder.error("invalid_checksum", "Checksum must be lowercase CRC32 hex.",
                                  path);
                if (text)
                    checksums.emplace(checksum.key(), std::move(*text));
            }
        }
    }
    if (entries) {
        if (!entries->is_array())
            decoder.error("type", "Expected an array.", "/entries");
        else {
            std::unordered_set<std::string> paths;
            for (std::size_t index = 0; index < entries->size(); ++index) {
                const auto* entry = json_access::element(*entries, index);
                const std::string pointer = "/entries/" + std::to_string(index);
                if (!entry || !decoder.object(*entry, pointer, {"path", "size"}))
                    continue;
                const auto* path_value = decoder.required(*entry, "path", pointer);
                const auto* size_value = decoder.required(*entry, "size", pointer);
                auto path = path_value ? decoder.string(*path_value, pointer + "/path", true)
                                       : std::nullopt;
                auto size = size_value ? decoder.integer<std::uint64_t>(*size_value,
                                                                        pointer + "/size", false)
                                       : std::nullopt;
                if (path && !ProjectPackageWriter::is_allowed_package_path(*path))
                    decoder.error(
                        "invalid_path",
                        "Package entry path is unsafe or outside the runtime package layout.",
                        pointer + "/path");
                if (path && !paths.insert(*path).second)
                    decoder.error("duplicate_entry", "Duplicate package entry '" + *path + "'.",
                                  pointer + "/path");
                if (path && size) {
                    std::optional<std::string> checksum;
                    if (!checksums.empty()) {
                        const auto found = checksums.find(*path);
                        if (found == checksums.end())
                            decoder.error("missing_checksum", "Package entry checksum is missing.",
                                          pointer + "/path");
                        else
                            checksum = found->second;
                    }
                    output.entries.push_back({std::move(*path), *size, std::move(checksum)});
                }
            }
            for (const auto& [path, checksum] : checksums) {
                if (!paths.contains(path))
                    decoder.error("orphan_checksum", "Checksum has no matching package entry.",
                                  Decoder::child("/checksums", path));
            }
        }
    }
    if (decoder.failed())
        return Result<RuntimePackageManifest, Diagnostics>::failure(decoder.take());
    return Result<RuntimePackageManifest, Diagnostics>::success(std::move(output));
}

Result<ShaderMaterialProject, Diagnostics>
decode_shader_material_manifest(const nlohmann::json& value, std::string source_path)
{
    Decoder strict(source_path, "shader_material");
    validate_shader_manifest_shape(strict, value);
    if (strict.failed())
        return Result<ShaderMaterialProject, Diagnostics>::failure(strict.take());
    auto parsed = parse_shader_material_project_json_value(value);
    if (!parsed.project || parsed.has_errors()) {
        Diagnostics diagnostics;
        append_material_diagnostics(diagnostics, parsed.diagnostics, source_path);
        return Result<ShaderMaterialProject, Diagnostics>::failure(std::move(diagnostics));
    }
    return Result<ShaderMaterialProject, Diagnostics>::success(std::move(*parsed.project));
}

} // namespace noveltea::core
