#include <noveltea/core/package_export.hpp>

#include <algorithm>
#include <array>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <set>
#include <sstream>
#include <string_view>
#include <utility>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

namespace noveltea::core {

namespace {

constexpr std::string_view manifest_entry = "manifest.json";
constexpr std::string_view shader_materials_entry = "shader-materials.json";
constexpr std::array auxiliary_prefixes = {
    std::string_view{"audio/"},     std::string_view{"data/"},    std::string_view{"music/"},
    std::string_view{"resources/"}, std::string_view{"scripts/"}, std::string_view{"shaders/"},
    std::string_view{"sounds/"},    std::string_view{"text/"},    std::string_view{"texts/"},
};

struct PendingEntry {
    std::string path;
    std::vector<std::byte> bytes;
};

bool starts_with(std::string_view value, std::string_view prefix)
{
    return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

bool has_allowed_package_prefix(std::string_view path)
{
    if (path == "game" || path == "image" || path == manifest_entry ||
        path == shader_materials_entry) {
        return true;
    }
    if (starts_with(path, "fonts/") || starts_with(path, "textures/")) {
        return true;
    }
    return std::any_of(auxiliary_prefixes.begin(), auxiliary_prefixes.end(),
                       [path](std::string_view prefix) { return starts_with(path, prefix); });
}

std::string normalize_prefix(std::string prefix)
{
    std::replace(prefix.begin(), prefix.end(), '\\', '/');
    while (!prefix.empty() && prefix.front() == '/') {
        prefix.erase(prefix.begin());
    }
    while (!prefix.empty() && prefix.back() == '/') {
        prefix.pop_back();
    }
    return prefix;
}

void add_diagnostic(PackageExportResult& result, PackageExportSeverity severity,
                    std::string category, std::string path, std::string message)
{
    result.diagnostics.push_back(PackageExportDiagnostic{
        .severity = severity,
        .category = std::move(category),
        .path = std::move(path),
        .message = std::move(message),
    });
}

std::string checksum_hex(std::span<const std::byte> bytes)
{
    const auto crc = mz_crc32(MZ_CRC32_INIT, reinterpret_cast<const mz_uint8*>(bytes.data()),
                              static_cast<size_t>(bytes.size()));
    std::ostringstream out;
    out << std::hex << std::setfill('0') << std::setw(8) << crc;
    return out.str();
}

std::vector<std::byte> string_bytes(std::string_view value)
{
    const auto* first = reinterpret_cast<const std::byte*>(value.data());
    return std::vector<std::byte>(first, first + value.size());
}

void strip_shader_stage_sources(nlohmann::json& metadata)
{
    auto shaders = metadata.find("shaders");
    if (shaders == metadata.end() || !shaders->is_object()) {
        return;
    }

    for (auto& [_shader_id, shader] : shaders->items()) {
        if (!shader.is_object()) {
            continue;
        }
        auto stages = shader.find("stages");
        if (stages == shader.end() || !stages->is_object()) {
            continue;
        }
        for (auto& [_stage_name, stage] : stages->items()) {
            if (!stage.is_object()) {
                continue;
            }
            stage.erase("source");
            stage.erase("source_text");
            stage.erase("editor_preview");
            stage.erase("compile_cache");
        }
    }
}

std::optional<std::vector<std::byte>> read_file_bytes(const std::filesystem::path& path,
                                                      PackageExportResult& result,
                                                      const std::string& package_path)
{
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        add_diagnostic(result, PackageExportSeverity::Error, "asset", package_path,
                       "Failed to open asset file '" + path.string() + "'.");
        return std::nullopt;
    }

    std::vector<std::byte> bytes;
    file.unsetf(std::ios::skipws);
    if (file.seekg(0, std::ios::end)) {
        const auto size = file.tellg();
        if (size > 0) {
            bytes.reserve(static_cast<std::size_t>(size));
        }
        file.seekg(0, std::ios::beg);
    }
    std::transform(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>(),
                   std::back_inserter(bytes), [](char value) {
                       return static_cast<std::byte>(static_cast<unsigned char>(value));
                   });
    if (file.bad()) {
        add_diagnostic(result, PackageExportSeverity::Error, "asset", package_path,
                       "Failed to read asset file '" + path.string() + "'.");
        return std::nullopt;
    }
    return bytes;
}

void add_entry(std::vector<PendingEntry>& entries, PackageExportResult& result, std::string path,
               std::vector<std::byte> bytes, bool include_checksums)
{
    if (!ProjectPackageWriter::is_safe_package_path(path) || !has_allowed_package_prefix(path)) {
        add_diagnostic(result, PackageExportSeverity::Error, "asset", std::move(path),
                       "Package entry path is not allowed.");
        return;
    }
    if (include_checksums) {
        result.checksums[path] = checksum_hex(bytes);
    }
    entries.push_back(PendingEntry{.path = std::move(path), .bytes = std::move(bytes)});
}

std::string relative_package_path(const std::filesystem::path& root,
                                  const std::filesystem::path& file, std::string_view prefix)
{
    auto relative = std::filesystem::relative(file, root).generic_string();
    if (prefix.empty()) {
        return relative;
    }
    return std::string(prefix) + "/" + relative;
}

void collect_asset_root(const PackageExportAssetRoot& asset_root,
                        std::vector<PendingEntry>& entries, PackageExportResult& result,
                        bool include_checksums)
{
    const auto prefix = normalize_prefix(asset_root.package_prefix);
    if (!std::filesystem::exists(asset_root.root)) {
        add_diagnostic(result, PackageExportSeverity::Warning, "asset", prefix,
                       "Asset root does not exist: '" + asset_root.root.string() + "'.");
        return;
    }
    if (!std::filesystem::is_directory(asset_root.root)) {
        add_diagnostic(result, PackageExportSeverity::Error, "asset", prefix,
                       "Asset root is not a directory: '" + asset_root.root.string() + "'.");
        return;
    }

    std::vector<std::filesystem::path> files;
    for (const auto& item : std::filesystem::recursive_directory_iterator(asset_root.root)) {
        if (item.is_regular_file()) {
            files.push_back(item.path());
        }
    }
    std::sort(files.begin(), files.end());
    for (const auto& file : files) {
        auto package_path = relative_package_path(asset_root.root, file, prefix);
        if (!ProjectPackageWriter::is_safe_package_path(package_path) ||
            !has_allowed_package_prefix(package_path)) {
            add_diagnostic(result, PackageExportSeverity::Warning, "asset", package_path,
                           "Skipping asset outside the runtime package layout.");
            continue;
        }
        auto bytes = read_file_bytes(file, result, package_path);
        if (bytes) {
            add_entry(entries, result, std::move(package_path), std::move(*bytes),
                      include_checksums);
        }
    }
}

void collect_file_entries(const PackageExportOptions& options, std::vector<PendingEntry>& entries,
                          PackageExportResult& result)
{
    for (const auto& file_entry : options.file_entries) {
        auto package_path = file_entry.package_path;
        std::replace(package_path.begin(), package_path.end(), '\\', '/');
        if (!ProjectPackageWriter::is_safe_package_path(package_path) ||
            !has_allowed_package_prefix(package_path)) {
            add_diagnostic(result, PackageExportSeverity::Error, "asset", package_path,
                           "Package file entry path is not allowed.");
            continue;
        }
        if (file_entry.source.empty()) {
            add_diagnostic(result, PackageExportSeverity::Error, "asset", package_path,
                           "Package file entry source is empty.");
            continue;
        }
        if (!std::filesystem::exists(file_entry.source) ||
            !std::filesystem::is_regular_file(file_entry.source)) {
            add_diagnostic(result, PackageExportSeverity::Error, "asset", package_path,
                           "Package file entry source does not exist: '" +
                               file_entry.source.string() + "'.");
            continue;
        }
        auto bytes = read_file_bytes(file_entry.source, result, package_path);
        if (bytes) {
            add_entry(entries, result, std::move(package_path), std::move(*bytes),
                      options.include_checksums);
        }
    }
}

void collect_shaders(const PackageExportOptions& options, std::vector<PendingEntry>& entries,
                     PackageExportResult& result)
{
    if (options.shader_variants.empty()) {
        return;
    }
    if (options.shader_asset_root.empty()) {
        add_diagnostic(result, PackageExportSeverity::Error, "shader", "shaders/bgfx",
                       "Shader variants were requested but no shader asset root was provided.");
        return;
    }

    for (const auto& variant : options.shader_variants) {
        const auto variant_path = "shaders/bgfx/" + variant;
        const auto source_dir = options.shader_asset_root / variant_path;
        if (!std::filesystem::exists(source_dir) || !std::filesystem::is_directory(source_dir)) {
            add_diagnostic(result, PackageExportSeverity::Error, "shader", variant_path,
                           "Missing compiled shader variant directory '" + source_dir.string() +
                               "'.");
            continue;
        }

        std::vector<std::filesystem::path> files;
        for (const auto& item : std::filesystem::recursive_directory_iterator(source_dir)) {
            if (item.is_regular_file() && item.path().extension() == ".bin") {
                files.push_back(item.path());
            }
        }
        std::sort(files.begin(), files.end());
        if (files.empty()) {
            add_diagnostic(result, PackageExportSeverity::Error, "shader", variant_path,
                           "Compiled shader variant contains no .bin files.");
            continue;
        }
        for (const auto& file : files) {
            auto package_path = relative_package_path(options.shader_asset_root, file, "");
            auto bytes = read_file_bytes(file, result, package_path);
            if (bytes) {
                add_entry(entries, result, std::move(package_path), std::move(*bytes),
                          options.include_checksums);
            }
        }
    }
}

void collect_shader_material_metadata(const PackageExportOptions& options,
                                      std::vector<PendingEntry>& entries,
                                      PackageExportResult& result)
{
    if (!options.shader_material_metadata) {
        return;
    }

    nlohmann::json metadata = *options.shader_material_metadata;
    if (!metadata.is_object()) {
        add_diagnostic(result, PackageExportSeverity::Error, "shader",
                       std::string(shader_materials_entry),
                       "Shader/material metadata root must be an object.");
        return;
    }
    if (options.strip_shader_sources) {
        strip_shader_stage_sources(metadata);
    }
    add_entry(entries, result, std::string(shader_materials_entry), string_bytes(metadata.dump(2)),
              options.include_checksums);
}

void verify_required_shader_binaries(const PackageExportOptions& options,
                                     const std::vector<PendingEntry>& entries,
                                     PackageExportResult& result)
{
    if (options.required_shader_binary_paths.empty()) {
        return;
    }

    std::set<std::string> available;
    for (const auto& entry : entries) {
        available.insert(entry.path);
    }
    for (const auto& required : options.required_shader_binary_paths) {
        if (!ProjectPackageWriter::is_safe_package_path(required) ||
            !starts_with(required, "shaders/bgfx/")) {
            add_diagnostic(result, PackageExportSeverity::Error, "shader", required,
                           "Required shader package path is not safe.");
            continue;
        }
        if (!available.contains(required)) {
            add_diagnostic(result, PackageExportSeverity::Error, "shader", required,
                           "Required material shader package entry is missing.");
        }
    }
}

nlohmann::json build_manifest(const PackageExportOptions& options,
                              const std::vector<PendingEntry>& entries,
                              const PackageExportResult& result)
{
    auto manifest = nlohmann::json::object();
    manifest["format"] = "noveltea.runtime-package";
    manifest["format_version"] = 1;
    manifest["kind"] = options.kind == PackageExportKind::Runtime ? "runtime" : "editable";
    manifest["created_by"] = options.created_by;
    manifest["project"] = nlohmann::json::object({
        {"name", options.project_name},
        {"version", options.project_version},
    });
    if (options.display) {
        manifest["display"] = *options.display;
    }
    if (options.platform) {
        manifest["platform"] = *options.platform;
    }
    manifest["shader_variants"] = options.shader_variants;
    if (options.shader_material_metadata) {
        manifest["shader_materials"] = nlohmann::json::object({
            {"entry", shader_materials_entry},
            {"schema", "noveltea.shader-materials.v1"},
            {"sources_stripped", options.strip_shader_sources},
        });
    }
    manifest["entries"] = nlohmann::json::array();
    for (const auto& entry : entries) {
        if (entry.path == manifest_entry) {
            continue;
        }
        manifest["entries"].push_back(nlohmann::json::object({
            {"path", entry.path},
            {"size", entry.bytes.size()},
        }));
    }
    if (options.include_checksums) {
        manifest["checksums"] = result.checksums;
    }
    return manifest;
}

bool add_zip_entry(mz_zip_archive& archive, const PendingEntry& entry, PackageExportResult& result)
{
    if (!mz_zip_writer_add_mem(&archive, entry.path.c_str(), entry.bytes.data(), entry.bytes.size(),
                               MZ_DEFAULT_COMPRESSION)) {
        add_diagnostic(result, PackageExportSeverity::Error, "package", entry.path,
                       "Failed to add package entry.");
        return false;
    }
    return true;
}

PackageExportResult write_zip(const ProjectDocument& project, const PackageExportOptions& options,
                              std::vector<std::byte>& bytes)
{
    PackageExportResult result;
    std::vector<PendingEntry> entries;
    add_entry(entries, result, "game", string_bytes(project.dump()), options.include_checksums);

    for (const auto& root : options.asset_roots) {
        collect_asset_root(root, entries, result, options.include_checksums);
    }
    collect_file_entries(options, entries, result);
    collect_shaders(options, entries, result);
    collect_shader_material_metadata(options, entries, result);

    std::stable_sort(
        entries.begin(), entries.end(),
        [](const PendingEntry& lhs, const PendingEntry& rhs) { return lhs.path < rhs.path; });
    entries.erase(std::unique(entries.begin(), entries.end(),
                              [&result](const PendingEntry& lhs, const PendingEntry& rhs) {
                                  if (lhs.path == rhs.path) {
                                      add_diagnostic(result, PackageExportSeverity::Warning,
                                                     "asset", rhs.path,
                                                     "Skipping duplicate package entry.");
                                      return true;
                                  }
                                  return false;
                              }),
                  entries.end());
    verify_required_shader_binaries(options, entries, result);
    if (options.include_checksums) {
        result.checksums.clear();
        for (const auto& entry : entries) {
            result.checksums[entry.path] = checksum_hex(entry.bytes);
        }
    }

    result.manifest = build_manifest(options, entries, result);
    entries.push_back(PendingEntry{.path = std::string(manifest_entry),
                                   .bytes = string_bytes(result.manifest.dump(2))});

    if (result.has_errors()) {
        result.success = false;
        return result;
    }

    mz_zip_archive archive{};
    if (!mz_zip_writer_init_heap(&archive, 0, 0)) {
        add_diagnostic(result, PackageExportSeverity::Error, "package", {},
                       "Failed to initialize package ZIP writer.");
        return result;
    }

    bool ok = true;
    for (const auto& entry : entries) {
        ok = add_zip_entry(archive, entry, result) && ok;
    }

    void* data = nullptr;
    size_t size = 0;
    if (ok && !mz_zip_writer_finalize_heap_archive(&archive, &data, &size)) {
        add_diagnostic(result, PackageExportSeverity::Error, "package", {},
                       "Failed to finalize package ZIP data.");
        ok = false;
    }

    if (ok) {
        auto* first = static_cast<const std::byte*>(data);
        bytes.assign(first, first + size);
        result.byte_count = bytes.size();
    }
    mz_free(data);
    if (!mz_zip_writer_end(&archive)) {
        add_diagnostic(result, PackageExportSeverity::Error, "package", {},
                       "Failed to close package ZIP writer.");
        ok = false;
    }

    result.success = ok && !result.has_errors();
    return result;
}

} // namespace

bool PackageExportResult::has_errors() const noexcept
{
    return std::any_of(diagnostics.begin(), diagnostics.end(), [](const auto& diagnostic) {
        return diagnostic.severity == PackageExportSeverity::Error;
    });
}

PackageExportResult ProjectPackageWriter::write_to_file(const ProjectDocument& project,
                                                        const std::filesystem::path& path,
                                                        const PackageExportOptions& options)
{
    std::vector<std::byte> bytes;
    auto result = write_to_memory(project, options, bytes);
    if (!result.success) {
        return result;
    }

    if (path.has_parent_path()) {
        std::filesystem::create_directories(path.parent_path());
    }
    std::ofstream file(path, std::ios::binary);
    if (!file) {
        add_diagnostic(result, PackageExportSeverity::Error, "package", path.string(),
                       "Failed to open output package file.");
        result.success = false;
        return result;
    }
    file.write(reinterpret_cast<const char*>(bytes.data()),
               static_cast<std::streamsize>(bytes.size()));
    if (!file) {
        add_diagnostic(result, PackageExportSeverity::Error, "package", path.string(),
                       "Failed to write output package file.");
        result.success = false;
        return result;
    }
    result.byte_count = bytes.size();
    result.success = !result.has_errors();
    return result;
}

PackageExportResult ProjectPackageWriter::write_to_memory(const ProjectDocument& project,
                                                          const PackageExportOptions& options,
                                                          std::vector<std::byte>& bytes)
{
    bytes.clear();
    return write_zip(project, options, bytes);
}

bool ProjectPackageWriter::is_safe_package_path(std::string_view path) noexcept
{
    if (path.empty() || path.front() == '/' || path.find('\\') != std::string_view::npos) {
        return false;
    }
    if (path.find("//") != std::string_view::npos || path.find(':') != std::string_view::npos) {
        return false;
    }

    std::size_t start = 0;
    while (start <= path.size()) {
        const std::size_t slash = path.find('/', start);
        const auto part =
            path.substr(start, slash == std::string_view::npos ? slash : slash - start);
        if (part.empty() || part == "." || part == "..") {
            return false;
        }
        if (slash == std::string_view::npos) {
            break;
        }
        start = slash + 1;
    }
    return true;
}

} // namespace noveltea::core
