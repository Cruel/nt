#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"

using namespace noveltea::assets;

static std::shared_ptr<MemoryAssetSource> memory_source(std::string_view path, AssetBytes bytes)
{
    auto source = std::make_shared<MemoryAssetSource>();
    source->add(path, std::move(bytes));
    return source;
}

TEST_CASE("AssetManager reports missing mounts and missing assets")
{
    AssetManager manager;
    CHECK_FALSE(manager.read_binary("system:/missing"));
    manager.mount("project", memory_source("project:/exists", {'x'}));
    auto missing = manager.read_binary("missing");
    CHECK_FALSE(missing);
    CHECK(missing.error.find("searched:") != std::string::npos);
}

TEST_CASE("AssetManager uses first mounted source that contains the asset")
{
    AssetManager manager;
    manager.mount("project", memory_source("project:/same", {'1'}));
    manager.mount("project", memory_source("project:/same", {'2'}));
    auto blob = manager.read_binary("same");
    REQUIRE(blob);
    CHECK(blob.value->bytes == AssetBytes {'1'});
}

TEST_CASE("AssetManager reads binary, text, and streams without native paths")
{
    AssetManager manager;
    manager.mount("project", memory_source("project:/hello.txt", {'h', 'i'}));
    auto text = manager.read_text("hello.txt");
    REQUIRE(text);
    CHECK(*text.value == "hi");
    auto opened = manager.open("hello.txt");
    REQUIRE(opened);
    CHECK((*opened.value)->size().value() == 2);
}
