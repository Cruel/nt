#include "tooling_native_project_shader_validation.hpp"

#include "tooling_native.hpp"

#include "../project_authoring/material_semantics.hpp"

#include <noveltea/core/player_bootstrap.hpp>

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <set>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace noveltea::tooling {
namespace {
using Json = nlohmann::json;
namespace fs = std::filesystem;

// Embedded shaderc prints raw diagnostics to stdout. The daemon, like the
// standalone CLI, must never mix those bytes with its JSON transport.
struct SuppressCompilerStdout {
    int saved = -1;
    SuppressCompilerStdout()
    {
        std::fflush(stdout);
#if defined(_WIN32)
        saved = _dup(_fileno(stdout));
        const auto sink = _open("NUL", _O_WRONLY);
        const auto redirected = saved >= 0 && sink >= 0 ? _dup2(sink, _fileno(stdout)) : -1;
        if (sink >= 0)
            _close(sink);
#else
        saved = dup(fileno(stdout));
        const auto sink = open("/dev/null", O_WRONLY);
        const auto redirected = saved >= 0 && sink >= 0 ? dup2(sink, fileno(stdout)) : -1;
        if (sink >= 0)
            close(sink);
#endif
        if (redirected < 0) {
#if defined(_WIN32)
            if (saved >= 0)
                _close(saved);
#else
            if (saved >= 0)
                close(saved);
#endif
            throw std::runtime_error("Could not isolate resident shader compiler output.");
        }
    }
    ~SuppressCompilerStdout()
    {
        std::fflush(stdout);
#if defined(_WIN32)
        _dup2(saved, _fileno(stdout));
        _close(saved);
#else
        dup2(saved, fileno(stdout));
        close(saved);
#endif
    }
};

[[nodiscard]] bool is_project_shader(std::string_view identity)
{
    return identity.starts_with("project:/shaders/");
}

[[nodiscard]] std::string project_shader_path(std::string_view identity)
{
    return std::string(identity.substr(std::string_view("project:/").size()));
}

[[nodiscard]] std::map<std::string, std::string>
shader_inventory(const std::map<std::string, std::string>& revisions)
{
    std::map<std::string, std::string> result;
    for (const auto& [path, revision] : revisions)
        if (path.starts_with("shaders/"))
            result.emplace(path, revision);
    return result;
}

[[nodiscard]] bool deterministic_failure(const Json& response)
{
    if (!response.value("ok", false) || response.value("success", true) ||
        !response.value("outputs", Json::array()).empty())
        return false;
    const std::set<std::string> deterministic = {
        "invalid_variant",   "invalid_source_path",        "unsafe_include_path",
        "missing_source",    "missing_varying_definition", "compiler_failed",
        "contract_violation"};
    const auto& diagnostics = response.value("diagnostics", Json::array());
    return !diagnostics.empty() &&
           std::all_of(diagnostics.begin(), diagnostics.end(), [&](const Json& diagnostic) {
               return diagnostic.is_object() && diagnostic.value("severity", "") == "error" &&
                      deterministic.contains(diagnostic.value("code", ""));
           });
}

// A cache hit never trusts file metadata alone. This is the same SHA-256
// output-integrity gate used by the native shaderc manifest on disk hits.
[[nodiscard]] bool binary_current(const fs::path& root, const Json& output)
{
    if (!output.is_object() || !output.contains("outputPath") ||
        !output.at("outputPath").is_string() || !output.contains("byteHash") ||
        !output.at("byteHash").is_string() || !output.contains("byteSize") ||
        !output.at("byteSize").is_number_unsigned())
        return false;
    const auto base = root / ".noveltea" / "build";
    const fs::path path(output.at("outputPath").get<std::string>());
    const auto relative = path.lexically_relative(base);
    if (relative.empty() || relative == "." || relative.is_absolute() ||
        *relative.begin() == ".." || relative != relative.lexically_normal())
        return false;
    auto current = root;
    for (const auto& part : fs::path(".noveltea") / "build" / relative) {
        current /= part;
        std::error_code ec;
        if (fs::is_symlink(fs::symlink_status(current, ec)) || ec)
            return false;
    }
    std::error_code ec;
    if (!fs::is_regular_file(path, ec) || ec ||
        fs::file_size(path, ec) != output.at("byteSize").get<std::uint64_t>() || ec)
        return false;
    std::ifstream input(path, std::ios::binary);
    if (!input)
        return false;
    const std::string bytes{std::istreambuf_iterator<char>{input},
                            std::istreambuf_iterator<char>{}};
    return !input.bad() && bytes.size() == output.at("byteSize").get<std::uint64_t>() &&
           "sha256:" + core::sha256_hex(std::as_bytes(std::span(bytes.data(), bytes.size()))) ==
               output.at("byteHash").get<std::string>();
}

[[nodiscard]] bool source_matches(const std::map<std::string, std::string>& dependencies,
                                  const std::map<std::string, std::string>& current)
{
    for (const auto& [path, revision] : dependencies) {
        const auto found = current.find(path);
        if (found == current.end() || found->second != revision)
            return false;
    }
    return true;
}

[[nodiscard]] bool file_hash_matches(const fs::path& path, const std::string& expected)
{
    std::error_code ec;
    auto cursor = path.root_path();
    for (const auto& component : path.relative_path()) {
        cursor /= component;
        if (fs::is_symlink(fs::symlink_status(cursor, ec)) || ec)
            return false;
    }
    if (!fs::is_regular_file(path, ec) || ec)
        return false;
    std::ifstream input(path, std::ios::binary);
    if (!input)
        return false;
    const std::string contents{std::istreambuf_iterator<char>{input},
                               std::istreambuf_iterator<char>{}};
    return !input.bad() &&
           "sha256:" +
                   core::sha256_hex(std::as_bytes(std::span(contents.data(), contents.size()))) ==
               expected;
}

// The compiler materializes immutable engine source blobs into a project-local
// toolchain directory. Do not assume these physical copies are immutable:
// establish their exact location once on a miss, then reprove only the
// individual files on hits (never walk the engine/include tree again).
[[nodiscard]] std::optional<fs::path> locate_engine_dependency(const fs::path& root,
                                                               std::string_view identity,
                                                               const std::string& expected)
{
    constexpr std::string_view prefix = "engine:/";
    if (!identity.starts_with(prefix))
        return std::nullopt;
    const fs::path relative{std::string(identity.substr(prefix.size()))};
    if (relative.empty() || relative.is_absolute() || relative != relative.lexically_normal() ||
        *relative.begin() == "..")
        return std::nullopt;
    const auto toolchains = root / ".noveltea" / "cache" / "toolchain" / "noveltea-shaders";
    std::error_code ec;
    if (!fs::is_directory(toolchains, ec) || ec)
        return std::nullopt;
    for (const auto& directory : fs::directory_iterator(toolchains, ec)) {
        if (ec)
            break;
        std::error_code entry_error;
        if (directory.is_symlink(entry_error) || entry_error ||
            !directory.is_directory(entry_error) || entry_error)
            continue;
        const auto candidate = directory.path() / relative;
        if (file_hash_matches(candidate, expected))
            return candidate;
    }
    return std::nullopt;
}

} // namespace

Json MaterialShaderValidationCache::validate(
    const fs::path& root, const Json& material_programs,
    const std::map<std::string, std::string>& source_revisions, Work& work)
{
    // Preserve the standalone CLI's canonical-program deduplication and
    // output alias ordering. Compilation itself is owned by the same native
    // shaderc service, not another validator.
    std::map<std::string, std::string> canonical;
    std::map<std::string, std::string> aliases;
    std::map<std::string, Json> programs;
    for (const auto& [material, collection] : material_programs.items())
        for (const auto& [id, program] : collection.items()) {
            const auto serialized = program.dump();
            // Public validate historically passes no custom-Material ID
            // overrides to native_material_compile(). Preserve those exact
            // output identities; explicit shader commands keep their naming.
            const auto [found, unique] = canonical.emplace(serialized, id);
            if (unique)
                programs[id] = program;
            aliases[material] = found->second;
        }

    const auto all_shader_revisions = shader_inventory(source_revisions);
    Json result{{"ok", true},
                {"success", true},
                {"outputs", Json::array()},
                {"diagnostics", Json::array()}};
    for (const auto& [id, program] : programs) {
        const auto key = id + "\n" + program.dump();
        auto cached = entries_.find(key);
        bool reusable = cached != entries_.end() &&
                        source_matches(cached->second.source_revisions, source_revisions);
        if (reusable && cached->second.failed)
            reusable = cached->second.source_revisions == all_shader_revisions;
        if (reusable)
            for (const auto& [path, revision] : cached->second.engine_revisions)
                if (!file_hash_matches(path, revision)) {
                    reusable = false;
                    break;
                }
        if (reusable && !cached->second.failed)
            for (const auto& output : cached->second.response.at("outputs")) {
                ++work.output_proofs;
                if (!binary_current(root, output)) {
                    reusable = false;
                    break;
                }
            }

        Json compiled;
        if (reusable) {
            compiled = cached->second.response;
            for (auto& output : compiled["outputs"])
                output["cacheHit"] = true;
            ++work.reused_programs;
        } else {
            // A failed proof must force compiler staging and manifest checks;
            // never return a cached result for tampered or missing binaries.
            entries_.erase(key);
            const Json request = {
                {"shaderProject",
                 {{"schema", "noveltea.shader-source-programs"}, {"programs", {{id, program}}}}},
                {"options",
                 {{"projectRoot", root.string()},
                  {"outputRoot", (root / ".noveltea" / "build").string()},
                  {"cacheRoot", (root / ".noveltea" / "cache").string()},
                  {"shaderVariants", Json::array({"glsl-330", "essl-300", "metal"})},
                  {"forceRebuild", false},
                  {"sourceOverlays", Json::object()}}}};
            ++work.compiler_runs;
            {
                SuppressCompilerStdout silence;
                compiled = Json::parse(compile_shaders(request.dump()).response_json);
            }
            Entry entry;
            entry.response = compiled;
            entry.failed = deterministic_failure(compiled);
            bool admissible = entry.failed;
            if (entry.failed) {
                // A missing include can become available without changing the
                // program request. Any shader source addition/removal/edit
                // revokes negative findings; unknown I/O failures are not cached.
                entry.source_revisions = all_shader_revisions;
            } else if (compiled.value("ok", false) && compiled.value("success", false) &&
                       compiled.value("diagnostics", Json::array()).empty() &&
                       !compiled.value("outputs", Json::array()).empty()) {
                admissible = true;
                for (const auto& output : compiled.at("outputs")) {
                    if (!output.contains("dependencyRevisions") ||
                        !output.at("dependencyRevisions").is_array()) {
                        admissible = false;
                        break;
                    }
                    for (const auto& dependency : output.at("dependencyRevisions")) {
                        const auto identity = dependency.value("identity", std::string{});
                        if (identity.starts_with("engine:/")) {
                            const auto hash = dependency.value("contentHash", std::string{});
                            const auto path = locate_engine_dependency(root, identity, hash);
                            if (!path) {
                                admissible = false;
                                break;
                            }
                            entry.engine_revisions.emplace(*path, hash);
                        }
                        if (!is_project_shader(identity))
                            continue;
                        const auto path = project_shader_path(identity);
                        const auto revision = source_revisions.find(path);
                        if (revision == source_revisions.end()) {
                            admissible = false;
                            break;
                        }
                        entry.source_revisions.emplace(path, revision->second);
                    }
                    if (!admissible)
                        break;
                }
            }
            if (admissible) {
                if (entries_.size() >= 256)
                    entries_.erase(entries_.begin());
                entries_.emplace(key, std::move(entry));
            }
        }
        if (!compiled.value("ok", false))
            return compiled;
        result["success"] = result.at("success").get<bool>() && compiled.value("success", false);
        for (const auto& output : compiled.value("outputs", Json::array()))
            result["outputs"].push_back(output);
        for (const auto& diagnostic : compiled.value("diagnostics", Json::array()))
            result["diagnostics"].push_back(diagnostic);
    }
    Json additional = Json::array();
    for (const auto& output : result.at("outputs"))
        for (const auto& [material, id] : aliases) {
            if (output.value("program", "") != id || material == id)
                continue;
            auto alias = output;
            alias["program"] = material;
            additional.push_back(std::move(alias));
        }
    for (auto& alias : additional)
        result["outputs"].push_back(std::move(alias));
    return result;
}

Json material_reflection_diagnostics(const Json& compiled, const Json& effective_materials)
{
    Json diagnostics = Json::array();
    for (const auto& [material_id, effective] : effective_materials.items()) {
        if (!effective.value("custom", false))
            continue;
        Json outputs = Json::array();
        for (const auto& output : compiled.value("outputs", Json::array()))
            if (output.value("program", std::string{}) == material_id)
                outputs.push_back(output);
        const auto reflected = noveltea::authoring::validate_material_shader_compiler_result(
            Json{{"ok", true},
                 {"success", true},
                 {"diagnostics", Json::array()},
                 {"outputs", std::move(outputs)}}
                .dump(),
            material_id, effective.dump());
        for (const auto& finding : reflected.diagnostics) {
            auto message = finding.message;
            if (finding.code == "material.shader.orphan") {
                const auto name = finding.path.substr(finding.path.find_last_of('/') + 1);
                std::string unescaped;
                for (std::size_t i = 0; i < name.size(); ++i) {
                    if (name[i] == '~' && i + 1 < name.size() &&
                        (name[i + 1] == '0' || name[i + 1] == '1'))
                        unescaped += name[++i] == '0' ? '~' : '/';
                    else
                        unescaped += name[i];
                }
                const bool texture = finding.path.find("/textures/") != std::string::npos;
                message = "Material " + std::string(texture ? "texture" : "parameter") + " '" +
                          unescaped +
                          "' is not present in the reflected shader interface and remains "
                          "orphaned.";
            }
            diagnostics.push_back({{"code", "shader.material_project"},
                                   {"severity", finding.severity},
                                   {"path", finding.path},
                                   {"message", message}});
        }
    }
    return diagnostics;
}

Json MaterialShaderValidationCache::reflected_materials(const Json& compiled,
                                                        const Json& effective_materials, Work& work)
{
    Json diagnostics = Json::array();
    for (const auto& [material, effective] : effective_materials.items()) {
        if (!effective.value("custom", false))
            continue;
        Json interface_inputs = Json::array();
        for (const auto& output : compiled.value("outputs", Json::array()))
            if (output.value("program", "") == material)
                interface_inputs.push_back(
                    {{"programIdentity", output.value("programIdentity", std::string{})},
                     {"stage", output.value("stage", std::string{})},
                     {"variant", output.value("variant", std::string{})},
                     {"byteHash", output.value("byteHash", std::string{})},
                     {"reflectedInputs", output.value("reflectedInputs", Json::array())}});
        const auto identity = Json{{"effective", effective}, {"outputs", interface_inputs}}.dump();
        auto cached = reflection_entries_.find(material);
        if (cached == reflection_entries_.end() || cached->second.identity != identity) {
            ++work.interface_validations;
            auto findings = material_reflection_diagnostics(compiled, Json{{material, effective}});
            if (reflection_entries_.size() >= 256 && cached == reflection_entries_.end())
                reflection_entries_.erase(reflection_entries_.begin());
            reflection_entries_.insert_or_assign(material,
                                                 ReflectionEntry{identity, std::move(findings)});
            cached = reflection_entries_.find(material);
        } else {
            ++work.interface_reuses;
        }
        for (const auto& finding : cached->second.diagnostics)
            diagnostics.push_back(finding);
    }
    return diagnostics;
}

} // namespace noveltea::tooling
