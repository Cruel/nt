#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/ui_runtime.hpp"
#include "ui/rmlui/rmlui_test_access.hpp"

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/Types.h>
#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <functional>
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

class RecordingRuntimeUiInputSink final : public noveltea::RuntimeUiInputSink {
public:
    [[nodiscard]] bool submit_gameplay_input(noveltea::core::RuntimeInputMessage) override
    {
        ++gameplay_inputs;
        return true;
    }

    [[nodiscard]] bool submit_shell_command(noveltea::core::RuntimeShellCommand) override
    {
        ++shell_commands;
        return true;
    }

    [[nodiscard]] bool dispatch_layout_event(noveltea::core::MountedLayoutOwner owner,
                                             const std::function<bool()>& dispatch) override
    {
        ++layout_events;
        last_layout_owner = owner;
        return dispatch && dispatch();
    }

    std::size_t gameplay_inputs = 0;
    std::size_t shell_commands = 0;
    std::size_t layout_events = 0;
    noveltea::core::MountedLayoutOwner last_layout_owner =
        noveltea::core::MountedLayoutOwner::Gameplay;
};

} // namespace

template<class T>
concept HasTypedRuntimeSessionBinding =
    requires(T& value) { value.bind_typed_runtime_session(nullptr); };

template<class T>
concept HasPresentationOperationHandlerBinding =
    requires(T& value) { value.bind_presentation_operation_handler(nullptr); };

template<class T>
concept HasRuntimePublicationApplication =
    requires(T& value, const noveltea::runtime::RuntimePublication& publication) {
        value.apply_runtime_publication(publication);
    };

template<class T>
concept HasRuntimeCapabilityBinding =
    requires(T& value, std::optional<noveltea::runtime::RuntimeCapabilitySet> capabilities) {
        value.bind_layout_event_capabilities(capabilities, capabilities);
    };

template<class T>
concept HasBorrowedDocumentAccess = requires(T& value) { value.document("runtime"); };

template<class T>
concept HasBorrowedElementAccess = requires(T& value) { value.element("runtime", "element"); };

template<class T>
concept HasGenericDataModelAccess = requires(T& value) {
    value.create_data_model("runtime");
    value.data_model("runtime");
};

TEST_CASE("RuntimeUI is a runtime input and view adapter without session or presentation brokerage")
{
    STATIC_REQUIRE_FALSE(HasTypedRuntimeSessionBinding<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasPresentationOperationHandlerBinding<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasRuntimePublicationApplication<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasRuntimeCapabilityBinding<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasBorrowedDocumentAccess<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasBorrowedElementAccess<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasGenericDataModelAccess<noveltea::RuntimeUI>);

    auto memory = std::make_shared<noveltea::assets::MemoryAssetSource>();
    noveltea::assets::AssetManager assets;
    assets.mount("project", memory);
    noveltea::script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    noveltea::RuntimeUI ui;
    REQUIRE(ui.initialize(&assets, nullptr, false, &scripts, nullptr, true));
    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);

    CHECK(ui.dispatch_typed_runtime_input(
        noveltea::core::RuntimeInputMessage{noveltea::core::StopRuntimeInput{}}));
    CHECK(input_sink.gameplay_inputs == 1);
}

TEST_CASE("RuntimeUI input sink rebinding preserves immutable gameplay UI values")
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

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "running";
    REQUIRE(ui.apply_gameplay_ui_values(values));
    ui.set_runtime_notification("before-rebind");

    noveltea::core::RuntimeShellViewState shell_view;
    shell_view.status = "shell-ready";
    ui.apply_runtime_shell_view(shell_view);

    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);
    ui.bind_input_sink(nullptr);
    ui.bind_input_sink(&input_sink);

    auto* shell_status =
        noveltea::ui::rmlui::RmlUiTestAccess::element(ui, "runtime_title", "nt-shell-status");
    REQUIRE(shell_status);
    shell_status->SetInnerRML("tampered");

    ui.set_runtime_notification("after-rebind");

    auto* runtime_mode =
        noveltea::ui::rmlui::RmlUiTestAccess::element(ui, "runtime_game", "rt_mode");
    auto* notification =
        noveltea::ui::rmlui::RmlUiTestAccess::element(ui, "runtime_game", "rt_notification");
    REQUIRE(runtime_mode);
    REQUIRE(notification);
    CHECK(runtime_mode->GetInnerRML() == "running");
    CHECK(notification->GetInnerRML() == "after-rebind");
    CHECK(shell_status->GetInnerRML() == "shell-ready");

    values.revision = 2;
    values.view.mode = "current";
    REQUIRE(ui.apply_gameplay_ui_values(values));
    values.revision = 1;
    values.view.mode = "stale";
    CHECK_FALSE(ui.apply_gameplay_ui_values(values));
    CHECK(runtime_mode->GetInnerRML() == "current");
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

    auto* action = noveltea::ui::rmlui::RmlUiTestAccess::element(ui, "gameplay", "action");
    REQUIRE(action);
    action->Focus();
    REQUIRE(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 1);

    REQUIRE(ui.apply_layout_policy("gameplay", gameplay, 2));
    action = noveltea::ui::rmlui::RmlUiTestAccess::element(ui, "gameplay", "action");
    REQUIRE(action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 2);

    REQUIRE(ui.reload_documents_and_styles());
    action = noveltea::ui::rmlui::RmlUiTestAccess::element(ui, "gameplay", "action");
    REQUIRE(action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 3);

    auto* menu_document = noveltea::ui::rmlui::RmlUiTestAccess::document(ui, "menu");
    REQUIRE(menu_document);
    CHECK_FALSE(menu_document->IsVisible());
    CHECK(ui.remove_event_listener(listener));

    ui.shutdown();
    ui.shutdown();
    CHECK_FALSE(ui.is_initialized());
    REQUIRE(ui.initialize(&assets, nullptr, false, &scripts, nullptr, true));
    CHECK(ui.is_initialized());
}

TEST_CASE("RuntimeUI document registry restores virtual path memory and built-in documents")
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
    ui.set_preview_virtual_file("project:/registry/virtual.rml", kDocument);
    REQUIRE(ui.load_document("virtual", "project:/registry/virtual.rml", true));
    REQUIRE(ui.load_document_from_memory("custom", kDocument, "preview://custom.rml", true));
    REQUIRE(ui.load_title_document());

    REQUIRE(ui.hide_document("virtual"));
    int activations = 0;
    const auto listener =
        ui.add_event_listener("custom", "action", "click", [&activations]() { ++activations; });
    REQUIRE(listener != 0);
    auto* action = noveltea::ui::rmlui::RmlUiTestAccess::element(ui, "custom", "action");
    REQUIRE(action);
    action->Focus();

    CHECK_FALSE(ui.load_document("custom", "project:/registry/missing.rml", true));
    CHECK(noveltea::ui::rmlui::RmlUiTestAccess::element(ui, "custom", "action") == action);

    REQUIRE(ui.reload_documents_and_styles());
    CHECK(ui.has_document("virtual"));
    CHECK(ui.has_document("custom"));
    CHECK(ui.has_document("runtime_title"));

    auto* virtual_document = noveltea::ui::rmlui::RmlUiTestAccess::document(ui, "virtual");
    REQUIRE(virtual_document);
    CHECK_FALSE(virtual_document->IsVisible());

    action = noveltea::ui::rmlui::RmlUiTestAccess::element(ui, "custom", "action");
    REQUIRE(action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 1);
    CHECK(ui.remove_event_listener(listener));

    ui.clear_preview_virtual_files();
}
