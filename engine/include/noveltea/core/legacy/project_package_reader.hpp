#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include <noveltea/core/legacy/project_importer.hpp>

namespace noveltea::core::legacy {

struct PackageError {
    std::string message;
};

struct ProjectPackage {
    ImportedProject imported_project;
    std::string game_json;
    std::vector<std::byte> image;
    std::map<std::string, std::vector<std::byte>> fonts;
    std::map<std::string, std::vector<std::byte>> textures;
    std::map<std::string, std::vector<std::byte>> assets;
};

class ProjectPackageReader {
public:
    [[nodiscard]] static std::optional<ProjectPackage> read(
        std::span<const std::byte> bytes,
        std::vector<PackageError>& errors);

    [[nodiscard]] static std::optional<ProjectPackage> read(
        std::span<const std::uint8_t> bytes,
        std::vector<PackageError>& errors);

    [[nodiscard]] static std::optional<ProjectPackage> read_file(
        const std::filesystem::path& path,
        std::vector<PackageError>& errors);
};

} // namespace noveltea::core::legacy
