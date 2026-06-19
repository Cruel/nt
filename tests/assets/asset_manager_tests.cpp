#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/project_document.hpp"

using namespace noveltea::assets;
using noveltea::core::ProjectDocument;
using noveltea::core::legacy::ProjectPackage;

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
    CHECK(blob.value->bytes == AssetBytes{'1'});
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

static std::vector<std::byte> package_bytes(std::string_view value)
{
    std::vector<std::byte> bytes;
    bytes.reserve(value.size());
    for (const char ch : value) {
        bytes.push_back(static_cast<std::byte>(static_cast<unsigned char>(ch)));
    }
    return bytes;
}

TEST_CASE("AssetManager mounts legacy package entries as project assets")
{
    ProjectPackage package;
    package.imported_project.document = ProjectDocument::new_project();
    package.game_json = package.imported_project.document.root().dump();
    package.image = package_bytes("cover");
    package.fonts.emplace("caption.ttf", package_bytes("font"));
    package.textures.emplace("room.png", package_bytes("texture"));
    package.assets.emplace("scripts/bootstrap.lua", package_bytes("script"));
    package.assets.emplace("text/intro.txt", package_bytes("intro"));
    package.assets.emplace("shaders/bgfx/glsl-120/custom.fs.bin", package_bytes("shader"));

    AssetManager manager;
    manager.mount_legacy_package("project", package);

    auto game = manager.read_text("project:/game");
    REQUIRE(game);
    CHECK(*game.value == package.game_json);

    auto image = manager.read_binary("project:/image");
    REQUIRE(image);
    CHECK(image.value->bytes == AssetBytes{'c', 'o', 'v', 'e', 'r'});

    auto font = manager.read_text("project:/fonts/caption.ttf");
    REQUIRE(font);
    CHECK(*font.value == "font");

    auto texture = manager.read_text("project:/textures/room.png");
    REQUIRE(texture);
    CHECK(*texture.value == "texture");

    auto script = manager.read_text("project:/scripts/bootstrap.lua");
    REQUIRE(script);
    CHECK(*script.value == "script");

    auto text = manager.read_text("project:/text/intro.txt");
    REQUIRE(text);
    CHECK(*text.value == "intro");

    auto shader = manager.read_text("project:/shaders/bgfx/glsl-120/custom.fs.bin");
    REQUIRE(shader);
    CHECK(*shader.value == "shader");
}
