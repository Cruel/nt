#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/ui_runtime.hpp"

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/Types.h>
#include <catch2/catch_test_macros.hpp>

#include <memory>

namespace {

constexpr const char* kDocument = R"(
<rml>
  <head>
    <style>
      body { width: 640px; height: 360px; }
      button { width: 160px; height: 48px; }
    </style>
  </head>
  <body>
    <button id="action" tabindex="0">Action</button>
  </body>
</rml>
)";

} // namespace

TEST_CASE("RuntimeUI preserves lifecycle document state across migration and reload")
{
    auto memory = std::make_shared<noveltea::assets::MemoryAssetSource>();
    noveltea::assets::AssetManager assets;
    assets.mount("project", memory);

    noveltea::script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    noveltea::RuntimeUI ui;
    REQUIRE(ui.initialize(&assets, nullptr, false, &scripts, nullptr, true));
    REQUIRE(ui.load_document_from_memory("gameplay", kDocument, "preview://gameplay.rml", true));
    REQUIRE(ui.load_document_from_memory("menu", kDocument, "preview://menu.rml", true));

    noveltea::core::MountedLayoutPolicy gameplay;
    gameplay.plane = noveltea::core::PresentationPlane::GameUi;
    gameplay.clock = noveltea::core::LayoutClockDomain::Gameplay;
    gameplay.input = noveltea::core::LayoutInputMode::Normal;
    REQUIRE(ui.apply_layout_policy("gameplay", gameplay, 0));

    auto menu = gameplay;
    menu.clock = noveltea::core::LayoutClockDomain::UnscaledPresentation;
    menu.input = noveltea::core::LayoutInputMode::BlockGameplay;
    REQUIRE(ui.apply_layout_policy("menu", menu, 1));
    REQUIRE(ui.apply_layout_order({"gameplay", "menu"}));
    REQUIRE(ui.hide_document("menu"));

    int activations = 0;
    const auto listener =
        ui.add_event_listener("gameplay", "action", "click", [&activations]() { ++activations; });
    REQUIRE(listener != 0);

    auto* action = static_cast<Rml::Element*>(ui.element("gameplay", "action"));
    REQUIRE(action);
    action->Focus();
    REQUIRE(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 1);

    REQUIRE(ui.apply_layout_policy("gameplay", gameplay, 2));
    action = static_cast<Rml::Element*>(ui.element("gameplay", "action"));
    REQUIRE(action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 2);

    REQUIRE(ui.reload_documents_and_styles());
    action = static_cast<Rml::Element*>(ui.element("gameplay", "action"));
    REQUIRE(action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 3);

    auto* menu_document = static_cast<Rml::ElementDocument*>(ui.document("menu"));
    REQUIRE(menu_document);
    CHECK_FALSE(menu_document->IsVisible());
    CHECK(ui.remove_event_listener(listener));
}
