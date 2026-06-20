#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "ui/rmlui/rmlui_template_resolver.hpp"

#include <cstring>

using namespace noveltea;
using namespace noveltea::assets;
using namespace noveltea::ui::rmlui;

TEST_CASE("RuntimeUiTemplateResolver finds project override first")
{
    auto project_source = std::make_shared<MemoryAssetSource>();
    project_source->add("ui/runtime/runtime_game.rml", {'p', 'r', 'o', 'j'});
    auto system_source = std::make_shared<MemoryAssetSource>();
    system_source->add("ui/runtime/runtime_game.rml", {'s', 'y', 's'});

    AssetManager manager;
    manager.mount("project", project_source);
    manager.mount("system", system_source);

    RuntimeUiTemplateResolver resolver(manager);
    CHECK(resolver.resolve_runtime_document() == "project:/ui/runtime/runtime_game.rml");
}

TEST_CASE("RuntimeUiTemplateResolver falls back to system when project missing")
{
    auto system_source = std::make_shared<MemoryAssetSource>();
    system_source->add("ui/runtime/runtime_game.rml", {'s', 'y', 's'});

    AssetManager manager;
    manager.mount("project", std::make_shared<MemoryAssetSource>());
    manager.mount("system", system_source);

    RuntimeUiTemplateResolver resolver(manager);
    CHECK(resolver.resolve_runtime_document() == "system:/ui/runtime/runtime_game.rml");
}

TEST_CASE("RuntimeUiTemplateResolver falls back to legacy compat path")
{
    auto legacy_source = std::make_shared<MemoryAssetSource>();
    legacy_source->add("rmlui/runtime_game.rml", {'l', 'e', 'g'});

    AssetManager manager;
    manager.mount("project", legacy_source);
    manager.mount("system", std::make_shared<MemoryAssetSource>());

    RuntimeUiTemplateResolver resolver(manager);
    CHECK(resolver.resolve_runtime_document() == "project:/rmlui/runtime_game.rml");
}

TEST_CASE("RuntimeUiTemplateResolver returns empty when nothing found")
{
    AssetManager manager;
    manager.mount("project", std::make_shared<MemoryAssetSource>());
    manager.mount("system", std::make_shared<MemoryAssetSource>());

    RuntimeUiTemplateResolver resolver(manager);
    CHECK(resolver.resolve_runtime_document().empty());
}

TEST_CASE("RuntimeUiTemplateResolver uses theme when present")
{
    auto theme_source = std::make_shared<MemoryAssetSource>();
    theme_source->add("ui/runtime/runtime_game.rml", {'t', 'h', 'm'});
    auto system_source = std::make_shared<MemoryAssetSource>();
    system_source->add("ui/runtime/runtime_game.rml", {'s', 'y', 's'});

    AssetManager manager;
    manager.mount("project", std::make_shared<MemoryAssetSource>());
    manager.mount("theme", theme_source);
    manager.mount("system", system_source);

    RuntimeUiTemplateResolver resolver(manager);
    CHECK(resolver.resolve_runtime_document() == "theme:/ui/runtime/runtime_game.rml");
}
