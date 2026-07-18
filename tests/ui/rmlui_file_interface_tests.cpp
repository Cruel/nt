#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "ui/rmlui/rmlui_file_interface.hpp"

#include <cstdio>
#include <cstring>

using namespace noveltea;
using namespace noveltea::assets;
using namespace noveltea::ui::rmlui;

TEST_CASE("AssetRmlFileInterface opens, reads, seeks, tells, and closes")
{
    auto source = std::make_shared<MemoryAssetSource>();
    source->add("project:/rmlui/demo.rml", {'d', 'e', 'm', 'o'});
    source->add("project:/rmlui/nested/style.rcss", {'c', 's', 's'});
    source->add("project:/explicit.bin", {'x'});

    AssetManager manager;
    manager.mount("project", source);
    AssetRmlFileInterface files(manager);

    auto handle = files.Open("demo.rml");
    REQUIRE(handle != 0);
    char buffer[5]{};
    CHECK(files.Read(buffer, 2, handle) == 2);
    CHECK(std::string(buffer, 2) == "de");
    CHECK(files.Tell(handle) == 2);
    CHECK(files.Seek(handle, 1, SEEK_SET));
    CHECK(files.Read(buffer, 3, handle) == 3);
    CHECK(std::string(buffer, 3) == "emo");
    files.Close(handle);

    auto nested = files.Open("nested/style.rcss");
    REQUIRE(nested != 0);
    files.Close(nested);

    auto explicit_path = files.Open("project:/explicit.bin");
    REQUIRE(explicit_path != 0);
    files.Close(explicit_path);

    CHECK(files.Open("missing.rml") == 0);
}

TEST_CASE("AssetRmlFileInterface safely rejects invalid handles and buffers")
{
    AssetManager manager;
    AssetRmlFileInterface files(manager);

    char buffer[4]{};
    CHECK(files.Read(buffer, sizeof(buffer), 0) == 0);
    CHECK_FALSE(files.Seek(0, 0, SEEK_SET));
    CHECK(files.Tell(0) == 0);
    files.Close(0);

    auto source = std::make_shared<MemoryAssetSource>();
    source->add("project:/rmlui/demo.rml", {'d'});
    manager.mount("project", source);
    const auto handle = files.Open("demo.rml");
    REQUIRE(handle != 0);
    CHECK(files.Read(nullptr, 1, handle) == 0);
    CHECK(files.Read(buffer, 0, handle) == 0);
    files.Close(handle);
}

TEST_CASE("RmlUi logical asset path normalization is narrow")
{
    auto source = std::make_shared<MemoryAssetSource>();
    source->add("project:/rmlui/lua_demo.lua", {'l', 'u', 'a'});
    AssetManager manager;
    manager.mount("project", source);
    manager.mount("system", source);

    CHECK(ui::rmlui::resolve_asset_path(manager, "project|/rmlui/lua_demo.lua") ==
          "project:/rmlui/lua_demo.lua");
    CHECK(ui::rmlui::resolve_asset_path(manager, "system|/scripts/bootstrap.lua") ==
          "system:/scripts/bootstrap.lua");
    CHECK(ui::rmlui::resolve_asset_path(manager, "project:/rmlui/lua_demo.lua") ==
          "project:/rmlui/lua_demo.lua");
    CHECK(ui::rmlui::resolve_asset_path(manager, "lua_demo.lua") == "project:/rmlui/lua_demo.lua");
    CHECK(ui::rmlui::resolve_asset_path(manager, "nested/project|/lua_demo.lua") ==
          "project:/nested/project|/lua_demo.lua");
    CHECK(ui::rmlui::resolve_asset_path(manager, "|/lua_demo.lua") == "project:/|/lua_demo.lua");
}

TEST_CASE("Encoded namespace paths resolve stylesheets correctly")
{
    auto project_source = std::make_shared<MemoryAssetSource>();
    project_source->add("project:/rmlui/runtime_game.rcss", {'r', 'c', 's', 's'});
    auto system_source = std::make_shared<MemoryAssetSource>();
    system_source->add("system:/ui/runtime/runtime_game.rcss", {'r', 'c', 's', 's'});
    AssetManager manager;
    manager.mount("project", project_source);
    manager.mount("system", system_source);

    CHECK(ui::rmlui::resolve_asset_path(manager, "system|/ui/runtime/runtime_game.rcss") ==
          "system:/ui/runtime/runtime_game.rcss");
    CHECK(ui::rmlui::resolve_asset_path(manager, "project|/rmlui/runtime_game.rcss") ==
          "project:/rmlui/runtime_game.rcss");
}

TEST_CASE("Encoded namespace paths fall through for unknown namespaces")
{
    auto source = std::make_shared<MemoryAssetSource>();
    source->add("project:/rmlui/foo.rml", {'f'});
    AssetManager manager;
    manager.mount("project", source);

    // Unknown namespace "unknown" with no matching mount falls through to project:/ path.
    CHECK(ui::rmlui::resolve_asset_path(manager, "unknown|/rmlui/foo.rml") ==
          "project:/unknown|/rmlui/foo.rml");
}
