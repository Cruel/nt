#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/package_export.hpp>

#include <array>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

using namespace noveltea::core;

namespace {

void write_file(const std::filesystem::path& path, std::string_view contents)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    REQUIRE(file.good());
}

mz_uint16 method_for(mz_zip_archive& archive, const char* path)
{
    const int index = mz_zip_reader_locate_file(&archive, path, nullptr, 0);
    REQUIRE(index >= 0);
    mz_zip_archive_file_stat stat{};
    REQUIRE(mz_zip_reader_file_stat(&archive, static_cast<mz_uint>(index), &stat));
    return stat.m_method;
}

} // namespace

TEST_CASE("runtime package exporter stores compressed media and long-form audio entries")
{
    const auto root =
        std::filesystem::temp_directory_path() / "noveltea-package-storage-policy-test";
    std::filesystem::remove_all(root);
    std::filesystem::create_directories(root);
    write_file(root / "voice.ogg", std::string(1024, 'o'));
    write_file(root / "voice.opus", std::string(1024, 'u'));
    write_file(root / "voice.mp3", std::string(1024, 'm'));
    write_file(root / "background.png", std::string(1024, 'p'));
    write_file(root / "photo.jpg", std::string(1024, 'j'));
    write_file(root / "photo.jpeg", std::string(1024, 'e'));
    write_file(root / "background.webp", std::string(1024, 'w'));
    write_file(root / "theme.wav", std::string(4096, 'm'));
    write_file(root / "config.json", std::string(4096, 'j'));

    PackageExportOptions options;
    options.project_name = "Storage Policy";
    options.project_version = "1.0.0";
    options.display = nlohmann::json::object();
    options.accessibility = nlohmann::json::object();
    options.file_entries = {
        PackageExportFileEntry{root / "voice.ogg", "audio/voice.ogg"},
        PackageExportFileEntry{root / "voice.opus", "audio/voice.opus"},
        PackageExportFileEntry{root / "voice.mp3", "audio/voice.mp3"},
        PackageExportFileEntry{root / "background.png", "textures/background.png"},
        PackageExportFileEntry{root / "photo.jpg", "textures/photo.jpg"},
        PackageExportFileEntry{root / "photo.jpeg", "textures/photo.jpeg"},
        PackageExportFileEntry{root / "background.webp", "textures/background.webp"},
        PackageExportFileEntry{root / "theme.wav", "music/theme.wav"},
        PackageExportFileEntry{root / "config.json", "data/config.json"},
    };

    std::vector<std::byte> package;
    const auto result =
        ProjectPackageWriter::write_to_memory(nlohmann::json::object(), options, package);
    REQUIRE(result.success);

    mz_zip_archive archive{};
    REQUIRE(mz_zip_reader_init_mem(&archive, package.data(), package.size(), 0));
    constexpr std::array stored_paths = {
        "audio/voice.ogg",          "audio/voice.opus",   "audio/voice.mp3",
        "textures/background.png",  "textures/photo.jpg", "textures/photo.jpeg",
        "textures/background.webp", "music/theme.wav",
    };
    for (const char* path : stored_paths)
        CHECK(method_for(archive, path) == 0);
    CHECK(method_for(archive, "data/config.json") != 0);
    REQUIRE(mz_zip_reader_end(&archive));

    std::filesystem::remove_all(root);
}
