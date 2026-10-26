#include "tooling_native_c.h"
#include "tooling_native_project_sync.hpp"

#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/compiled_project_codec.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <optional>
#include <random>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {

using Json = nlohmann::json;

constexpr std::string_view kCacheSchema = "noveltea.runtime-build-cache";
constexpr std::string_view kWorkspaceSchema = "noveltea.project.workspace";
constexpr int kWorkspaceVersion = 1;
constexpr std::string_view kCompiledProjectSchema = "noveltea.compiled.project";
constexpr int kCompiledProjectVersion = 1;
constexpr std::string_view kPreparedArtifactSchema = "noveltea.prepared-runtime-artifact";
constexpr std::string_view kTestCatalogSchema = "noveltea.runtime-test-catalog";

std::filesystem::path filesystem_path_from_utf8(std::string_view value)
{
#if defined(_WIN32)
    if (value.empty())
        return {};
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0);
    if (required <= 0)
        return {};
    std::wstring wide(static_cast<std::size_t>(required), L'\0');
    const int written = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                            static_cast<int>(value.size()), wide.data(), required);
    if (written != required)
        return {};
    return std::filesystem::path(std::move(wide));
#else
    return std::filesystem::path(value);
#endif
}

std::string filesystem_path_to_utf8(const std::filesystem::path& path)
{
    const auto encoded = path.generic_u8string();
    return std::string(reinterpret_cast<const char*>(encoded.data()), encoded.size());
}

Json response(std::string status, std::string reason)
{
    return {{"ok", true}, {"status", std::move(status)}, {"reason", std::move(reason)}};
}

std::uint64_t write_response(const Json& result, std::uint8_t* output, std::uint64_t capacity)
{
    const auto text = result.dump();
    const auto required = static_cast<std::uint64_t>(text.size());
    if (output != nullptr && capacity >= required)
        std::memcpy(output, text.data(), static_cast<std::size_t>(required));
    return required;
}

std::optional<std::string> read_text(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        return std::nullopt;
    input.seekg(0, std::ios::end);
    const auto size = input.tellg();
    if (size < 0)
        return std::nullopt;
    input.seekg(0, std::ios::beg);
    std::string text(static_cast<std::size_t>(size), '\0');
    if (!text.empty())
        input.read(text.data(), static_cast<std::streamsize>(text.size()));
    if (!input && !text.empty())
        return std::nullopt;
    return text;
}

std::string sha256_prefixed(std::string_view text)
{
    return "sha256:" +
           noveltea::core::sha256_hex(std::as_bytes(std::span(text.data(), text.size())));
}

bool pinned_package_inputs_current(const std::filesystem::path& root, const Json& artifact);

bool contained_by_root(const std::filesystem::path& root, const std::filesystem::path& path)
{
    std::error_code error;
    const auto real_root = std::filesystem::weakly_canonical(root, error);
    if (error)
        return false;
    const auto real_path = std::filesystem::weakly_canonical(path, error);
    if (error)
        return false;
    const auto relative = std::filesystem::relative(real_path, real_root, error);
    if (error || relative.empty())
        return false;
    for (const auto& part : relative) {
        if (part == "..")
            return false;
    }
    return !relative.is_absolute();
}

bool safe_relative(std::string_view value)
{
    if (value.empty() || value.front() == '/' || value.front() == '\\')
        return false;
    const std::filesystem::path path(value);
    if (path.is_absolute())
        return false;
    for (const auto& part : path) {
        if (part == "..")
            return false;
    }
    return true;
}

bool is_uuid(std::string_view value)
{
    if (value.size() != 36)
        return false;
    for (std::size_t index = 0; index < value.size(); ++index) {
        if (index == 8 || index == 13 || index == 18 || index == 23) {
            if (value[index] != '-')
                return false;
        } else if (!std::isxdigit(static_cast<unsigned char>(value[index]))) {
            return false;
        }
    }
    return true;
}

std::optional<std::string> string_field(const Json& object, std::string_view key)
{
    if (!object.is_object())
        return std::nullopt;
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_string())
        return std::nullopt;
    return found->get<std::string>();
}

std::optional<std::uint64_t> unsigned_field(const Json& object, std::string_view key)
{
    if (!object.is_object())
        return std::nullopt;
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_number_unsigned())
        return std::nullopt;
    return found->get<std::uint64_t>();
}

std::optional<int> integer_field(const Json& object, std::string_view key)
{
    if (!object.is_object())
        return std::nullopt;
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_number_integer())
        return std::nullopt;
    return found->get<int>();
}

std::optional<bool> bool_field(const Json& object, std::string_view key)
{
    if (!object.is_object())
        return std::nullopt;
    const auto found = object.find(std::string(key));
    if (found == object.end() || !found->is_boolean())
        return std::nullopt;
    return found->get<bool>();
}

Json path_metadata(const std::filesystem::path& path)
{
    const auto request = Json{{"path", filesystem_path_to_utf8(path)}}.dump();
    std::vector<std::uint8_t> buffer(4096);
    const auto required =
        noveltea_tooling_path_metadata_json(reinterpret_cast<const std::uint8_t*>(request.data()),
                                            request.size(), buffer.data(), buffer.size());
    if (required > buffer.size()) {
        buffer.resize(static_cast<std::size_t>(required));
        (void)noveltea_tooling_path_metadata_json(
            reinterpret_cast<const std::uint8_t*>(request.data()), request.size(), buffer.data(),
            buffer.size());
    }
    return Json::parse(std::string(reinterpret_cast<const char*>(buffer.data()),
                                   static_cast<std::size_t>(required)),
                       nullptr, false);
}

std::optional<Json> current_metadata_entry(const std::filesystem::path& root, const Json& entry)
{
    if (!entry.is_object() || !entry.contains("path") || !entry["path"].is_string() ||
        !entry.contains("byteSize") || !entry["byteSize"].is_number_unsigned() ||
        !entry.contains("mtimeNanoseconds") || !entry["mtimeNanoseconds"].is_string())
        return std::nullopt;
    const auto relative = entry["path"].get<std::string>();
    if (!safe_relative(relative))
        return std::nullopt;
    const auto absolute = root / std::filesystem::path(relative);
    if (!contained_by_root(root, absolute))
        return std::nullopt;
    const auto metadata = path_metadata(absolute);
    const auto ok = bool_field(metadata, "ok");
    const auto kind = string_field(metadata, "kind");
    const auto byte_size = unsigned_field(metadata, "byteSize");
    const auto mtime = string_field(metadata, "mtimeNanoseconds");
    if (metadata.is_discarded() || !ok || !*ok || !kind || *kind != "file" || !byte_size || !mtime)
        return std::nullopt;
    Json current = {{"path", relative}, {"byteSize", *byte_size}, {"mtimeNanoseconds", *mtime}};
    if (entry.contains("sourceIdentity")) {
        if (!entry["sourceIdentity"].is_string())
            return std::nullopt;
        const auto source_identity = string_field(metadata, "sourceIdentity");
        if (!source_identity)
            return std::nullopt;
        current["sourceIdentity"] = *source_identity;
    }
    return current;
}

bool metadata_matches(const std::filesystem::path& root, const Json& entry)
{
    const auto current = current_metadata_entry(root, entry);
    return current && *current == entry;
}

bool excluded(std::string_view relative, const Json& prefixes)
{
    if (!prefixes.is_array())
        return true;
    for (const auto& item : prefixes) {
        if (!item.is_string())
            return true;
        const auto prefix = item.get<std::string>();
        auto exact = prefix;
        if (!exact.empty() && exact.back() == '/')
            exact.pop_back();
        if (relative == exact || relative.starts_with(prefix))
            return true;
    }
    return false;
}

bool extension_matches(std::string_view relative, const Json& extensions)
{
    if (!extensions.is_array())
        return false;
    for (const auto& item : extensions) {
        if (!item.is_string())
            return false;
        const auto extension = item.get<std::string>();
        if (relative.size() >= extension.size() && relative.ends_with(extension))
            return true;
    }
    return false;
}

bool discovery_contract_matches(const Json& scopes)
{
    const Json expected =
        Json::array({{{"root", "records"},
                      {"extensions", Json::array({".yaml", ".json", ".lua", ".rcss", ".rml"})},
                      {"excludedPrefixes", Json::array({"records/tests/"})}},
                     {{"root", "scripts"},
                      {"extensions", Json::array({".lua"})},
                      {"excludedPrefixes", Json::array()}},
                     {{"root", "i18n"},
                      {"extensions", Json::array({".yaml", ".json"})},
                      {"excludedPrefixes", Json::array()}}});
    return scopes == expected;
}

// Cache manifests can be written by the JS workspace (declaration order) or by the
// native authority manager (sorted order). Scope and extension order has no meaning;
// membership does. Keep the exact shape and multiplicity so malformed or expanded
// discovery contracts still invalidate the cached validation result.
std::optional<Json> canonical_discovery_scopes(const Json& scopes)
{
    if (!scopes.is_array())
        return std::nullopt;
    Json canonical = Json::array();
    for (const auto& scope : scopes) {
        if (!scope.is_object() || scope.size() != 3 || !scope.contains("root") ||
            !scope["root"].is_string() || !scope.contains("extensions") ||
            !scope["extensions"].is_array() || !scope.contains("excludedPrefixes") ||
            !scope["excludedPrefixes"].is_array())
            return std::nullopt;
        Json normalized = scope;
        for (const auto* key : {"extensions", "excludedPrefixes"}) {
            auto& values = normalized[key];
            if (!std::all_of(values.begin(), values.end(),
                             [](const Json& value) { return value.is_string(); }))
                return std::nullopt;
            std::sort(values.begin(), values.end());
        }
        canonical.push_back(std::move(normalized));
    }
    std::sort(canonical.begin(), canonical.end(), [](const Json& left, const Json& right) {
        return left["root"].get_ref<const std::string&>() <
               right["root"].get_ref<const std::string&>();
    });
    return canonical;
}

bool discovery_matches(const std::filesystem::path& root, const Json& scopes,
                       const std::set<std::string>& input_paths)
{
    if (!scopes.is_array())
        return false;
    for (const auto& scope : scopes) {
        if (!scope.is_object() || !scope.contains("root") || !scope["root"].is_string() ||
            !scope.contains("extensions") || !scope.contains("excludedPrefixes"))
            return false;
        const auto scope_root = scope["root"].get<std::string>();
        if (!safe_relative(scope_root))
            return false;
        const auto absolute_root = root / std::filesystem::path(scope_root);
        if (!contained_by_root(root, absolute_root))
            return false;
        std::error_code error;
        if (!std::filesystem::exists(absolute_root, error))
            continue;
        if (error ||
            std::filesystem::is_symlink(std::filesystem::symlink_status(absolute_root, error)))
            return false;
        for (std::filesystem::recursive_directory_iterator
                 iterator(absolute_root, std::filesystem::directory_options::none, error),
             end;
             !error && iterator != end; iterator.increment(error)) {
            const auto status = iterator->symlink_status(error);
            if (error || std::filesystem::is_symlink(status))
                return false;
            const auto relative_path = std::filesystem::relative(iterator->path(), root, error);
            if (error)
                return false;
            const auto relative = filesystem_path_to_utf8(relative_path);
            const bool candidate = !excluded(relative, scope["excludedPrefixes"]) &&
                                   extension_matches(relative, scope["extensions"]);
            if (candidate && !std::filesystem::is_regular_file(status))
                return false;
            if (!std::filesystem::is_regular_file(status))
                continue;
            if (candidate && !input_paths.contains(relative))
                return false;
        }
        if (error)
            return false;
    }
    return true;
}

bool authoring_diagnostics_shape_valid(const Json& diagnostics)
{
    if (!diagnostics.is_array())
        return false;
    for (const auto& diagnostic : diagnostics) {
        if (!diagnostic.is_object() || !diagnostic.contains("code") ||
            !diagnostic["code"].is_string() || diagnostic["code"].get<std::string>().empty() ||
            !diagnostic.contains("severity") || !diagnostic["severity"].is_string() ||
            !diagnostic.contains("path") || !diagnostic["path"].is_string() ||
            !diagnostic.contains("message") || !diagnostic["message"].is_string())
            return false;
        const auto severity = diagnostic["severity"].get<std::string>();
        if (severity != "error" && severity != "warning" && severity != "info")
            return false;
    }
    return true;
}

bool catalog_shape_valid(const Json& catalog)
{
    if (!catalog.is_object() || !catalog.contains("schema") || !catalog["schema"].is_string() ||
        catalog["schema"].get<std::string>() != kTestCatalogSchema ||
        !catalog.contains("entries") || !catalog["entries"].is_array())
        return false;
    std::string previous_id;
    for (const auto& entry : catalog["entries"]) {
        if (!entry.is_object() || !entry.contains("id") || !entry["id"].is_string() ||
            !entry.contains("status") || !entry["status"].is_string())
            return false;
        const auto id = entry["id"].get<std::string>();
        if (id.empty() || (!previous_id.empty() && id <= previous_id))
            return false;
        previous_id = id;
        const auto status = entry["status"].get<std::string>();
        if (status == "blocked") {
            if (!entry.contains("diagnostics") || !entry["diagnostics"].is_array() ||
                entry["diagnostics"].empty())
                return false;
            continue;
        }
        if (status != "runnable" || !entry.contains("runner") || !entry["runner"].is_string() ||
            !entry.contains("spec"))
            return false;
        const auto runner = entry["runner"].get<std::string>();
        if (runner != "runtime" && runner != "runtime-ui")
            return false;
    }
    return true;
}

std::optional<std::set<std::string>> test_files(const std::filesystem::path& root)
{
    std::set<std::string> result;
    const auto tests = root / "records" / "tests";
    if (!contained_by_root(root, tests))
        return std::nullopt;
    std::error_code error;
    const auto tests_status = std::filesystem::symlink_status(tests, error);
    if (error) {
        if (error == std::errc::no_such_file_or_directory)
            return result;
        return std::nullopt;
    }
    if (std::filesystem::is_symlink(tests_status) || !std::filesystem::is_directory(tests_status))
        return std::nullopt;
    for (std::filesystem::recursive_directory_iterator iterator(tests, {}, error), end;
         !error && iterator != end; iterator.increment(error)) {
        const auto status = iterator->symlink_status(error);
        if (error || std::filesystem::is_symlink(status))
            return std::nullopt;
        if (std::filesystem::is_regular_file(status) &&
            (iterator->path().extension() == ".yaml" || iterator->path().extension() == ".json")) {
            const auto relative = std::filesystem::relative(iterator->path(), root, error);
            if (error)
                return std::nullopt;
            result.insert(filesystem_path_to_utf8(relative));
        }
    }
    if (error)
        return std::nullopt;
    return result;
}

Json probe(const Json& request)
{
    if (!request.is_object() || !request.contains("projectRoot") ||
        !request["projectRoot"].is_string() || !request.contains("compilerIdentity") ||
        !request["compilerIdentity"].is_string())
        return response("unusable", "probe-request-invalid");

    const auto root = filesystem_path_from_utf8(request["projectRoot"].get<std::string>());
    if (root.empty())
        return response("unusable", "project-root-unusable");
    std::error_code error;
    const auto root_status = std::filesystem::symlink_status(root, error);
    if (error || !std::filesystem::is_directory(root_status) ||
        std::filesystem::is_symlink(root_status))
        return response("unusable", "project-root-unusable");
    const auto project_status = std::filesystem::symlink_status(root / "project.yaml", error);
    if (error || !std::filesystem::is_regular_file(project_status) ||
        std::filesystem::is_symlink(project_status))
        return response("unusable", "project-manifest-unavailable");

    const auto cache_root = root / ".noveltea" / "cache" / "runtime";
    if (!contained_by_root(root, cache_root))
        return response("unusable", "cache-root-escapes-project");
    const auto current_path = cache_root / "current";
    const auto current_status = std::filesystem::symlink_status(current_path, error);
    if (error) {
        if (error == std::errc::no_such_file_or_directory)
            return response("miss", "current-generation-missing");
        return response("unusable", "current-generation-unreadable");
    }
    if (std::filesystem::is_symlink(current_status) ||
        !std::filesystem::is_regular_file(current_status))
        return response("unusable", "current-generation-not-regular");
    const auto current = read_text(current_path);
    if (!current)
        return response("miss", "current-generation-missing");
    auto generation = *current;
    while (!generation.empty() && (generation.back() == '\n' || generation.back() == '\r' ||
                                   generation.back() == ' ' || generation.back() == '\t'))
        generation.pop_back();
    if (!is_uuid(generation))
        return response("unusable", "current-generation-invalid");
    const auto directory = cache_root / "generations" / generation;
    const auto directory_status = std::filesystem::symlink_status(directory, error);
    if (error || std::filesystem::is_symlink(directory_status) ||
        !std::filesystem::is_directory(directory_status))
        return response("unusable", "generation-unreadable");
    const auto manifest_path = directory / "manifest.json";
    const auto manifest_status = std::filesystem::symlink_status(manifest_path, error);
    if (error || std::filesystem::is_symlink(manifest_status) ||
        !std::filesystem::is_regular_file(manifest_status))
        return response("unusable", "manifest-invalid");
    const auto manifest_text = read_text(manifest_path);
    if (!manifest_text)
        return response("unusable", "manifest-invalid");
    const auto manifest = Json::parse(*manifest_text, nullptr, false);
    if (manifest.is_discarded() || !manifest.is_object())
        return response("unusable", "manifest-invalid");

    const auto manifest_schema = string_field(manifest, "schema");
    const auto manifest_variant = string_field(manifest, "variant");
    const auto compiler_identity = string_field(manifest, "compilerIdentity");
    if (!manifest_schema || *manifest_schema != kCacheSchema || !manifest_variant ||
        *manifest_variant != "canonical-runtime" || !compiler_identity)
        return response("unusable", "manifest-invalid");
    if (*compiler_identity != request["compilerIdentity"].get<std::string>())
        return response("stale", "compiler-identity-changed");

    if (!manifest.contains("projectWorkspace") || !manifest["projectWorkspace"].is_object() ||
        !manifest.contains("compiledProject") || !manifest["compiledProject"].is_object())
        return response("unusable", "manifest-invalid");
    const auto workspace_schema = string_field(manifest["projectWorkspace"], "schema");
    const auto workspace_version = integer_field(manifest["projectWorkspace"], "formatVersion");
    const auto compiled_schema = string_field(manifest["compiledProject"], "schema");
    const auto compiled_version = integer_field(manifest["compiledProject"], "formatVersion");
    const auto artifact_schema = string_field(manifest, "preparedArtifactSchema");
    if (!workspace_schema || *workspace_schema != kWorkspaceSchema || !workspace_version ||
        *workspace_version != kWorkspaceVersion || !compiled_schema ||
        *compiled_schema != kCompiledProjectSchema || !compiled_version ||
        *compiled_version != kCompiledProjectVersion || !artifact_schema ||
        *artifact_schema != kPreparedArtifactSchema || !manifest.contains("authoringDiagnostics") ||
        !authoring_diagnostics_shape_valid(manifest["authoringDiagnostics"]))
        return response("stale", "cache-contract-changed");

    if (!manifest.contains("inputs") || !manifest["inputs"].is_array() ||
        !manifest.contains("discoveryScopes") || !manifest["discoveryScopes"].is_array() ||
        !manifest.contains("artifactFile") || !manifest["artifactFile"].is_string() ||
        !manifest.contains("artifactSha256") || !manifest["artifactSha256"].is_string())
        return response("unusable", "manifest-invalid");

    if (!discovery_contract_matches(manifest["discoveryScopes"]))
        return response("stale", "discovery-contract-changed");

    std::set<std::string> input_paths;
    for (const auto& input : manifest["inputs"]) {
        if (!metadata_matches(root, input))
            return response("stale", "input-metadata-changed");
        input_paths.insert(input["path"].get<std::string>());
    }
    if (!input_paths.contains("project.yaml"))
        return response("unusable", "manifest-invalid");
    if (!discovery_matches(root, manifest["discoveryScopes"], input_paths))
        return response("stale", "discovery-inputs-changed");

    const auto artifact_relative = manifest["artifactFile"].get<std::string>();
    if (!safe_relative(artifact_relative))
        return response("unusable", "manifest-invalid");
    const auto artifact_path = directory / artifact_relative;
    const auto artifact_status = std::filesystem::symlink_status(artifact_path, error);
    if (error || std::filesystem::is_symlink(artifact_status) ||
        !std::filesystem::is_regular_file(artifact_status))
        return response("unusable", "artifact-invalid");
    const auto artifact_text = read_text(artifact_path);
    if (!artifact_text ||
        sha256_prefixed(*artifact_text) != manifest["artifactSha256"].get<std::string>())
        return response("unusable", "artifact-digest-mismatch");

    const auto artifact = Json::parse(*artifact_text, nullptr, false);
    const auto parsed_artifact_schema = string_field(artifact, "schema");
    if (artifact.is_discarded() || !artifact.is_object() || !parsed_artifact_schema ||
        *parsed_artifact_schema != kPreparedArtifactSchema ||
        !artifact.contains("compiledProject") || !artifact["compiledProject"].is_object())
        return response("unusable", "artifact-invalid");
    if (!pinned_package_inputs_current(root, artifact))
        return response("stale", "physical-inputs-changed-or-unpinned");
    // A valid digest only proves the cache file is intact. The compiled wire
    // must still be engine-decodable and identical to the package's gameplay
    // text, including when a damaged generation was deliberately rehashed.
    if (!artifact.contains("gameplayJson") || !artifact["gameplayJson"].is_string())
        return response("unusable", "compiled-project-invalid");
    const auto wire = Json::parse(artifact["gameplayJson"].get<std::string>(), nullptr, false);
    if (wire.is_discarded() || wire != artifact["compiledProject"] ||
        !noveltea::core::decode_compiled_project(wire, "native-runtime-cache-probe"))
        return response("unusable", "compiled-project-invalid");

    auto result = response("hit", "current-runtime-generation-valid");
    result["artifact"] = artifact;
    result["diagnostics"] = manifest["authoringDiagnostics"];
    // These revisions were verified against the compiled gameplay generation.
    // A caller refreshing only the Test catalog must pin them, not ask the
    // publisher to stamp old gameplay with newer filesystem revisions.
    result["runtimeInputs"] = manifest["inputs"];
    result["runtimeInputPaths"] = Json::array();
    for (const auto& entry : manifest["inputs"])
        result["runtimeInputPaths"].push_back(entry["path"]);
    const auto discovered_tests = test_files(root);
    if (discovered_tests) {
        result["testInputPaths"] = Json::array();
        for (const auto& path : *discovered_tests)
            result["testInputPaths"].push_back(path);
    }
    const auto catalog_result = [&result](std::string status, std::string reason) -> Json {
        result["testCatalogStatus"] = std::move(status);
        result["testCatalogReason"] = std::move(reason);
        return result;
    };

    if (!manifest.contains("testCatalog") || !manifest["testCatalog"].is_object())
        return catalog_result("unusable", "test-catalog-manifest-invalid");
    const auto& catalog_manifest = manifest["testCatalog"];
    if (!catalog_manifest.contains("inputs") || !catalog_manifest["inputs"].is_array() ||
        !catalog_manifest.contains("catalogFile") || !catalog_manifest["catalogFile"].is_string() ||
        !catalog_manifest.contains("catalogSha256") ||
        !catalog_manifest["catalogSha256"].is_string())
        return catalog_result("unusable", "test-catalog-manifest-invalid");

    std::set<std::string> expected_tests;
    for (const auto& input : catalog_manifest["inputs"]) {
        if (!metadata_matches(root, input))
            return catalog_result("stale", "test-input-metadata-changed");
        expected_tests.insert(input["path"].get<std::string>());
    }
    const auto current_tests = test_files(root);
    if (!current_tests)
        return catalog_result("unusable", "test-source-set-unreadable");
    if (*current_tests != expected_tests)
        return catalog_result("stale", "test-source-set-changed");

    const auto catalog_relative = catalog_manifest["catalogFile"].get<std::string>();
    if (!safe_relative(catalog_relative))
        return catalog_result("unusable", "test-catalog-manifest-invalid");
    const auto catalog_path = directory / catalog_relative;
    const auto catalog_status = std::filesystem::symlink_status(catalog_path, error);
    if (error || std::filesystem::is_symlink(catalog_status) ||
        !std::filesystem::is_regular_file(catalog_status))
        return catalog_result("unusable", "test-catalog-invalid");
    const auto catalog_text = read_text(catalog_path);
    if (!catalog_text ||
        sha256_prefixed(*catalog_text) != catalog_manifest["catalogSha256"].get<std::string>())
        return catalog_result("unusable", "test-catalog-digest-mismatch");

    const auto catalog = Json::parse(*catalog_text, nullptr, false);
    if (catalog.is_discarded() || !catalog_shape_valid(catalog))
        return catalog_result("unusable", "test-catalog-invalid");

    result["reason"] = "current-generation-valid";
    result["testCatalogStatus"] = "hit";
    result["testCatalogReason"] = "current-test-catalog-valid";
    result["catalog"] = catalog;
    return result;
}

bool regular_contained_cache_file(const std::filesystem::path& root,
                                  const std::filesystem::path& relative)
{
    if (!contained_by_root(root, root / relative))
        return false;
    auto current = root;
    std::error_code error;
    for (const auto& part : relative) {
        current /= part;
        const auto status = std::filesystem::symlink_status(current, error);
        if (error || std::filesystem::is_symlink(status))
            return false;
    }
    return std::filesystem::is_regular_file(current, error) && !error;
}

bool authoring_workspace_settled(const std::filesystem::path& root)
{
    const auto transactions = root / ".noveltea/transactions";
    std::error_code error;
    const auto status = std::filesystem::symlink_status(transactions, error);
    if (error == std::errc::no_such_file_or_directory)
        return true;
    if (error || !std::filesystem::is_directory(status))
        return false;
    return std::filesystem::is_empty(transactions, error) && !error;
}

bool editor_validation_diagnostics_shape_valid(const Json& diagnostics)
{
    if (!diagnostics.is_array())
        return false;
    for (const auto& diagnostic : diagnostics) {
        if (!diagnostic.is_object() || !diagnostic.contains("code") ||
            !diagnostic["code"].is_string() || diagnostic["code"].get<std::string>().empty() ||
            !diagnostic.contains("severity") || !diagnostic["severity"].is_string() ||
            !diagnostic.contains("path") || !diagnostic["path"].is_string() ||
            !diagnostic.contains("message") || !diagnostic["message"].is_string() ||
            !diagnostic.contains("boundaries") || !diagnostic["boundaries"].is_array() ||
            !diagnostic.contains("ownerPaths") || !diagnostic["ownerPaths"].is_array())
            return false;
        const auto severity = diagnostic["severity"].get<std::string>();
        if (severity != "error" && severity != "warning" && severity != "info")
            return false;
        for (const auto& boundary : diagnostic["boundaries"]) {
            if (!boundary.is_string())
                return false;
            const auto value = boundary.get<std::string>();
            if (value != "authoring" && value != "runtime-package" && value != "platform-export")
                return false;
        }
        for (const auto& owner : diagnostic["ownerPaths"])
            if (!owner.is_string())
                return false;
        if (diagnostic.contains("category") && !diagnostic["category"].is_string())
            return false;
        if (diagnostic.contains("navigation")) {
            const auto& navigation = diagnostic["navigation"];
            if (!navigation.is_object() || navigation.size() != 3 ||
                string_field(navigation, "kind") != "interactable-instance-property" ||
                !string_field(navigation, "instanceId") || !string_field(navigation, "propertyId"))
                return false;
        }
        for (const auto& [key, value] : diagnostic.items()) {
            (void)value;
            if (key != "code" && key != "severity" && key != "path" && key != "message" &&
                key != "category" && key != "boundaries" && key != "ownerPaths" &&
                key != "navigation")
                return false;
        }
    }
    return true;
}

bool validation_result_shape_valid(const Json& result)
{
    if (!result.is_object() || result.size() != 4 || !bool_field(result, "success") ||
        !integer_field(result, "exitCode") || !result.contains("diagnostics") ||
        !authoring_diagnostics_shape_valid(result["diagnostics"]) ||
        !result.contains("editorDiagnostics") ||
        !editor_validation_diagnostics_shape_valid(result["editorDiagnostics"]))
        return false;
    const auto code = *integer_field(result, "exitCode");
    if ((code != 0 && code != 4 && code != 6) || *bool_field(result, "success") != (code == 0))
        return false;
    bool has_error = false;
    for (const auto& diagnostic : result["diagnostics"]) {
        has_error = has_error || diagnostic["severity"] == "error";
        for (const auto& [key, value] : diagnostic.items()) {
            if (key == "sourceUrl") {
                if (!value.is_string())
                    return false;
            } else if (key == "line" || key == "column") {
                if (!value.is_number_unsigned())
                    return false;
            } else if (key != "code" && key != "severity" && key != "path" && key != "message") {
                return false;
            }
        }
    }
    return has_error == (code != 0);
}

Json probe_authoring(const Json& request)
{
    const auto root_text = string_field(request, "projectRoot");
    const auto semantic_key = string_field(request, "semanticKey");
    if (!root_text || !semantic_key)
        return response("unusable", "probe-request-invalid");
    const auto root = filesystem_path_from_utf8(*root_text);
    std::error_code error;
    const auto root_status = std::filesystem::symlink_status(root, error);
    if (error || !std::filesystem::is_directory(root_status) || !authoring_workspace_settled(root))
        return response("unusable", "workspace-unsettled");
    const std::filesystem::path cache_root = ".noveltea/cache/authoring";
    const auto manifest_path = cache_root / "current.json";
    if (!regular_contained_cache_file(root, manifest_path))
        return response("miss", "current-result-unavailable");
    const auto text = read_text(root / manifest_path);
    if (!text)
        return response("unusable", "current-result-unreadable");
    const auto manifest = Json::parse(*text, nullptr, false);
    if (!manifest.is_object() || manifest.size() != 6 || !manifest.contains("inputs") ||
        !manifest["inputs"].is_array() || !manifest.contains("discoveryScopes") ||
        !manifest.contains("result"))
        return response("unusable", "cache-contract-shape-changed");
    if (string_field(manifest, "projectRoot") != root_text)
        return response("unusable", "cache-project-root-changed");
    if (string_field(manifest, "schema") != "noveltea.authoring-cache")
        return response("unusable", "cache-schema-changed");
    if (string_field(manifest, "semanticKey") != semantic_key)
        return response("unusable", "cache-semantic-key-changed");
    if (!validation_result_shape_valid(manifest["result"]))
        return response("unusable", "cache-result-contract-changed");

    // Both the JS workspace and the native authority manager publish this contract.
    const Json scopes =
        Json::array({{{"root", "i18n"},
                      {"extensions", Json::array({".json", ".yaml"})},
                      {"excludedPrefixes", Json::array()}},
                     {{"root", "records"},
                      {"extensions", Json::array({".json", ".lua", ".rcss", ".rml", ".yaml"})},
                      {"excludedPrefixes", Json::array()}},
                     {{"root", "scripts"},
                      {"extensions", Json::array({".lua"})},
                      {"excludedPrefixes", Json::array()}},
                     {{"root", "shaders"},
                      {"extensions", Json::array({".sc", ".sh", ".inc", ".glsl", ".h"})},
                      {"excludedPrefixes", Json::array()}}});
    if (canonical_discovery_scopes(manifest["discoveryScopes"]) !=
        canonical_discovery_scopes(scopes))
        return response("stale", "discovery-contract-changed");
    std::set<std::string> inputs;
    Json current_inputs = Json::array();
    bool metadata_changed = false;
    std::string previous;
    for (const auto& input : manifest["inputs"]) {
        if (!input.is_object() || input.size() != 4 || !input.contains("path") ||
            !input["path"].is_string() || !input.contains("byteSize") ||
            !input["byteSize"].is_number_unsigned() || !input.contains("mtimeNanoseconds") ||
            !input["mtimeNanoseconds"].is_string() || !input.contains("sourceIdentity") ||
            !input["sourceIdentity"].is_string())
            return response("unusable", "manifest-input-invalid");
        const auto relative = input["path"].get<std::string>();
        if (!safe_relative(relative))
            return response("unusable", "manifest-input-invalid");
        if (relative <= previous)
            return response("unusable", "input-order-invalid");
        previous = relative;
        inputs.insert(relative);
        const auto current = current_metadata_entry(root, input);
        if (!current)
            return response("stale", "input-metadata-changed");
        current_inputs.push_back(*current);
        metadata_changed = metadata_changed || *current != input;
    }
    if (!inputs.contains("project.yaml") || !inputs.contains("editor.yaml") ||
        !inputs.contains("traits.yaml"))
        return response("unusable", "manifest-inputs-invalid");
    if (!discovery_matches(root, scopes, inputs) || !authoring_workspace_settled(root))
        return response("stale", "discovery-inputs-changed");
    if (metadata_changed) {
        auto result = response("stale", "input-metadata-changed");
        result["currentInputs"] = std::move(current_inputs);
        return result;
    }
    auto result = response("hit", "current-authoring-validation-valid");
    result["result"] = Json{{"success", manifest["result"]["success"]},
                            {"exitCode", manifest["result"]["exitCode"]},
                            {"diagnostics", manifest["result"]["diagnostics"]}};
    return result;
}

// The runtime cache has a native reader but its original producer lives in
// TypeScript. This publisher is deliberately independent of the CLI frontend:
// it accepts only already compiled artifacts, derives physical inventories
// itself, and commits the generation pointer last.
std::optional<Json> collect_cache_inputs(const std::filesystem::path& root, const Json& paths)
{
    if (!paths.is_array())
        return std::nullopt;
    Json inputs = Json::array();
    std::string previous;
    for (const auto& item : paths) {
        if (!item.is_string())
            return std::nullopt;
        const auto relative = item.get<std::string>();
        if (!safe_relative(relative) || (!previous.empty() && relative <= previous))
            return std::nullopt;
        previous = relative;
        const auto metadata = current_metadata_entry(
            root, Json{{"path", relative}, {"byteSize", 0U}, {"mtimeNanoseconds", ""}});
        if (!metadata)
            return std::nullopt;
        inputs.push_back(*metadata);
    }
    return inputs;
}

bool unchanged_cache_inputs(const std::filesystem::path& root, const Json& inputs)
{
    for (const auto& entry : inputs)
        if (!metadata_matches(root, entry))
            return false;
    return true;
}

bool contained_physical_inputs(const std::filesystem::path& root, const Json& artifact)
{
    const auto& options = artifact.at("packageOptions");
    if (!options.contains("fileEntries") || !options["fileEntries"].is_array())
        return false;
    const auto check_files = [&](const Json& entries) {
        if (!entries.is_array())
            return false;
        for (const auto& entry : entries) {
            if (!entry.is_object() || !entry.contains("source") || !entry["source"].is_string())
                return false;
            const auto source = filesystem_path_from_utf8(entry["source"].get<std::string>());
            std::error_code error;
            if (source.empty() || !source.is_absolute() || !contained_by_root(root, source) ||
                std::filesystem::is_symlink(std::filesystem::symlink_status(source, error)) ||
                error || !std::filesystem::is_regular_file(source, error) || error)
                return false;
        }
        return true;
    };
    if (!check_files(options["fileEntries"]) ||
        (artifact.contains("fileEntries") && !check_files(artifact["fileEntries"])))
        return false;
    const auto confined_root = [&](const Json& value) {
        if (!value.is_string())
            return false;
        const auto path = filesystem_path_from_utf8(value.get<std::string>());
        return !path.empty() && path.is_absolute() && contained_by_root(root, path);
    };
    if (options.contains("shaderAssetRoot") && !confined_root(options["shaderAssetRoot"]))
        return false;
    if (options.contains("assetRoots")) {
        if (!options["assetRoots"].is_array())
            return false;
        for (const auto& entry : options["assetRoots"])
            if (!entry.is_object() || !entry.contains("root") || !confined_root(entry["root"]))
                return false;
    }
    return true;
}

// A cache manifest digest proves only the JSON artifact. Physical files are
// mutable independently of authored records and must be re-proven on every hit.
bool pinned_package_inputs_current(const std::filesystem::path& root, const Json& artifact)
{
    if (!artifact.contains("packageOptions") || !artifact["packageOptions"].is_object() ||
        !artifact["packageOptions"].contains("fileEntries") || !artifact.contains("fileEntries"))
        return false;
    const auto check = [&](const Json& entries) {
        if (!entries.is_array())
            return false;
        for (const auto& entry : entries) {
            if (!entry.is_object() || !entry.contains("source") || !entry["source"].is_string() ||
                !entry.contains("expectedSha256") || !entry["expectedSha256"].is_string())
                return false;
            const auto expected = entry["expectedSha256"].get<std::string>();
            if (expected.size() != 71 || !expected.starts_with("sha256:") ||
                !std::all_of(expected.begin() + 7, expected.end(), [](char ch) {
                    return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
                }))
                return false;
            const auto path = filesystem_path_from_utf8(entry["source"].get<std::string>());
            if (!path.is_absolute() || !contained_by_root(root, path))
                return false;
            const auto relative = path.lexically_relative(root);
            if (!safe_relative(filesystem_path_to_utf8(relative)))
                return false;
            auto cursor = root;
            std::error_code error;
            for (const auto& component : relative) {
                cursor /= component;
                if (std::filesystem::is_symlink(std::filesystem::symlink_status(cursor, error)) ||
                    error)
                    return false;
            }
            if (!std::filesystem::is_regular_file(path, error) || error ||
                std::filesystem::file_size(path, error) > 512ull * 1024 * 1024 || error)
                return false;
            const auto bytes = read_text(path);
            if (!bytes || sha256_prefixed(*bytes) != expected)
                return false;
        }
        return true;
    };
    return check(artifact["fileEntries"]) && check(artifact["packageOptions"]["fileEntries"]);
}

std::string new_generation_id()
{
    std::array<unsigned char, 16> bytes{};
    std::random_device random;
    for (auto& byte : bytes)
        byte = static_cast<unsigned char>(random());
    bytes[6] = static_cast<unsigned char>((bytes[6] & 0x0f) | 0x40);
    bytes[8] = static_cast<unsigned char>((bytes[8] & 0x3f) | 0x80);
    constexpr char digits[] = "0123456789abcdef";
    std::string result;
    result.reserve(36);
    for (std::size_t index = 0; index < bytes.size(); ++index) {
        if (index == 4 || index == 6 || index == 8 || index == 10)
            result.push_back('-');
        result.push_back(digits[bytes[index] >> 4]);
        result.push_back(digits[bytes[index] & 15]);
    }
    return result;
}

// Writing each generation file durably before installing the pointer prevents
// an interrupted publication from exposing a partially created generation.
bool write_durable_file(const std::filesystem::path& path, std::string_view bytes)
{
#if defined(_WIN32)
    HANDLE handle = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
        return false;
    bool success = true;
    for (std::size_t offset = 0; offset < bytes.size() && success;) {
        DWORD written = 0;
        const DWORD size =
            static_cast<DWORD>(std::min<std::size_t>(bytes.size() - offset, 1 << 20));
        success =
            WriteFile(handle, bytes.data() + offset, size, &written, nullptr) != 0 && written != 0;
        offset += written;
    }
    success = success && FlushFileBuffers(handle) != 0;
    success = CloseHandle(handle) != 0 && success;
    return success;
#else
    const auto fd = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0)
        return false;
    bool success = true;
    for (std::size_t offset = 0; offset < bytes.size();) {
        const auto count = write(fd, bytes.data() + offset, bytes.size() - offset);
        if (count <= 0) {
            success = false;
            break;
        }
        offset += static_cast<std::size_t>(count);
    }
    success = success && fsync(fd) == 0;
    success = close(fd) == 0 && success;
    return success;
#endif
}

bool flush_directory(const std::filesystem::path& path)
{
#if defined(_WIN32)
    (void)path;
    return true;
#else
    const auto fd = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0)
        return false;
    const bool success = fsync(fd) == 0;
    close(fd);
    return success;
#endif
}

// A process-scoped OS lock serializes writers across CLI processes. The lock
// inode is intentionally permanent: unlinking it on release would allow two
// writers to hold different locks for the same cache. The OS releases a held
// lock on process termination, including after a crash or cancellation.
class RuntimePublicationLock {
public:
    RuntimePublicationLock() = default;
    RuntimePublicationLock(const RuntimePublicationLock&) = delete;
    RuntimePublicationLock& operator=(const RuntimePublicationLock&) = delete;

    bool acquire(const std::filesystem::path& path)
    {
#if defined(_WIN32)
        handle_ =
            CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                        OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (handle_ == INVALID_HANDLE_VALUE)
            return false;
        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(handle_, &info) ||
            (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
            GetFileType(handle_) != FILE_TYPE_DISK)
            return false;
        acquired_ = LockFileEx(handle_, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &overlapped_) != 0;
        return acquired_;
#else
        descriptor_ = open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
        if (descriptor_ < 0)
            return false;
        struct stat status {};
        if (fstat(descriptor_, &status) != 0 || !S_ISREG(status.st_mode))
            return false;
        int result;
        do {
            result = flock(descriptor_, LOCK_EX);
        } while (result != 0 && errno == EINTR);
        return result == 0;
#endif
    }

    ~RuntimePublicationLock()
    {
#if defined(_WIN32)
        if (handle_ != INVALID_HANDLE_VALUE) {
            if (acquired_)
                UnlockFileEx(handle_, 0, 1, 0, &overlapped_);
            CloseHandle(handle_);
        }
#else
        if (descriptor_ >= 0) {
            flock(descriptor_, LOCK_UN);
            close(descriptor_);
        }
#endif
    }

private:
#if defined(_WIN32)
    HANDLE handle_ = INVALID_HANDLE_VALUE;
    OVERLAPPED overlapped_{};
    bool acquired_ = false;
#else
    int descriptor_ = -1;
#endif
};

Json publish_runtime(const Json& request)
{
    const auto fail = [](std::string reason) {
        return Json{{"ok", false}, {"published", false}, {"reason", std::move(reason)}};
    };
    const auto root_text = string_field(request, "projectRoot");
    const auto identity = string_field(request, "compilerIdentity");
    if (!root_text || !identity || identity->empty() || !request.contains("artifact") ||
        !request.contains("catalog") || !request.contains("runtimeInputPaths") ||
        !request.contains("testInputPaths") || !request.contains("authoringDiagnostics") ||
        !request.contains("expectedRuntimeInputs") || !request.contains("expectedTestInputs"))
        return fail("publication-request-invalid");
    if (request.contains("cancelled") && !request["cancelled"].is_boolean())
        return fail("publication-request-invalid");
    if (request.value("cancelled", false))
        return fail("publication-cancelled");
    const auto& artifact = request["artifact"];
    const auto& catalog = request["catalog"];
    const auto& diagnostics = request["authoringDiagnostics"];
    if (!artifact.is_object() || string_field(artifact, "schema") != kPreparedArtifactSchema ||
        !artifact.contains("compiledProject") || !artifact["compiledProject"].is_object() ||
        string_field(artifact["compiledProject"], "schema") != kCompiledProjectSchema ||
        integer_field(artifact["compiledProject"], "schemaVersion") != kCompiledProjectVersion ||
        !catalog_shape_valid(catalog) || !authoring_diagnostics_shape_valid(diagnostics))
        return fail("publication-artifact-invalid");
    if (!artifact.contains("gameplayJson") || !artifact["gameplayJson"].is_string() ||
        !artifact.contains("packageOptions") || !artifact["packageOptions"].is_object() ||
        !artifact.contains("sourceFingerprint") || !artifact["sourceFingerprint"].is_string())
        return fail("publication-artifact-invalid");
    const auto gameplay = Json::parse(artifact["gameplayJson"].get<std::string>(), nullptr, false);
    if (gameplay.is_discarded() || gameplay != artifact["compiledProject"] ||
        !noveltea::core::decode_compiled_project(gameplay, "native-runtime-cache"))
        return fail("publication-compiled-project-invalid");
    const auto root = filesystem_path_from_utf8(*root_text);
    std::error_code error;
    const auto root_status = std::filesystem::symlink_status(root, error);
    if (error || std::filesystem::is_symlink(root_status) ||
        !std::filesystem::is_directory(root_status) || !authoring_workspace_settled(root))
        return fail("workspace-unsettled");
    const auto generation_proof = [&]() {
        const auto expected = string_field(request, "expectedSourceGeneration");
        return !request.contains("expectedSourceGeneration") ||
               (expected && native_project_source_generation_is_current(root, *expected));
    };
    if (!generation_proof())
        return fail("source-generation-changed");
    if (!contained_physical_inputs(root, artifact))
        return fail("compiled-artifact-physical-inputs-invalid");
    if (!pinned_package_inputs_current(root, artifact))
        return fail("physical-inputs-changed-or-unpinned");
    auto runtime_inputs = collect_cache_inputs(root, request["runtimeInputPaths"]);
    auto test_inputs = collect_cache_inputs(root, request["testInputPaths"]);
    if (!runtime_inputs || !test_inputs)
        return fail("input-inspection-failed");
    if (*runtime_inputs != request["expectedRuntimeInputs"] ||
        *test_inputs != request["expectedTestInputs"])
        return fail("prepared-inputs-changed");
    std::set<std::string> runtime_paths, test_paths;
    for (const auto& item : *runtime_inputs)
        runtime_paths.insert(item.at("path").get<std::string>());
    for (const auto& item : *test_inputs)
        test_paths.insert(item.at("path").get<std::string>());
    if (!runtime_paths.contains("project.yaml") || runtime_paths.contains("editor.yaml"))
        return fail("input-membership-invalid");
    for (const auto& path : runtime_paths)
        if (path.starts_with("records/tests/"))
            return fail("input-membership-invalid");
    const Json scopes =
        Json::array({{{"root", "records"},
                      {"extensions", Json::array({".yaml", ".json", ".lua", ".rcss", ".rml"})},
                      {"excludedPrefixes", Json::array({"records/tests/"})}},
                     {{"root", "scripts"},
                      {"extensions", Json::array({".lua"})},
                      {"excludedPrefixes", Json::array()}},
                     {{"root", "i18n"},
                      {"extensions", Json::array({".yaml", ".json"})},
                      {"excludedPrefixes", Json::array()}}});
    if (!discovery_matches(root, scopes, runtime_paths) || test_files(root) != test_paths)
        return fail("discovery-inputs-changed");

    const auto cache_root = root / ".noveltea/cache/runtime";
    const auto generations = cache_root / "generations";
    if (!contained_by_root(root, generations))
        return fail("cache-root-escapes-project");
    std::filesystem::create_directories(generations, error);
    if (error)
        return fail("cache-directory-unavailable");
    for (const auto& folder :
         {root / ".noveltea", root / ".noveltea/cache", cache_root, generations}) {
        const auto status = std::filesystem::symlink_status(folder, error);
        if (error || std::filesystem::is_symlink(status) || !std::filesystem::is_directory(status))
            return fail("cache-directory-unsafe");
    }
    RuntimePublicationLock lock;
    if (!lock.acquire(cache_root / ".publish.lock"))
        return fail("cache-publication-lock-unavailable");
    const auto current_path = cache_root / "current";
    std::string old_pointer;
    const auto old_status = std::filesystem::symlink_status(current_path, error);
    if (!error) {
        if (std::filesystem::is_symlink(old_status) ||
            !std::filesystem::is_regular_file(old_status))
            return fail("cache-pointer-unsafe");
        const auto content = read_text(current_path);
        if (!content)
            return fail("cache-pointer-unreadable");
        old_pointer = *content;
    } else if (error != std::errc::no_such_file_or_directory) {
        return fail("cache-pointer-unreadable");
    }
    const auto generation = new_generation_id();
    const auto directory = generations / generation;
    if (!std::filesystem::create_directory(directory, error) || error)
        return fail("cache-generation-unavailable");
    bool published = false;
    const auto cleanup = [&]() {
        if (!published) {
            std::error_code ignored;
            std::filesystem::remove_all(directory, ignored);
        }
    };
    const auto artifact_text = artifact.dump() + "\n";
    const auto catalog_text = catalog.dump() + "\n";
    const Json manifest{
        {"schema", kCacheSchema},
        {"variant", "canonical-runtime"},
        {"compilerIdentity", *identity},
        {"projectWorkspace", {{"schema", kWorkspaceSchema}, {"formatVersion", kWorkspaceVersion}}},
        {"compiledProject",
         {{"schema", kCompiledProjectSchema}, {"formatVersion", kCompiledProjectVersion}}},
        {"preparedArtifactSchema", kPreparedArtifactSchema},
        {"discoveryScopes", scopes},
        {"authoringDiagnostics", diagnostics},
        {"inputs", *runtime_inputs},
        {"artifactFile", "artifact.json"},
        {"artifactSha256", sha256_prefixed(artifact_text)},
        {"testCatalog",
         {{"inputs", *test_inputs},
          {"catalogFile", "tests.json"},
          {"catalogSha256", sha256_prefixed(catalog_text)}}}};
    if (!write_durable_file(directory / "artifact.json", artifact_text) ||
        !write_durable_file(directory / "tests.json", catalog_text) ||
        !write_durable_file(directory / "manifest.json", manifest.dump() + "\n") ||
        !flush_directory(directory) || !flush_directory(generations)) {
        cleanup();
        return fail("cache-publication-failed");
    }
    // Acceptance-only crash window: a child process can be killed after all
    // generation files are durable but before the incumbent pointer changes.
    if (const char* injected = std::getenv("NOVELTEA_TEST_PAUSE_CACHE_COMMIT");
        injected && std::string_view(injected) == "1")
        std::this_thread::sleep_for(std::chrono::seconds(3));
    // One last input and pointer revision check after constructing the
    // generation. A failed check leaves only disposable orphan files.
    const auto latest_pointer = read_text(current_path);
    if (!generation_proof() || !pinned_package_inputs_current(root, artifact) ||
        !unchanged_cache_inputs(root, *runtime_inputs) ||
        !unchanged_cache_inputs(root, *test_inputs) || !authoring_workspace_settled(root) ||
        !discovery_matches(root, scopes, runtime_paths) || test_files(root) != test_paths ||
        latest_pointer.value_or("") != old_pointer) {
        cleanup();
        return fail("inputs-changed-during-preparation");
    }
    const auto staged_pointer = cache_root / ("current.tmp-" + generation);
    if (!write_durable_file(staged_pointer, generation + "\n")) {
        cleanup();
        return fail("cache-publication-failed");
    }
#if defined(_WIN32)
    const bool renamed = MoveFileExW(staged_pointer.c_str(), current_path.c_str(),
                                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    std::filesystem::rename(staged_pointer, current_path, error);
    const bool renamed = !error;
#endif
    if (!renamed) {
        std::filesystem::remove(staged_pointer, error);
        cleanup();
        return fail("cache-publication-failed");
    }
    published = true;
    (void)flush_directory(cache_root);
    return Json{{"ok", true}, {"published", true}, {"generation", generation}};
}

} // namespace

extern "C" std::uint64_t
noveltea_tooling_probe_authoring_cache_json(const std::uint8_t* request, std::uint64_t request_size,
                                            std::uint8_t* response_buffer,
                                            std::uint64_t response_capacity)
{
    const auto input = request == nullptr
                           ? std::string_view{}
                           : std::string_view(reinterpret_cast<const char*>(request),
                                              static_cast<std::size_t>(request_size));
    const auto parsed = Json::parse(input, nullptr, false);
    return write_response(parsed.is_discarded() ? response("unusable", "probe-request-invalid")
                                                : probe_authoring(parsed),
                          response_buffer, response_capacity);
}

extern "C" std::uint64_t noveltea_tooling_probe_runtime_cache_json(const std::uint8_t* request,
                                                                   std::uint64_t request_size,
                                                                   std::uint8_t* response_buffer,
                                                                   std::uint64_t response_capacity)
{
    const auto input = request == nullptr
                           ? std::string_view{}
                           : std::string_view(reinterpret_cast<const char*>(request),
                                              static_cast<std::size_t>(request_size));
    const auto parsed = Json::parse(input, nullptr, false);
    return write_response(parsed.is_discarded() ? response("unusable", "probe-request-invalid")
                                                : probe(parsed),
                          response_buffer, response_capacity);
}

extern "C" std::uint64_t
noveltea_tooling_publish_runtime_cache_json(const std::uint8_t* request, std::uint64_t request_size,
                                            std::uint8_t* response_buffer,
                                            std::uint64_t response_capacity)
{
    // Unlike read-only C ABI functions this operation publishes files. Never
    // perform the side effect during a buffer-size probe and then repeat it
    // when the caller resubmits with a larger output buffer.
    if (response_buffer == nullptr || response_capacity < 4096)
        return 4096;
    const auto input = request == nullptr
                           ? std::string_view{}
                           : std::string_view(reinterpret_cast<const char*>(request),
                                              static_cast<std::size_t>(request_size));
    const auto parsed = Json::parse(input, nullptr, false);
    try {
        return write_response(parsed.is_discarded()
                                  ? Json{{"ok", false},
                                         {"published", false},
                                         {"reason", "publication-request-invalid"}}
                                  : publish_runtime(parsed),
                              response_buffer, response_capacity);
    } catch (const std::exception&) {
        return write_response(
            {{"ok", false}, {"published", false}, {"reason", "cache-publication-failed"}},
            response_buffer, response_capacity);
    }
}
