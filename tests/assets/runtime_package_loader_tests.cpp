#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/boundary/running_game_loader.hpp"
#include "noveltea/core/compiled_project_codec.hpp"

#include <nlohmann/json.hpp>

#include <array>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

using namespace noveltea;

namespace {

struct ZipFixtureEntry {
    std::string path;
    assets::AssetBytes bytes;
    mz_uint compression = MZ_DEFAULT_COMPRESSION;
};

assets::AssetBytes bytes(std::string_view value)
{
    return assets::AssetBytes(value.begin(), value.end());
}

assets::AssetBytes json_bytes(const nlohmann::json& value) { return bytes(value.dump()); }

nlohmann::json minimal_gameplay()
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/"
                             "minimal.json";
    std::ifstream file(path, std::ios::binary);
    REQUIRE(file.good());
    const std::string text((std::istreambuf_iterator<char>(file)),
                           std::istreambuf_iterator<char>());
    auto value = nlohmann::json::parse(text, nullptr, false);
    REQUIRE_FALSE(value.is_discarded());
    return value;
}

nlohmann::json runtime_manifest(const nlohmann::json& gameplay,
                                std::span<const std::pair<std::string, std::uint64_t>> entries)
{
    auto decoded = core::decode_compiled_project(gameplay, "game");
    REQUIRE(decoded.has_value());
    const auto& project = *decoded.value_if();
    const auto& settings = project.settings();

    nlohmann::json package_entries = nlohmann::json::array();
    for (const auto& [path, size] : entries)
        package_entries.push_back({{"path", path}, {"size", size}});

    return {
        {"format", "noveltea.runtime-package"},
        {"format_version", 2},
        {"kind", "runtime"},
        {"created_by", "runtime-package-loader-test"},
        {"project", {{"name", project.identity().name}, {"version", project.identity().version}}},
        {"display",
         {{"reference_resolution",
           {{"width", settings.display.reference_resolution.width},
            {"height", settings.display.reference_resolution.height}}},
          {"world_raster_policy",
           settings.display.world_raster_policy == core::compiled::WorldRasterPolicy::Native
               ? "native"
               : "capped"},
          {"bar_color", settings.display.bar_color}}},
        {"accessibility",
         {{"ui_scale",
           {{"enabled", settings.accessibility.ui_scale.enabled},
            {"minimum", settings.accessibility.ui_scale.minimum},
            {"maximum", settings.accessibility.ui_scale.maximum}}},
          {"text_scale",
           {{"enabled", settings.accessibility.text_scale.enabled},
            {"minimum", settings.accessibility.text_scale.minimum},
            {"maximum", settings.accessibility.text_scale.maximum}}}}},
        {"shader_variants", nlohmann::json::array()},
        {"entries", std::move(package_entries)},
    };
}

assets::AssetBytes make_zip(std::span<const ZipFixtureEntry> entries)
{
    mz_zip_archive archive{};
    REQUIRE(mz_zip_writer_init_heap(&archive, 0, 0));
    for (const auto& entry : entries) {
        REQUIRE(mz_zip_writer_add_mem(&archive, entry.path.c_str(), entry.bytes.data(),
                                      entry.bytes.size(), entry.compression));
    }
    void* data = nullptr;
    size_t size = 0;
    REQUIRE(mz_zip_writer_finalize_heap_archive(&archive, &data, &size));
    REQUIRE(data != nullptr);
    const auto* first = static_cast<const std::uint8_t*>(data);
    assets::AssetBytes result(first, first + size);
    mz_free(data);
    REQUIRE(mz_zip_writer_end(&archive));
    return result;
}

void write_bytes(const std::filesystem::path& path, std::span<const std::uint8_t> contents)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char*>(contents.data()),
               static_cast<std::streamsize>(contents.size()));
    REQUIRE(file.good());
}

std::uint16_t little_u16(const std::uint8_t* value)
{
    return static_cast<std::uint16_t>(value[0]) |
           static_cast<std::uint16_t>(static_cast<std::uint16_t>(value[1]) << 8u);
}

std::size_t stored_data_offset(const assets::AssetBytes& archive_bytes, std::string_view path)
{
    mz_zip_archive archive{};
    REQUIRE(mz_zip_reader_init_mem(&archive, archive_bytes.data(), archive_bytes.size(), 0));
    const int index = mz_zip_reader_locate_file(&archive, std::string(path).c_str(), nullptr, 0);
    REQUIRE(index >= 0);
    mz_zip_archive_file_stat stat{};
    REQUIRE(mz_zip_reader_file_stat(&archive, static_cast<mz_uint>(index), &stat));
    REQUIRE(stat.m_method == 0);
    const auto offset = static_cast<std::size_t>(stat.m_local_header_ofs);
    REQUIRE(offset + 30u <= archive_bytes.size());
    const auto result = offset + 30u + little_u16(archive_bytes.data() + offset + 26u) +
                        little_u16(archive_bytes.data() + offset + 28u);
    REQUIRE(mz_zip_reader_end(&archive));
    return result;
}

std::filesystem::path test_root(std::string_view name)
{
    static std::atomic_uint64_t sequence = 0;
    auto root = std::filesystem::temp_directory_path() /
                ("noveltea-runtime-package-loader-" + std::string(name) + "-" +
                 std::to_string(sequence.fetch_add(1)));
    std::filesystem::remove_all(root);
    std::filesystem::create_directories(root);
    return root;
}

class CountingDirectorySource final : public assets::AssetSource {
public:
    explicit CountingDirectorySource(std::filesystem::path root) : m_source(std::move(root)) {}

    assets::AssetResult<assets::AssetEntryMetadata>
    stat(const assets::AssetPath& path) const override
    {
        ++m_stat_calls;
        return m_source.stat(path);
    }

    assets::AssetResult<assets::AssetReaderPtr> open(const assets::AssetPath& path) const override
    {
        ++m_open_calls;
        return m_source.open(path);
    }

    assets::AssetResult<assets::AssetBlob> read_binary(const assets::AssetPath& path) const override
    {
        ++m_read_binary_calls;
        return m_source.read_binary(path);
    }

    bool exists(const assets::AssetPath& path) const override { return m_source.exists(path); }
    std::string describe() const override { return m_source.describe(); }
    const char* kind() const override { return "counting-directory"; }

    [[nodiscard]] std::size_t open_calls() const { return m_open_calls; }
    [[nodiscard]] std::size_t read_binary_calls() const { return m_read_binary_calls; }

private:
    assets::DirectoryAssetSource m_source;
    mutable std::size_t m_stat_calls = 0;
    mutable std::size_t m_open_calls = 0;
    mutable std::size_t m_read_binary_calls = 0;
};

bool has_code(const core::Diagnostics& diagnostics, std::string_view code)
{
    for (const auto& diagnostic : diagnostics) {
        if (diagnostic.code == code)
            return true;
    }
    return false;
}

} // namespace

TEST_CASE("runtime package startup mounts a path-backed ZIP without eager extraction",
          "[assets][residency-matrix]")
{
    const auto root = test_root("large");
    const auto package_path = root / "game.ntpkg";
    const auto gameplay = minimal_gameplay();
    const auto gameplay_bytes = json_bytes(gameplay);
    assets::AssetBytes sentinel(16u * 1024u * 1024u, std::uint8_t{'s'});
    const std::array declared = {
        std::pair<std::string, std::uint64_t>{"game", gameplay_bytes.size()},
        std::pair<std::string, std::uint64_t>{"assets/large-sentinel.bin", sentinel.size()},
    };
    const auto manifest_bytes = json_bytes(runtime_manifest(gameplay, declared));
    const std::array entries = {
        ZipFixtureEntry{"game", gameplay_bytes, MZ_BEST_COMPRESSION},
        ZipFixtureEntry{"manifest.json", manifest_bytes, MZ_BEST_COMPRESSION},
        ZipFixtureEntry{"assets/large-sentinel.bin", std::move(sentinel), MZ_BEST_COMPRESSION},
    };
    auto archive = make_zip(entries);
    write_bytes(package_path, archive);
    archive.clear();
    archive.shrink_to_fit();

    auto directory = std::make_shared<CountingDirectorySource>(root);
    assets::AssetManager manager;
    manager.mount("project", directory);

    auto resolved = runtime::resolve_running_game_source(manager, "project:/game.ntpkg", "en");
    REQUIRE(resolved.has_value());
    CHECK(directory->open_calls() == 1);
    CHECK(directory->read_binary_calls() == 0);
    CHECK(resolved.value_if()->replaces_project_namespace);
    REQUIRE(resolved.value_if()->project_mounts.size() == 1);
    CHECK(resolved.value_if()->project_mounts.front()->kind() == std::string_view("ZIP"));
    CHECK(resolved.value_if()->project_mounts.front()->describe().find("ZIP read-only:path:") == 0);
    REQUIRE(resolved.value_if()->input.decoded_package.has_value());
    CHECK(resolved.value_if()->input.gameplay.is_null());
    CHECK(resolved.value_if()->input.manifest.is_null());
    CHECK_FALSE(resolved.value_if()->input.shader_materials.has_value());

    (void)manager.replace_namespace("project", std::move(resolved.value_if()->project_mounts));
    {
        auto loaded = manager.read_binary("project:/assets/large-sentinel.bin");
        REQUIRE(loaded);
        REQUIRE(loaded.value->bytes.size() == 16u * 1024u * 1024u);
        CHECK(loaded.value->bytes.front() == std::uint8_t{'s'});
        CHECK(loaded.value->bytes.back() == std::uint8_t{'s'});
    }
    auto loaded_again = manager.read_binary("project:/assets/large-sentinel.bin");
    REQUIRE(loaded_again);
    CHECK(loaded_again.value->bytes.size() == 16u * 1024u * 1024u);

    std::filesystem::remove_all(root);
}

TEST_CASE("Web runtime package startup consumes one immutable memory-backed ZIP",
          "[assets][residency-matrix]")
{
    const auto gameplay = minimal_gameplay();
    const auto gameplay_bytes = json_bytes(gameplay);
    const auto sentinel = bytes("web-on-demand-sentinel");
    const std::array declared = {
        std::pair<std::string, std::uint64_t>{"game", gameplay_bytes.size()},
        std::pair<std::string, std::uint64_t>{"assets/web-sentinel.bin", sentinel.size()},
    };
    const auto manifest_bytes = json_bytes(runtime_manifest(gameplay, declared));
    const std::array entries = {
        ZipFixtureEntry{"game", gameplay_bytes, MZ_BEST_COMPRESSION},
        ZipFixtureEntry{"manifest.json", manifest_bytes, MZ_BEST_COMPRESSION},
        ZipFixtureEntry{"assets/web-sentinel.bin", sentinel, MZ_BEST_COMPRESSION},
    };

    auto mutable_backing = std::make_shared<assets::AssetBytes>(make_zip(entries));
    std::weak_ptr<const assets::AssetBytes> backing_lifetime = mutable_backing;
    std::shared_ptr<const assets::AssetBytes> immutable_backing = std::move(mutable_backing);
    auto source = std::make_shared<assets::ZipAssetSource>(std::move(immutable_backing));

    assets::AssetManager manager;
    auto resolved = runtime::resolve_running_game_package_source(std::move(source),
                                                                 "project:/game.ntpkg", "en");
    REQUIRE(resolved.has_value());
    REQUIRE_FALSE(backing_lifetime.expired());
    CHECK_FALSE(manager.has_namespace("project"));
    CHECK(resolved.value_if()->replaces_project_namespace);
    REQUIRE(resolved.value_if()->project_mounts.size() == 1);
    CHECK(resolved.value_if()->project_mounts.front()->describe().find("ZIP read-only:memory:") ==
          0);
    REQUIRE(resolved.value_if()->input.decoded_package.has_value());
    CHECK(resolved.value_if()->input.gameplay.is_null());
    CHECK(resolved.value_if()->input.manifest.is_null());

    (void)manager.replace_namespace("project", std::move(resolved.value_if()->project_mounts));
    auto loaded = manager.read_text("project:/assets/web-sentinel.bin");
    REQUIRE(loaded);
    CHECK(*loaded.value == "web-on-demand-sentinel");

    manager.clear_namespace("project");
    CHECK(backing_lifetime.expired());
}

TEST_CASE("runtime package startup leaves an unrequested corrupt entry untouched")
{
    const auto root = test_root("corrupt-sentinel");
    const auto package_path = root / "game.ntpkg";
    const auto gameplay = minimal_gameplay();
    const auto gameplay_bytes = json_bytes(gameplay);
    const auto sentinel = bytes("unrequested-sentinel");
    const std::array declared = {
        std::pair<std::string, std::uint64_t>{"game", gameplay_bytes.size()},
        std::pair<std::string, std::uint64_t>{"assets/sentinel.bin", sentinel.size()},
    };
    const auto manifest_bytes = json_bytes(runtime_manifest(gameplay, declared));
    const std::array entries = {
        ZipFixtureEntry{"game", gameplay_bytes, MZ_NO_COMPRESSION},
        ZipFixtureEntry{"manifest.json", manifest_bytes, MZ_NO_COMPRESSION},
        ZipFixtureEntry{"assets/sentinel.bin", sentinel, MZ_NO_COMPRESSION},
    };
    auto archive = make_zip(entries);
    const auto offset = stored_data_offset(archive, "assets/sentinel.bin");
    REQUIRE(offset < archive.size());
    archive[offset] ^= 0x20u;
    write_bytes(package_path, archive);

    assets::AssetManager manager;
    manager.mount_directory("project", root);
    auto resolved = runtime::resolve_running_game_source(manager, "project:/game.ntpkg");
    REQUIRE(resolved.has_value());
    (void)manager.replace_namespace("project", std::move(resolved.value_if()->project_mounts));
    const auto sentinel_read = manager.read_binary("project:/assets/sentinel.bin");
    REQUIRE_FALSE(sentinel_read);
    CHECK(sentinel_read.error.code == assets::asset_source_error_code::corrupt);

    std::filesystem::remove_all(root);
}

TEST_CASE("runtime package startup rejects corruption in a required metadata entry")
{
    const auto root = test_root("corrupt-game");
    const auto package_path = root / "game.ntpkg";
    const auto gameplay = minimal_gameplay();
    const auto gameplay_bytes = json_bytes(gameplay);
    const std::array declared = {
        std::pair<std::string, std::uint64_t>{"game", gameplay_bytes.size()},
    };
    const auto manifest_bytes = json_bytes(runtime_manifest(gameplay, declared));
    const std::array entries = {
        ZipFixtureEntry{"game", gameplay_bytes, MZ_NO_COMPRESSION},
        ZipFixtureEntry{"manifest.json", manifest_bytes, MZ_NO_COMPRESSION},
    };
    auto archive = make_zip(entries);
    const auto offset = stored_data_offset(archive, "game");
    REQUIRE(offset < archive.size());
    archive[offset] ^= 0x01u;
    write_bytes(package_path, archive);

    assets::AssetManager manager;
    manager.mount_directory("project", root);
    const auto resolved = runtime::resolve_running_game_source(manager, "project:/game.ntpkg");
    REQUIRE_FALSE(resolved.has_value());
    CHECK(has_code(resolved.error(), "content.runtime_package_invalid"));

    std::filesystem::remove_all(root);
}

TEST_CASE("materialized Android-style packages release and reload through path-backed sources",
          "[assets][residency-matrix]")
{
    const auto root = test_root("android-materialized");
    const auto materialized_root = root / "bootstrap";
    const auto package_path = materialized_root / "game.ntpkg";
    const auto gameplay = minimal_gameplay();
    const auto gameplay_bytes = json_bytes(gameplay);

    const auto write_package = [&](std::string_view value) {
        const auto payload = bytes(value);
        const std::array declared = {
            std::pair<std::string, std::uint64_t>{"game", gameplay_bytes.size()},
            std::pair<std::string, std::uint64_t>{"assets/reload.txt", payload.size()},
        };
        const auto manifest_bytes = json_bytes(runtime_manifest(gameplay, declared));
        const std::array entries = {
            ZipFixtureEntry{"game", gameplay_bytes, MZ_BEST_COMPRESSION},
            ZipFixtureEntry{"manifest.json", manifest_bytes, MZ_BEST_COMPRESSION},
            ZipFixtureEntry{"assets/reload.txt", payload, MZ_NO_COMPRESSION},
        };
        write_bytes(package_path, make_zip(entries));
    };

    assets::AssetManager manager;
    manager.mount_directory("project", materialized_root);
    write_package("first");
    auto first = runtime::resolve_running_game_source(manager, "project:/game.ntpkg");
    REQUIRE(first.has_value());
    CHECK(first.value_if()->project_mounts.front()->describe().find("ZIP read-only:path:") == 0);
    (void)manager.replace_namespace("project", std::move(first.value_if()->project_mounts));
    auto first_value = manager.read_text("project:/assets/reload.txt");
    REQUIRE(first_value);
    CHECK(*first_value.value == "first");

    manager.clear_namespace("project");
    write_package("second");
    manager.mount_directory("project", materialized_root);
    auto second = runtime::resolve_running_game_source(manager, "project:/game.ntpkg");
    REQUIRE(second.has_value());
    (void)manager.replace_namespace("project", std::move(second.value_if()->project_mounts));
    auto second_value = manager.read_text("project:/assets/reload.txt");
    REQUIRE(second_value);
    CHECK(*second_value.value == "second");

    std::filesystem::remove_all(root);
}
