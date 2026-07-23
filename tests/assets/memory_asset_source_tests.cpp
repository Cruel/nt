#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_source.hpp"

#include <cstdio>

using namespace noveltea::assets;

TEST_CASE("MemoryAssetSource reads and opens independent cursors")
{
    MemoryAssetSource source;
    AssetBytes original{'a', 'b', 'c'};
    source.add("project:/data.bin", std::move(original));

    auto blob = source.read_binary(*AssetPath::parse("project:/data.bin"));
    REQUIRE(blob);
    CHECK(blob.value->bytes == AssetBytes{'a', 'b', 'c'});

    auto a = source.open(*AssetPath::parse("project:/data.bin"));
    auto b = source.open(*AssetPath::parse("project:/data.bin"));
    REQUIRE(a);
    REQUIRE(b);
    char ch = 0;
    const auto read = (*a.value)->read(&ch, 1);
    REQUIRE(read);
    CHECK(*read.value == 1);
    CHECK(ch == 'a');
    CHECK(*(*b.value)->tell().value == 0);
    CHECK((*a.value)->seek(-1, AssetSeekOrigin::End));
    CHECK(*(*a.value)->tell().value == 2);
}

TEST_CASE("MemoryAssetSource supports empty and missing assets")
{
    MemoryAssetSource source;
    source.add("project:/empty", {});
    auto empty = source.read_binary(*AssetPath::parse("project:/empty"));
    REQUIRE(empty);
    CHECK(empty.value->bytes.empty());
    CHECK_FALSE(source.open(*AssetPath::parse("project:/missing")));
}
