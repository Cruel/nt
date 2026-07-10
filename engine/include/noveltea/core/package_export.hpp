#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <noveltea/core/project_document.hpp>

namespace noveltea::core {

enum class PackageExportKind {
    Runtime,
    Editable,
};

enum class PackageExportSeverity {
    Info,
    Warning,
    Error,
};

struct PackageExportDiagnostic {
    PackageExportSeverity severity = PackageExportSeverity::Error;
    std::string category;
    std::string path;
    std::string message;
};

struct PackageExportAssetRoot {
    std::filesystem::path root;
    std::string package_prefix;
};

struct PackageExportFileEntry {
    std::filesystem::path source;
    std::string package_path;
};

struct PackageExportOptions {
    PackageExportKind kind = PackageExportKind::Runtime;
    std::string project_name;
    std::string project_version;
    std::string created_by = "noveltea";
    std::vector<PackageExportAssetRoot> asset_roots;
    std::vector<PackageExportFileEntry> file_entries;
    std::filesystem::path shader_asset_root;
    std::vector<std::string> shader_variants;
    std::optional<nlohmann::json> shader_material_metadata;
    std::set<std::string> required_shader_binary_paths;
    bool strip_shader_sources = true;
    bool include_checksums = true;
    std::optional<nlohmann::json> display;
};

struct PackageExportResult {
    bool success = false;
    std::vector<PackageExportDiagnostic> diagnostics;
    nlohmann::json manifest = nlohmann::json::object();
    std::size_t byte_count = 0;
    std::map<std::string, std::string> checksums;

    [[nodiscard]] bool has_errors() const noexcept;
};

class ProjectPackageWriter {
public:
    [[nodiscard]] static PackageExportResult write_to_file(const ProjectDocument& project,
                                                           const std::filesystem::path& path,
                                                           const PackageExportOptions& options);

    [[nodiscard]] static PackageExportResult write_to_memory(const ProjectDocument& project,
                                                             const PackageExportOptions& options,
                                                             std::vector<std::byte>& bytes);

    [[nodiscard]] static bool is_safe_package_path(std::string_view path) noexcept;
};

} // namespace noveltea::core
