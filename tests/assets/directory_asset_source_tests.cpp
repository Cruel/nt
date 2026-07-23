#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_source.hpp"

#include <filesystem>
#include <fstream>

using namespace noveltea::assets;

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
