#include "native_runtime_physical.hpp"
#include "native_runtime_media.hpp"
#include "embedded_material_registry.hpp"

#include "source_authority.hpp"
#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/render/shader_compiler.hpp>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <set>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;
namespace fs = std::filesystem;

struct PreparationError : std::runtime_error {
    std::string code;
    std::string path;
    PreparationError(std::string reason, std::string location, std::string message)
        : std::runtime_error(std::move(message)), code(std::move(reason)), path(std::move(location))
    {
    }
};

[[nodiscard]] Json diagnostic(std::string code, std::string severity, std::string path,
                              std::string message, std::string category)
{
    return {{"code", std::move(code)},
            {"severity", std::move(severity)},
            {"path", path},
            {"message", std::move(message)},
            {"category", std::move(category)},
            {"boundaries", Json::array({"runtime-package", "platform-export"})},
            {"ownerPaths", Json::array({path})}};
}

[[nodiscard]] bool safe_relative(std::string_view value)
{
    if (value.empty() || value.front() == '/' || value.find('\\') != value.npos ||
        value.find(':') != value.npos)
        return false;
    const fs::path path{value};
    if (path.is_absolute() || path.has_root_path())
        return false;
    for (const auto& part : path)
        if (part == ".." || part == "." || part.empty())
            return false;
    return true;
}

[[nodiscard]] fs::path checked_source(const fs::path& root, const std::string& relative)
{
    if (!safe_relative(relative))
        throw PreparationError("runtime-artifact.physical-source.unsafe", "/artifact/fileEntries",
                               "Unsafe Project source path: '" + relative + "'.");
    auto cursor = root;
    for (const auto& part : fs::path(relative)) {
        cursor /= part;
        std::error_code ec;
        if (fs::is_symlink(fs::symlink_status(cursor, ec)))
            throw PreparationError("runtime-artifact.physical-source.unsafe",
                                   "/artifact/fileEntries",
                                   "Project source contains a symlink: '" + relative + "'.");
    }
    if (!fs::is_regular_file(cursor))
        throw PreparationError("runtime-artifact.physical-source.missing", "/artifact/fileEntries",
                               "Missing Project source: '" + relative + "'.");
    return cursor;
}

[[nodiscard]] std::string read_bytes(const fs::path& path, std::uintmax_t max_bytes)
{
    if (fs::file_size(path) > max_bytes)
        throw PreparationError("runtime-artifact.physical-source.limit", "/artifact/fileEntries",
                               "Project source exceeds the preparation size limit: '" +
                                   path.generic_string() + "'.");
    std::ifstream stream(path, std::ios::binary);
    if (!stream)
        throw PreparationError("runtime-artifact.physical-source.missing", "/artifact/fileEntries",
                               "Cannot read Project source: '" + path.generic_string() + "'.");
    const std::string bytes{std::istreambuf_iterator<char>{stream},
                            std::istreambuf_iterator<char>{}};
    if (stream.bad())
        throw PreparationError("runtime-artifact.physical-source.missing", "/artifact/fileEntries",
                               "Cannot finish Project source: '" + path.generic_string() + "'.");
    return bytes;
}

[[nodiscard]] std::string sha256(std::string_view bytes)
{
    return "sha256:" + core::sha256_hex(std::as_bytes(std::span(bytes.data(), bytes.size())));
}

[[nodiscard]] std::string check_revision(const fs::path& root, const Json& revisions,
                                         const std::string& relative,
                                         std::uintmax_t max_bytes = 256ull * 1024 * 1024)
{
    if (!revisions.contains(relative) || !revisions.at(relative).is_string())
        throw PreparationError("runtime-artifact.physical-source.unpinned", "/sourceRevisions",
                               "Project source was not admitted: '" + relative + "'.");
    const auto bytes = read_bytes(checked_source(root, relative), max_bytes);
    // Local admission identities may be XXH3-128 or legacy SHA-256. The
    // package manifest still requires an independent cryptographic SHA-256.
    if (!authoring::source_revision_matches(bytes, revisions.at(relative).get<std::string>()))
        throw PreparationError("runtime-artifact.physical-source.stale", "/sourceRevisions",
                               "Project source changed after admission: '" + relative + "'.");
    return sha256(bytes);
}

[[nodiscard]] std::string relative_source(const fs::path& root, const std::string& value)
{
    const fs::path path{value};
    if (!path.is_absolute()) {
        if (safe_relative(value))
            return value;
    } else {
        fs::path source_for_containment = path;
#if defined(__APPLE__)
        // macOS exposes /var and /tmp through system-owned /private aliases.
        // Resolve only those verified aliases; checked_source still rejects
        // symlinks anywhere below the canonical Project root.
        const auto first = std::next(path.begin());
        if (first != path.end() && (*first == "var" || *first == "tmp")) {
            const auto alias = path.root_path() / *first;
            std::error_code ec;
            if (fs::is_symlink(fs::symlink_status(alias, ec)) && !ec) {
                const auto canonical_alias = fs::canonical(alias, ec);
                if (!ec && canonical_alias == path.root_path() / "private" / *first)
                    source_for_containment = canonical_alias / path.lexically_relative(alias);
            }
        }
#endif
        const auto relative = source_for_containment.lexically_relative(root);
        if (!relative.empty() && relative != "." && *relative.begin() != fs::path("..") &&
            safe_relative(relative.generic_string()))
            return relative.generic_string();
        // Windows may serialize an absolute Project source through an 8.3
        // alias (RUNNER~1) while fs::canonical(root) expands that alias. The
        // paths still refer to the same file, even though lexical comparison
        // fails. Reject symlink components BEFORE resolving the alias so a
        // source cannot be admitted through a link inside or outside root.
        for (auto cursor = path;;) {
            std::error_code ec;
            if (fs::is_symlink(fs::symlink_status(cursor, ec)))
                throw PreparationError("runtime-artifact.physical-source.unsafe",
                                       "/artifact/fileEntries",
                                       "Project source contains a symlink: '" + value + "'.");
            const auto parent = cursor.parent_path();
            if (parent.empty() || parent == cursor)
                break;
            cursor = parent;
        }
        std::error_code ec;
        const auto canonical = fs::canonical(path, ec);
        if (!ec) {
            const auto resolved = canonical.lexically_relative(root);
            if (!resolved.empty() && resolved != "." && *resolved.begin() != fs::path("..") &&
                safe_relative(resolved.generic_string()))
                return resolved.generic_string();
        }
    }
    throw PreparationError("runtime-artifact.physical-source.unsafe", "/artifact/fileEntries",
                           "Runtime source is outside the admitted Project: '" + value + "'.");
}

[[nodiscard]] bool valid_utf8(std::string_view bytes)
{
    for (std::size_t i = 0; i < bytes.size();) {
        const auto lead = static_cast<unsigned char>(bytes[i++]);
        if (lead < 0x80)
            continue;
        const unsigned length = lead >= 0xc2 && lead <= 0xdf   ? 1
                                : lead >= 0xe0 && lead <= 0xef ? 2
                                : lead >= 0xf0 && lead <= 0xf4 ? 3
                                                               : 0;
        if (!length || i + length > bytes.size())
            return false;
        unsigned code = lead & (length == 1 ? 0x1f : length == 2 ? 0x0f : 0x07);
        for (unsigned j = 0; j < length; ++j) {
            const auto continuation = static_cast<unsigned char>(bytes[i++]);
            if ((continuation & 0xc0) != 0x80)
                return false;
            code = (code << 6) | (continuation & 0x3f);
        }
        if ((length == 1 && code < 0x80) || (length == 2 && code < 0x800) ||
            (length == 3 && code < 0x10000) || code > 0x10ffff ||
            (code >= 0xd800 && code <= 0xdfff) || (code >= 0x7f && code <= 0x9f))
            return false;
    }
    return true;
}

void prepare_notices(Json& artifact, const Json& project, const Json& revisions,
                     const fs::path& root)
{
    // Keep the ordering of authored notices and attached Asset notices stable
    // regardless of the filesystem's enumeration order.
    std::map<std::string, std::pair<std::string, bool>> notices;
    const auto add = [&](const Json& notice) {
        const auto path = notice.at("path").get<std::string>();
        const auto extension = fs::path(path).extension().string();
        std::string lower = extension;
        std::transform(lower.begin(), lower.end(), lower.begin(),
                       [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        if (!safe_relative(path) || (lower != ".txt" && lower != ".md"))
            throw PreparationError("runtime-package.distribution-notice.invalid",
                                   "/settings/distributionNotices",
                                   "Invalid distribution notice path: '" + path + "'.");
        const auto name = notice.value("displayName", std::string{});
        const auto found = notices.find(path);
        if (found != notices.end() && found->second.second && !name.empty() &&
            found->second.first != name)
            throw PreparationError("runtime-package.distribution-notice.invalid",
                                   "/settings/distributionNotices",
                                   "Conflicting distribution notice names: '" + path + "'.");
        if (found == notices.end() || (!found->second.second && !name.empty()))
            notices[path] = {name.empty() ? fs::path(path).filename().string() : name,
                             !name.empty()};
    };
    const auto& settings = project.at("settings");
    for (const auto& notice : settings.value("distributionNotices", Json::array()))
        add(notice);
    for (const auto& entry : artifact.at("fileEntries")) {
        if (entry.at("kind") == "script-source" || entry.at("kind") == "shader-source")
            continue;
        const auto id = entry.at("assetId").get<std::string>();
        if (!project.at("assets").contains(id))
            continue;
        const auto& asset = project.at("assets").at(id).at("data");
        for (const auto& attachment : asset.value("attachments", Json::array()))
            if (attachment.value("purpose", "") == "distribution-notice")
                add(attachment);
    }
    if (notices.size() > 512)
        throw PreparationError("runtime-package.distribution-notice.invalid",
                               "/settings/distributionNotices",
                               "Distribution notices exceed the runtime 512-entry limit.");
    Json index = Json::array();
    for (const auto& [relative, name] : notices) {
        const auto path = checked_source(root, relative);
        const auto bytes = read_bytes(path, 1024 * 1024);
        if (bytes.empty() || !valid_utf8(bytes) ||
            std::any_of(bytes.begin(), bytes.end(), [](unsigned char ch) {
                return (ch < 32 && ch != 9 && ch != 10 && ch != 13) || ch == 127;
            }))
            throw PreparationError(
                "runtime-package.distribution-notice.invalid", "/settings/distributionNotices",
                "Distribution notice is empty or invalid UTF-8/text: '" + relative + "'.");
        const auto revision = check_revision(root, revisions, relative, 1024 * 1024);
        const auto package_path = "licenses/" + relative;
        artifact["packageOptions"]["fileEntries"].push_back({{"source", path.generic_string()},
                                                             {"packagePath", package_path},
                                                             {"storage", "stored"},
                                                             {"expectedSha256", revision}});
        index.push_back({{"path", package_path},
                         {"source", relative},
                         {"displayName", name.first},
                         {"contentHash", revision}});
    }
    auto& text = artifact["packageOptions"]["textEntries"];
    text.erase(std::remove_if(text.begin(), text.end(),
                              [](const Json& item) {
                                  return item.value("packagePath", "") == "licenses/index.json";
                              }),
               text.end());
    text.push_back(
        {{"text",
          Json{{"schema", "noveltea.project-notices"}, {"notices", std::move(index)}}.dump()},
         {"packagePath", "licenses/index.json"},
         {"storage", "compressed"}});
    artifact["manifestPreview"]["entryCount"] =
        artifact["manifestPreview"]["entryCount"].get<std::size_t>() + notices.size();
}

[[nodiscard]] Json implicit_uniform_default(const std::string& type)
{
    if (type == "bool")
        return false;
    if (type == "float" || type == "int")
        return 0;
    if (type == "vec2")
        return Json::array({0, 0});
    if (type == "vec3")
        return Json::array({0, 0, 0});
    return Json::array({0, 0, 0, 0});
}

void reconcile_shader_reflections(Json& metadata, const Json& project,
                                  const std::string& material_id, const Json& effective,
                                  const ShaderSourceProgramCompileResult& compiled)
{
    std::map<std::string, ShaderReflectedInput> reflected;
    const std::set<std::string> predefined{
        "u_viewRect", "u_viewTexel", "u_alphaRef4", "u_model",   "u_modelView", "u_modelViewProj",
        "u_view",     "u_proj",      "u_viewProj",  "u_invView", "u_invProj",   "u_invViewProj"};
    for (const auto& output : compiled.outputs)
        for (const auto& input : output.reflected_inputs) {
            if (input.kind == ShaderReflectedInputKind::Uniform && predefined.contains(input.name))
                continue;
            const auto found = reflected.find(input.name);
            if (found != reflected.end()) {
                const auto& previous = found->second;
                if (previous.kind != input.kind || previous.type != input.type ||
                    previous.array_size != input.array_size ||
                    (input.kind == ShaderReflectedInputKind::SampledImage &&
                     (previous.register_index != input.register_index ||
                      previous.register_count != input.register_count)))
                    throw PreparationError(
                        "runtime-artifact.shader-reflection.conflict", "/materials/" + material_id,
                        "Shader has conflicting reflected declarations for '" + input.name + "'.");
            } else {
                reflected.emplace(input.name, input);
            }
        }
    const auto registry = Json::parse(noveltea::authoring::material_registry_json);
    const Json* role = nullptr;
    for (const auto& available : registry.at("roles"))
        if (available.at("id") == effective.at("role")) {
            role = &available;
            break;
        }
    if (!role)
        throw PreparationError("runtime-artifact.shader-reflection.role",
                               "/materials/" + material_id,
                               "Reflected Material has an unknown renderer role.");
    const auto shader_id = metadata.at("materials").at(material_id).at("shader").get<std::string>();
    auto& shader = metadata["shaders"][shader_id];
    auto& material = metadata["materials"][material_id];
    shader["uniforms"] = Json::object();
    shader["samplers"] = Json::object();
    material["uniforms"] = Json::object();
    material["textures"] = Json::object();
    for (const auto& [name, input] : reflected) {
        if (input.array_size != 1 ||
            (input.kind == ShaderReflectedInputKind::Uniform && input.type != "vec4"))
            throw PreparationError("runtime-artifact.shader-reflection.unsupported",
                                   "/materials/" + material_id,
                                   "Shader input '" + name + "' has an unsupported reflected ABI.");
        if (input.kind == ShaderReflectedInputKind::SampledImage) {
            Json binding = nullptr;
            bool renderer_owned = false;
            for (const auto& sampler : role->at("reservedInterface").at("samplers")) {
                if (sampler.at("name") != name)
                    continue;
                renderer_owned = sampler.value("sourceOwnership", "") == "renderer";
                if (sampler.contains("semantic") && sampler.at("semantic").is_string() &&
                    (sampler.at("semantic") == "engine.hotspot_image" ||
                     sampler.at("semantic") == "engine.hotspot_mask"))
                    binding = sampler.at("semantic");
                break;
            }
            const auto& authored = effective.at("authoredTextures");
            if (authored.contains(name) && authored.at(name).is_object() &&
                authored.at(name).contains("binding"))
                binding = authored.at(name).at("binding");
            shader["samplers"][name] = {
                {"type", "texture2d"}, {"stage", input.register_index}, {"binding", binding}};
            if (!effective.at("textures").contains(name))
                continue;
            const auto& texture = effective.at("textures").at(name);
            Json entry{{"address", texture.at("address")}, {"filter", texture.at("filter")}};
            if (texture.contains("source")) {
                const auto& source = texture.at("source");
                if (source.contains("$ref")) {
                    const auto id = source.at("$ref").at("id").get<std::string>();
                    if (!project.at("assets").contains(id))
                        throw PreparationError(
                            "runtime-artifact.shader-texture.missing", "/materials/" + material_id,
                            "Reflected texture has a missing Asset: '" + id + "'.");
                    const auto& asset = project.at("assets").at(id).at("data");
                    entry["source"] =
                        "project:/" + asset.at("source").at("path").get<std::string>();
                    if (entry["filter"] == "inherit" && asset.value("kind", "") == "image")
                        entry["filter"] =
                            asset.value("sampling", "linear") == "nearest" ? "nearest" : "linear";
                } else if (source.contains("alias"))
                    entry["source"] = "alias:" + source.at("alias").get<std::string>();
                else if (source.contains("uri"))
                    entry["source"] = source.at("uri");
            }
            if (entry.contains("source") || renderer_owned)
                material["textures"][name] = std::move(entry);
            continue;
        }
        bool renderer_uniform = false;
        for (const auto& reserved : role->at("reservedInterface").at("rendererUniforms"))
            if (reserved.at("name") == name)
                renderer_uniform = true;
        if (renderer_uniform)
            continue;
        const auto& parameters = effective.at("parameters");
        const Json parameter = parameters.contains(name) ? parameters.at(name) : Json::object();
        const std::string type = parameter.value("type", std::string("vec4"));
        Json declaration{{"type", type}};
        if (parameter.contains("binding") && !parameter.at("binding").is_null())
            declaration["binding"] = parameter.at("binding");
        else
            declaration["default"] = parameter.contains("value") && !parameter.at("value").is_null()
                                         ? parameter.at("value")
                                         : implicit_uniform_default(type);
        if (parameter.contains("editor") && parameter.at("editor").is_object()) {
            const auto& editor = parameter.at("editor");
            if (editor.contains("range") && editor.at("range").is_array())
                declaration["range"] = editor.at("range");
            if (editor.contains("label") && editor.at("label").is_string() &&
                !editor.at("label").get<std::string>().empty())
                declaration["editor"] = {{"label", editor.at("label")}};
        }
        shader["uniforms"][name] = declaration;
        if (!declaration.contains("binding") && effective.at("authoredParameters").contains(name)) {
            const auto& authored = effective.at("authoredParameters").at(name);
            if (authored.contains("value") && !authored.at("value").is_null())
                material["uniforms"][name] = authored.at("value");
        }
    }
}

void prepare_shaders(Json& artifact, const Json& admitted, const fs::path& root,
                     const std::function<bool()>& cancelled)
{
    if (!artifact.contains("shaderMaterialMetadata"))
        return;
    auto& metadata = artifact["shaderMaterialMetadata"];
    const auto& profile = artifact.at("profile");
    const auto variants = profile.at("shaderVariants").get<std::vector<std::string>>();
    const auto& effective = admitted.at("materialEffectiveInputs");
    std::set<std::string> packaged_sources;
    for (const auto& entry : artifact.at("fileEntries"))
        packaged_sources.insert(entry.at("packagePath").get<std::string>());
    if (profile.value("compileShadersBeforeExport", true)) {
        std::vector<ShaderCompileDiagnostic> variant_errors;
        ShaderCompileOptions options;
        options.project_root = root;
        options.output_root = root / ".noveltea/build";
        options.cache_root = root / ".noveltea/cache";
        options.variants = shader_compile_variants_from_names(variants, &variant_errors);
        if (!variant_errors.empty() || options.variants.size() != variants.size())
            throw PreparationError("runtime-artifact.shader-compiler.failed", "/shaders",
                                   "Runtime export requests an unsupported shader variant.");
        ShaderCompilerService compiler;
        for (const auto& [material_id, value] : effective.items()) {
            if (!value.value("custom", false))
                continue;
            if (cancelled && cancelled())
                throw PreparationError("runtime-artifact.preparation.cancelled", "/",
                                       "Runtime preparation cancelled before shader compilation.");
            const auto shader_id =
                metadata.at("materials").at(material_id).at("shader").get<std::string>();
            auto& shader = metadata["shaders"][shader_id];
            const auto& sources = value.at("shader");
            ShaderSourceProgramRequest request{
                .vertex_source = sources.at("vertexSource").get<std::string>(),
                .fragment_source = sources.at("fragmentSource").get<std::string>(),
                .varying_definition = sources.at("varyingDefinition").get<std::string>(),
                .interface_contract = value.at("interfaceContract").get<std::string>(),
                .interface_fingerprint = value.at("interfaceFingerprint").get<std::string>()};
            auto compiled = compiler.compile_source_program(request, options);
            if (!compiled.success()) {
                const auto message = compiled.diagnostics.empty()
                                         ? "Shader compilation failed."
                                         : compiled.diagnostics.front().message;
                throw PreparationError("runtime-artifact.shader-compiler.failed", "/shaders",
                                       "Material '" + material_id + "': " + message);
            }
            reconcile_shader_reflections(metadata, admitted.at("project"), material_id, value,
                                         compiled);
            std::set<std::pair<std::string, std::string>> seen;
            for (const auto& output : compiled.outputs) {
                const auto stage = output.stage == ShaderStage::Vertex ? "vertex" : "fragment";
                if (!seen.emplace(stage, output.variant).second ||
                    std::find(variants.begin(), variants.end(), output.variant) == variants.end() ||
                    output.source_identity != (stage == std::string_view("vertex")
                                                   ? request.vertex_source
                                                   : request.fragment_source))
                    throw PreparationError("runtime-artifact.shader-output-invalid", "/materials",
                                           "Native compiler returned an unexpected shader output.");
                for (const auto& revision : output.dependency_revisions) {
                    if (!revision.identity.starts_with("project:/"))
                        continue;
                    const auto relative = revision.identity.substr(9);
                    const auto actual =
                        check_revision(root, admitted.at("sourceRevisions"), relative);
                    if (actual != revision.content_hash)
                        throw PreparationError("runtime-artifact.shader-source-revision-stale",
                                               "/materials",
                                               "Shader source changed while compiling.");
                    if (!profile.value("stripShaderSources", true) &&
                        packaged_sources.insert(relative).second) {
                        const auto source = checked_source(root, relative).generic_string();
                        artifact["fileEntries"].push_back({{"source", source},
                                                           {"packagePath", relative},
                                                           {"storage", "auto"},
                                                           {"assetId", "source:" + relative},
                                                           {"kind", "shader-source"}});
                        artifact["packageOptions"]["fileEntries"].push_back(
                            {{"source", source}, {"packagePath", relative}, {"storage", "auto"}});
                        artifact["manifestPreview"]["entryCount"] =
                            artifact["manifestPreview"]["entryCount"].get<std::size_t>() + 1;
                        artifact["manifestPreview"]["assetCount"] = artifact["fileEntries"].size();
                    }
                }
                if (!fs::is_regular_file(output.output_path) ||
                    sha256(read_bytes(output.output_path, 64 * 1024 * 1024)) != output.byte_hash)
                    throw PreparationError(
                        "runtime-artifact.shader-output-invalid", "/materials",
                        "Native shader binary does not match its compiler digest.");
                shader["stages"][stage]["compiled"][output.variant] = {
                    {"runtimePath", output.runtime_path},
                    {"byteHash", output.byte_hash},
                    {"byteSize", output.byte_size}};
            }
            for (const auto* stage : {"vertex", "fragment"})
                for (const auto& variant : variants)
                    if (!seen.contains({stage, variant}))
                        throw PreparationError("runtime-artifact.shader-output-missing",
                                               "/materials",
                                               "Native shader compilation is incomplete.");
        }
    }
    std::set<std::string> required;
    for (const auto& [id, shader] : metadata.at("shaders").items()) {
        (void)id;
        for (const auto& [stage, value] : shader.at("stages").items()) {
            (void)stage;
            for (const auto& variant : variants) {
                if (value.at("compiled").contains(variant)) {
                    const auto& path = value.at("compiled").at(variant).at("runtimePath");
                    if (path.get<std::string>().starts_with("project:/"))
                        required.insert(path.get<std::string>().substr(9));
                }
            }
        }
    }
    Json binaries = Json::array();
    for (const auto& path : required)
        binaries.push_back(path);
    artifact["shaderMaterialMetadata"] = metadata;
    artifact["packageOptions"]["shaderMaterialMetadata"] = metadata;
    Json material_interfaces = Json::array();
    for (const auto& [id, material] : metadata.at("materials").items()) {
        const auto& shader = metadata.at("shaders").at(material.at("shader").get<std::string>());
        Json parameters = Json::array();
        for (const auto& [name, uniform] : shader.at("uniforms").items())
            parameters.push_back({{"name", name},
                                  {"type", uniform.at("type")},
                                  {"rendererBinding", uniform.value("binding", Json(nullptr))}});
        material_interfaces.push_back(
            {{"id", id}, {"role", material.at("role")}, {"parameters", std::move(parameters)}});
    }
    artifact["compiledProject"]["resources"]["materialInterfaces"] = std::move(material_interfaces);
    artifact["gameplayJson"] = artifact["compiledProject"].dump();
    artifact["requiredShaderBinaryPaths"] = binaries;
    artifact["packageOptions"]["requiredShaderBinaryPaths"] = binaries;
    artifact["manifestPreview"]["requiredShaderBinaryPaths"] = binaries;
    artifact["manifestPreview"]["entryCount"] =
        artifact["manifestPreview"]["entryCount"].get<std::size_t>() + binaries.size();
    if (!variants.empty())
        artifact["packageOptions"]["shaderAssetRoot"] = (root / ".noveltea/build").generic_string();
}
} // namespace

Json prepare_native_runtime_physical(const Json& assembled, const Json& admitted,
                                     const std::string& project_root,
                                     const std::function<bool()>& cancelled)
{
    Json diagnostics = Json::array();
    const auto stopped = [&]() { return cancelled && cancelled(); };
    const auto cancelled_result = [&]() {
        return Json{{"status", "cancelled"},
                    {"diagnostics",
                     Json::array({diagnostic("runtime-artifact.preparation.cancelled", "warning",
                                             "/", "Runtime artifact preparation was cancelled.",
                                             "Runtime package readiness")})}};
    };
    if (stopped())
        return cancelled_result();
    try {
        if (!assembled.is_object() ||
            assembled.value("schema", "") != "noveltea.prepared-runtime-artifact" ||
            !admitted.is_object() || !admitted.contains("sourceRevisions") ||
            !admitted.contains("project") || project_root.empty())
            throw PreparationError(
                "runtime-artifact.physical-source.unpinned", "/artifact",
                "Physical preparation requires a complete pinned native Project.");
        const fs::path root =
            fs::canonical(fs::path(std::u8string(project_root.begin(), project_root.end())));
        Json artifact = assembled;
        const auto& revisions = admitted.at("sourceRevisions");
        for (const auto& entry : artifact.at("fileEntries")) {
            if (entry.at("kind") == "prepared-media")
                continue;
            const auto relative = relative_source(root, entry.at("source").get<std::string>());
            (void)check_revision(root, revisions, relative,
                                 entry.at("kind") == "video" ? 512ull * 1024 * 1024
                                                             : 256ull * 1024 * 1024);
        }
        prepare_notices(artifact, admitted.at("project"), revisions, root);
        if (stopped())
            return cancelled_result();
        prepare_shaders(artifact, admitted, root, cancelled);
        if (stopped())
            return cancelled_result();
        prepare_native_runtime_media(artifact, admitted.at("project"), revisions, root, cancelled);
        if (stopped())
            return cancelled_result();
        for (auto& entry : artifact.at("fileEntries")) {
            if (entry.at("kind") == "prepared-media")
                continue;
            const auto relative = relative_source(root, entry.at("source").get<std::string>());
            entry["expectedSha256"] = check_revision(
                root, revisions, relative,
                entry.at("kind") == "video" ? 512ull * 1024 * 1024 : 256ull * 1024 * 1024);
        }
        for (auto& entry : artifact.at("packageOptions").at("fileEntries")) {
            if (entry.at("packagePath").get<std::string>().starts_with("assets/.prepared-media/")) {
                const auto source = fs::path(entry.at("source").get<std::string>());
                if (fs::is_symlink(fs::symlink_status(source)) ||
                    sha256(read_bytes(source, 128ull * 1024 * 1024)) !=
                        entry.value("expectedSha256", std::string{}))
                    throw PreparationError("runtime-artifact.prepared-media.stale",
                                           "/artifact/fileEntries",
                                           "Generated media changed during preparation.");
            } else {
                const auto relative = relative_source(root, entry.at("source").get<std::string>());
                const auto revision =
                    check_revision(root, revisions, relative, 512ull * 1024 * 1024);
                if (entry.contains("expectedSha256") && entry.at("expectedSha256") != revision)
                    throw PreparationError("runtime-artifact.physical-source.stale",
                                           "/artifact/fileEntries",
                                           "Package source has a conflicting pinned revision.");
                entry["expectedSha256"] = revision;
            }
        }
        if (stopped())
            return cancelled_result();
        return {{"status", "prepared"}, {"artifact", std::move(artifact)}};
    } catch (const PreparationError& error) {
        if (stopped())
            return cancelled_result();
        diagnostics.push_back(
            diagnostic(error.code, "error", error.path, error.what(), "Runtime package readiness"));
    } catch (const std::exception& error) {
        if (stopped())
            return cancelled_result();
        diagnostics.push_back(diagnostic("runtime-artifact.physical-preparation.failed", "error",
                                         "/artifact", error.what(), "Runtime package readiness"));
    }
    return {{"status", "blocked"}, {"diagnostics", std::move(diagnostics)}};
}
} // namespace noveltea::cli
