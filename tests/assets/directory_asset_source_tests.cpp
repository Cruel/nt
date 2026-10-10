#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_source.hpp"
#include "noveltea/assets/asset_manager.hpp"

#include <filesystem>
#include <fstream>

using namespace noveltea::assets;

TEST_CASE("DirectoryAssetSource describes Unicode roots as UTF-8")
{
    const auto root =
        std::filesystem::temp_directory_path() / std::filesystem::path(u8"noveltea-雪-source-test");
    DirectoryAssetSource source(root);
    CHECK(source.describe().find("noveltea-\xE9\x9B\xAA-source-test") != std::string::npos);
}

TEST_CASE("DirectoryAssetSource reads files and exposes native metadata")
{
    const auto root = std::filesystem::temp_directory_path() / "noveltea-directory-source-test";
    std::filesystem::remove_all(root);
    std::filesystem::create_directories(root / "nested");
    std::ofstream(root / "nested" / "file.txt", std::ios::binary) << "hello";
    std::ofstream(root / "empty.bin", std::ios::binary);

    DirectoryAssetSource source(root);
    auto blob = source.read_binary(*AssetPath::parse("project:/nested/file.txt"));
    REQUIRE(blob);
    CHECK(blob.value->bytes == AssetBytes{'h', 'e', 'l', 'l', 'o'});
    CHECK(blob.value->native_path.has_value());

    auto empty = source.read_binary(*AssetPath::parse("project:/empty.bin"));
    REQUIRE(empty);
    CHECK(empty.value->bytes.empty());

    auto opened = source.open(*AssetPath::parse("project:/nested/file.txt"));
    REQUIRE(opened);
    CHECK((*opened.value)->seek(1, AssetSeekOrigin::Begin));
    CHECK(*(*opened.value)->tell().value == 1);
    CHECK_FALSE(source.open(*AssetPath::parse("project:/missing")));

    std::filesystem::remove_all(root);
}

TEST_CASE("DirectoryAssetSource missing parent directories permit fallback to later mounts")
{
    const auto root = std::filesystem::temp_directory_path() / "noveltea-directory-mount-fallback";
    std::filesystem::remove_all(root);
    std::filesystem::create_directories(root / "partial");
    std::filesystem::create_directories(root / "full" / "scripts");
    std::ofstream(root / "full" / "scripts" / "bootstrap.lua", std::ios::binary) << "return true";

    AssetManager manager;
    manager.mount_directory("system", root / "partial", false);
    manager.mount_directory("system", root / "full", false);
    auto opened = manager.open("system:/scripts/bootstrap.lua");
    REQUIRE(opened);
    auto data = manager.read_text("system:/scripts/bootstrap.lua");
    REQUIRE(data);
    CHECK(*data.value == "return true");
    const auto binary = manager.read_binary("system:/scripts/bootstrap.lua");
    REQUIRE(binary);
    CHECK(std::string(binary.value->bytes.begin(), binary.value->bytes.end()) == "return true");
    std::filesystem::remove_all(root);
}
