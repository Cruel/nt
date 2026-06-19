#include <noveltea/core/legacy/project_package_reader.hpp>

#include <algorithm>
#include <fstream>
#include <iterator>
#include <string_view>
#include <utility>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

namespace noveltea::core::legacy {

namespace {

constexpr std::string_view fonts_prefix = "fonts/";
constexpr std::string_view textures_prefix = "textures/";
constexpr std::string_view auxiliary_prefixes[] = {
    "audio/",
    "data/",
    "music/",
    "resources/",
    "scripts/",
    "shaders/",
    "sounds/",
    "text/",
    "texts/",
};

void add_error(std::vector<PackageError>& errors, std::string message)
{
    errors.push_back(PackageError {std::move(message)});
}

std::string bytes_to_string(const std::vector<std::byte>& bytes)
{
    if (bytes.empty()) {
        return {};
    }
    const auto* first = reinterpret_cast<const char*>(bytes.data());
    return std::string(first, first + bytes.size());
}

bool starts_with(std::string_view value, std::string_view prefix)
{
    return value.size() >= prefix.size() && value.substr(0, prefix.size()) == prefix;
}

bool is_safe_relative_asset_path(std::string_view value)
{
    if (value.empty() || value.front() == '/' || value.find('\\') != std::string_view::npos) {
        return false;
    }
    if (value.find("//") != std::string_view::npos || value.find(':') != std::string_view::npos) {
        return false;
    }

    std::size_t start = 0;
    while (start <= value.size()) {
        const std::size_t slash = value.find('/', start);
        const std::string_view part = value.substr(start, slash == std::string_view::npos ? slash : slash - start);
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

bool is_auxiliary_asset_path(std::string_view name)
{
    return std::any_of(std::begin(auxiliary_prefixes), std::end(auxiliary_prefixes), [&](std::string_view prefix) {
        return starts_with(name, prefix);
    });
}

std::optional<std::vector<std::byte>> extract_entry(
    mz_zip_archive& archive,
    mz_uint index,
    std::string_view name,
    std::vector<PackageError>& errors)
{
    size_t size = 0;
    void* data = mz_zip_reader_extract_to_heap(&archive, index, &size, 0);
    if (data == nullptr && size != 0) {
        add_error(errors, "Failed to extract legacy package entry '" + std::string(name) + "'.");
        return std::nullopt;
    }

    std::vector<std::byte> result(size);
    if (size != 0) {
        auto* first = static_cast<const std::byte*>(data);
        result.assign(first, first + size);
    }
    mz_free(data);
    return result;
}

} // namespace

std::optional<ProjectPackage> ProjectPackageReader::read(
    std::span<const std::byte> bytes,
    std::vector<PackageError>& errors)
{
    errors.clear();

    mz_zip_archive archive {};
    if (!mz_zip_reader_init_mem(&archive, bytes.data(), bytes.size(), 0)) {
        add_error(errors, "Failed to open legacy project package as ZIP data.");
        return std::nullopt;
    }

    ProjectPackage package;
    bool has_game = false;

    const mz_uint file_count = mz_zip_reader_get_num_files(&archive);
    for (mz_uint index = 0; index < file_count; ++index) {
        mz_zip_archive_file_stat stat {};
        if (!mz_zip_reader_file_stat(&archive, index, &stat)) {
            add_error(errors, "Failed to inspect legacy package ZIP entry.");
            continue;
        }
        if (mz_zip_reader_is_file_a_directory(&archive, index)) {
            continue;
        }

        const std::string name = stat.m_filename;
        auto payload = extract_entry(archive, index, name, errors);
        if (!payload.has_value()) {
            continue;
        }

        if (name == "game") {
            package.game_json = bytes_to_string(*payload);
            has_game = true;
        } else if (name == "image") {
            package.image = std::move(*payload);
        } else if (starts_with(name, fonts_prefix)) {
            const std::string relative = name.substr(fonts_prefix.size());
            if (is_safe_relative_asset_path(relative)) {
                package.fonts.emplace(relative, std::move(*payload));
            }
        } else if (starts_with(name, textures_prefix)) {
            const std::string relative = name.substr(textures_prefix.size());
            if (is_safe_relative_asset_path(relative)) {
                package.textures.emplace(relative, std::move(*payload));
            }
        } else if (is_auxiliary_asset_path(name) && is_safe_relative_asset_path(name)) {
            package.assets.emplace(name, std::move(*payload));
        }
    }

    mz_zip_reader_end(&archive);

    if (!errors.empty()) {
        return std::nullopt;
    }
    if (!has_game) {
        add_error(errors, "Legacy project package is missing required 'game' entry.");
        return std::nullopt;
    }

    std::vector<ImportError> import_errors;
    auto imported = ProjectImporter::import_game_json_text(package.game_json, import_errors);
    if (!imported.has_value()) {
        for (const auto& error : import_errors) {
            add_error(errors, "Legacy package game import failed: " + error.message);
        }
        return std::nullopt;
    }

    package.imported_project = std::move(*imported);
    return package;
}

std::optional<ProjectPackage> ProjectPackageReader::read(
    std::span<const std::uint8_t> bytes,
    std::vector<PackageError>& errors)
{
    return read(
        std::span<const std::byte>(
            reinterpret_cast<const std::byte*>(bytes.data()),
            bytes.size()),
        errors);
}

std::optional<ProjectPackage> ProjectPackageReader::read_file(
    const std::filesystem::path& path,
    std::vector<PackageError>& errors)
{
    errors.clear();
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        add_error(errors, "Failed to open legacy project package file '" + path.string() + "'.");
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
    std::transform(
        std::istreambuf_iterator<char>(file),
        std::istreambuf_iterator<char>(),
        std::back_inserter(bytes),
        [](char value) { return static_cast<std::byte>(static_cast<unsigned char>(value)); });
    if (file.bad()) {
        add_error(errors, "Failed to read legacy project package file '" + path.string() + "'.");
        return std::nullopt;
    }

    return read(std::span<const std::byte>(bytes.data(), bytes.size()), errors);
}

} // namespace noveltea::core::legacy
