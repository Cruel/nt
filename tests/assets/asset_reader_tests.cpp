#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_source.hpp"

#include <cstdio>

using namespace noveltea::assets;

TEST_CASE("AssetReader seek, tell, and size use optional values")
{
    MemoryAssetSource source;
    source.add("project:/data", {'a', 'b', 'c'});
    auto opened = source.open(*AssetPath::parse("project:/data"));
    REQUIRE(opened);
    auto& reader = *opened.value.value();
    CHECK(reader.size().value() == 3);
    CHECK(reader.tell().value() == 0);
    CHECK(reader.seek(1, SEEK_SET));
    CHECK(reader.tell().value() == 1);
    CHECK(reader.seek(1, SEEK_CUR));
    CHECK(reader.tell().value() == 2);
    CHECK(reader.seek(-1, SEEK_END));
    CHECK(reader.tell().value() == 2);
    CHECK_FALSE(reader.seek(-10, SEEK_SET));
}
