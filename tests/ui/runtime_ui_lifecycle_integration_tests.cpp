#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/ui_runtime.hpp"

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/Types.h>
#include <catch2/catch_test_macros.hpp>

#include <functional>
#include <filesystem>
#include <memory>
#include <utility>

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

constexpr const char* kShellBindingDocument = R"(
<rml>
  <head></head>
  <body>
    <span id="nt-shell-status"></span>
  </body>
</rml>
)";

} // namespace

template<class T>
concept HasTypedRuntimeSessionBinding =
    requires(T& value) { value.bind_typed_runtime_session(nullptr); };

template<class T>
concept HasPresentationOperationHandlerBinding =
    requires(T& value) { value.bind_presentation_operation_handler(nullptr); };

TEST_CASE("RuntimeUI is a runtime input and view adapter without session or presentation brokerage")
{
    STATIC_REQUIRE_FALSE(HasTypedRuntimeSessionBinding<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasPresentationOperationHandlerBinding<noveltea::RuntimeUI>);

    auto memory = std::make_shared<noveltea::assets::MemoryAssetSource>();
    noveltea::assets::AssetManager assets;
    assets.mount("project", memory);
    noveltea::script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    noveltea::RuntimeUI ui;
    REQUIRE(ui.initialize(&assets, nullptr, false, &scripts, nullptr, true));
    std::size_t dispatch_count = 0;
    ui.bind_runtime_input_handler([&dispatch_count](const noveltea::core::RuntimeInputMessage&) {
        ++dispatch_count;
        return true;
    });

    CHECK(ui.dispatch_typed_runtime_input(
        noveltea::core::RuntimeInputMessage{noveltea::core::StopRuntimeInput{}}));
    CHECK(dispatch_count == 1);
}

TEST_CASE("RuntimeUI generation handler rebinding preserves independently applied publications")
{
    auto memory = std::make_shared<noveltea::assets::MemoryAssetSource>();
    noveltea::assets::AssetManager assets;
    assets.mount("project", memory);
    assets.mount_directory(
        "system", std::filesystem::path(NOVELTEA_SOURCE_DIR) / "engine/assets/system", false);
    noveltea::script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    noveltea::RuntimeUI ui;
    REQUIRE(ui.initialize(&assets, nullptr, false, &scripts, nullptr, true));
    REQUIRE(ui.load_runtime_document());
    REQUIRE(ui.load_document_from_memory("runtime_title", kShellBindingDocument,
                                         "preview://shell-binding.rml", true));

    const auto revision = noveltea::runtime::RuntimePublicationRevision::from_number(1);
    REQUIRE(revision.has_value());
    noveltea::runtime::RuntimePublication publication{
        .revision = *revision,
        .gameplay_ui = {},
        .presentation = {},
        .observations = {},
    };
    publication.gameplay_ui.mode = "running";
    ui.apply_runtime_publication(publication);
    ui.deliver_runtime_events({noveltea::runtime::NotificationEvent{"before-rebind"}});

    noveltea::core::RuntimeShellViewState shell_view;
    shell_view.status = "shell-ready";
    ui.apply_runtime_shell_view(shell_view);

    ui.bind_runtime_input_handler([](const noveltea::core::RuntimeInputMessage&) { return true; });
    ui.bind_runtime_shell_handler([](const noveltea::core::RuntimeShellCommand&) { return true; });

    auto* shell_status = static_cast<Rml::Element*>(ui.element("runtime_title", "nt-shell-status"));
    REQUIRE(shell_status);
    shell_status->SetInnerRML("tampered");

    ui.deliver_runtime_events({noveltea::runtime::NotificationEvent{"after-rebind"}});

    auto* runtime_mode = static_cast<Rml::Element*>(ui.element("runtime_game", "rt_mode"));
    auto* notification = static_cast<Rml::Element*>(ui.element("runtime_game", "rt_notification"));
    REQUIRE(runtime_mode);
    REQUIRE(notification);
    CHECK(runtime_mode->GetInnerRML() == "running");
    CHECK(notification->GetInnerRML() == "after-rebind");
    CHECK(shell_status->GetInnerRML() == "shell-ready");
}

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

    ui.shutdown();
    ui.shutdown();
    CHECK_FALSE(ui.is_initialized());
    REQUIRE(ui.initialize(&assets, nullptr, false, &scripts, nullptr, true));
    CHECK(ui.is_initialized());
}
