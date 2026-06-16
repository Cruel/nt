#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_path.hpp"

using noveltea::assets::AssetPath;

TEST_CASE("AssetPath parses namespaces and defaults")
{
    auto explicit_path = AssetPath::parse("system:/shaders/bgfx/glsl-120/triangle.vs.bin");
    REQUIRE(explicit_path);
    CHECK(explicit_path->namespace_name() == "system");
    CHECK(explicit_path->relative_path() == "shaders/bgfx/glsl-120/triangle.vs.bin");
    CHECK(explicit_path->logical_path() == "system:/shaders/bgfx/glsl-120/triangle.vs.bin");

    auto defaulted = AssetPath::parse_with_default_namespace("rmlui/demo.rml");
    REQUIRE(defaulted);
    CHECK(defaulted->namespace_name() == "project");
    CHECK(defaulted->logical_path() == "project:/rmlui/demo.rml");
}

TEST_CASE("AssetPath rejects malformed paths")
{
    for (const char* path : {
        "/absolute",
        "project:/../escape",
        "project:/./same",
        "project:/a//b",
        "project:/a\\b",
        "bad:path",
        "project:/bad:component",
        "project:/",
        "Project:/case",
    }) {
        CHECK_FALSE(AssetPath::parse(path).has_value());
    }
}
