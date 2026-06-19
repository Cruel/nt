#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "ui_runtime_rmlui_file_interface.hpp"

#include <cstdio>
#include <cstring>

using namespace noveltea;
using namespace noveltea::assets;

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
