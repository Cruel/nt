#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_source.hpp"

#include <cstdio>

using namespace noveltea::assets;

TEST_CASE("AssetReader seek, tell, and size use typed results")
{
    MemoryAssetSource source;
    source.add("project:/data", {'a', 'b', 'c'});
    auto opened = source.open(*AssetPath::parse("project:/data"));
    REQUIRE(opened);
    auto& reader = *opened.value.value();
    REQUIRE(reader.size());
    CHECK(*reader.size().value == 3);
    REQUIRE(reader.tell());
    CHECK(*reader.tell().value == 0);
    CHECK(reader.seek(1, AssetSeekOrigin::Begin));
    CHECK(*reader.tell().value == 1);
    CHECK(reader.seek(1, AssetSeekOrigin::Current));
    CHECK(*reader.tell().value == 2);
    CHECK(reader.seek(-1, AssetSeekOrigin::End));
    CHECK(*reader.tell().value == 2);
    const auto failed = reader.seek(-10, AssetSeekOrigin::Begin);
    CHECK_FALSE(failed);
    CHECK(failed.error.code == asset_source_error_code::seek_failed);
}
