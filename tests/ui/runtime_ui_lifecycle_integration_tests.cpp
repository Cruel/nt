#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/ui_runtime.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/Types.h>
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <concepts>
#include <filesystem>
#include <functional>
#include <memory>
#include <utility>

namespace {

using RuntimeUiFacadeAccess = noveltea::ui::rmlui::RuntimeUiFacadeAccess;

constexpr const char* kDocument = R"(
<rml>
  <head>
    <style>
      body { width: 640px; height: 360px; }
      button { width: 160px; height: 48px; }
    </style>
  </head>
  <body style="width: 640px; height: 360px;">
    <button id="action" tabindex="0" style="display: block; width: 160px; height: 48px;">
      Action
    </button>
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

constexpr const char* kReplacementDocument = R"(
<rml>
  <head>
    <style>
      body { width: 640px; height: 360px; }
      button { width: 180px; height: 52px; }
    </style>
  </head>
  <body style="width: 640px; height: 360px;">
    <button id="action" tabindex="0" style="display: block; width: 180px; height: 52px;">
      Replacement action
    </button>
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

template<class T>
concept HasPlaybackClick = requires { &T::playback_click; };

template<class T>
concept HasGenericDocumentLoading = requires(T& value) {
    value.load_document("document", "project:/document.rml", true);
    value.load_document_from_memory("document", "<rml></rml>", "preview://document.rml", true);
};

template<class T>
concept HasPreviewVirtualFiles = requires(T& value) {
    value.set_preview_virtual_file("preview://document.rml", "<rml></rml>");
    value.clear_preview_virtual_files();
};

template<class T>
concept HasConvenienceDocuments = requires(T& value) {
    value.load_title_document();
    value.load_runtime_document();
    value.load_pause_menu_document();
};

template<class T>
concept HasDirectRuntimeInputDispatch =
    requires(T& value, const noveltea::core::RuntimeInputMessage& input) {
        value.dispatch_typed_runtime_input(input);
    };

template<class T>
concept HasGenericEventListeners = requires(T& value, std::function<void()> callback) {
    value.add_event_listener("document", "element", "click", callback);
    value.remove_event_listener(1);
};

template<class T>
concept HasToolingConfiguration = requires(T& value, std::function<void()> callback) {
    value.set_rmlui_base_direct_compatibility(true);
    value.set_density(1.0f);
    value.bind_game_started_handler(callback);
};

template<class T>
concept HasBackendReset = requires(T& value) {
    { value.reset_backend() } -> std::same_as<bool>;
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
    STATIC_REQUIRE_FALSE(HasPlaybackClick<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasGenericDocumentLoading<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasPreviewVirtualFiles<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasConvenienceDocuments<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasDirectRuntimeInputDispatch<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasGenericEventListeners<noveltea::RuntimeUI>);
    STATIC_REQUIRE_FALSE(HasToolingConfiguration<noveltea::RuntimeUI>);
    STATIC_REQUIRE(HasBackendReset<noveltea::RuntimeUI>);

    auto memory = std::make_shared<noveltea::assets::MemoryAssetSource>();
    noveltea::assets::AssetManager assets;
    assets.mount("project", memory);
    noveltea::script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    noveltea::RuntimeUI ui;
    REQUIRE(ui.initialize(&assets, nullptr, &scripts, nullptr, true));
    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);

    CHECK(RuntimeUiFacadeAccess::dispatch_typed_runtime_input(
        ui, noveltea::core::RuntimeInputMessage{noveltea::core::StopRuntimeInput{}}));
    CHECK(input_sink.gameplay_inputs == 1);
}

TEST_CASE("RuntimeUI selector playback and native inspection use the internal playback driver")
{
    auto memory = std::make_shared<noveltea::assets::MemoryAssetSource>();
    noveltea::assets::AssetManager assets;
    assets.mount("project", memory);
    noveltea::script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    noveltea::RuntimeUI ui;
    CHECK(noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui) == nullptr);
    REQUIRE(ui.initialize(&assets, nullptr, &scripts, nullptr, true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(ui, "gameplay", kDocument,
                                                             "preview://playback.rml", true));

    int activations = 0;
    const auto listener = RuntimeUiFacadeAccess::add_event_listener(
        ui, "gameplay", "action", "click", [&activations]() { ++activations; });
    REQUIRE(listener != 0);
    ui.begin_frame({});

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    REQUIRE(driver->document("gameplay"));
    REQUIRE(driver->element("gameplay", "action"));

    const auto rejected = driver->click({.document_id = "gameplay", .selector = "#action"});
    CHECK(rejected.status ==
          noveltea::ui::rmlui::RuntimeUiPlaybackClickStatus::HostDispatchRejected);
    CHECK_FALSE(rejected.dispatched);
    CHECK(activations == 0);

    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);
    const auto click = driver->click({.document_id = "gameplay", .selector = "#action"});
    CHECK(click.status == noveltea::ui::rmlui::RuntimeUiPlaybackClickStatus::Dispatched);
    CHECK(click.dispatched);
    CHECK(click.target_id == "action");
    CHECK(click.target_tag == "button");
    CHECK(click.width > 0.0f);
    CHECK(click.height > 0.0f);
    CHECK(activations == 1);
    CHECK(input_sink.layout_events == 1);
    CHECK(input_sink.last_layout_owner == noveltea::core::MountedLayoutOwner::Gameplay);
    CHECK(std::string(noveltea::ui::rmlui::to_string(click.status)) == "dispatched");

    REQUIRE(ui.hide_document("gameplay"));
    const auto hidden =
        driver->click({.document_id = "gameplay", .selector = "button[id='action']"});
    CHECK(hidden.status == noveltea::ui::rmlui::RuntimeUiPlaybackClickStatus::DocumentHidden);
    CHECK_FALSE(hidden.dispatched);

    ui.shutdown();
    CHECK(noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui) == nullptr);
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
    REQUIRE(ui.initialize(&assets, nullptr, &scripts, nullptr, true));
    REQUIRE(RuntimeUiFacadeAccess::load_runtime_document(ui));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "runtime_title", kShellBindingDocument, "preview://shell-binding.rml", true));

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

    auto* playback_driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(playback_driver);
    auto* shell_status = playback_driver->element("runtime_title", "nt-shell-status");
    REQUIRE(shell_status);
    shell_status->SetInnerRML("tampered");

    ui.set_runtime_notification("after-rebind");

    auto* runtime_mode = playback_driver->element("runtime_game", "rt_mode");
    auto* notification = playback_driver->element("runtime_game", "rt_notification");
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

TEST_CASE("RuntimeUI delegates ActiveText playback snapshot and completion to its presenter")
{
    auto memory = std::make_shared<noveltea::assets::MemoryAssetSource>();
    noveltea::assets::AssetManager assets;
    assets.mount("project", memory);
    assets.mount_directory(
        "system", std::filesystem::path(NOVELTEA_SOURCE_DIR) / "engine/assets/system", false);
    noveltea::script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    noveltea::RuntimeUI ui;
    REQUIRE(ui.initialize(&assets, nullptr, &scripts, nullptr, true));
    REQUIRE(RuntimeUiFacadeAccess::load_runtime_document(ui));

    const auto room = noveltea::core::RoomId::create("room");
    REQUIRE(room);
    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "room";
    values.view.room =
        noveltea::core::RoomView{.room = *room.value_if(),
                                 .description = "Presenter-owned ActiveText",
                                 .description_markup = noveltea::core::TextMarkup::ActiveText};
    REQUIRE(ui.apply_gameplay_ui_values(values));

    ui.begin_frame(noveltea::core::RuntimeClockUpdate{.gameplay_delta = std::chrono::seconds(2),
                                                      .gameplay_time = std::chrono::seconds(2)});
    CHECK(ui.active_text_direct_render_enabled());
    CHECK(ui.active_text_render_snapshot().visible_text == "Presenter-owned ActiveText");
    CHECK(ui.active_text_presentation_phase() ==
          noveltea::core::ActiveTextPresentationPhase::Stable);

    values.revision = 2;
    values.view = {};
    REQUIRE(ui.apply_gameplay_ui_values(values));
    ui.begin_frame(
        noveltea::core::RuntimeClockUpdate{.gameplay_delta = std::chrono::milliseconds(10),
                                           .gameplay_time = std::chrono::milliseconds(2010)});
    CHECK(ui.active_text_presentation_phase() == noveltea::core::ActiveTextPresentationPhase::Fade);
}

TEST_CASE("RuntimeUI preserves lifecycle document state across migration and reload")
{
    auto memory = std::make_shared<noveltea::assets::MemoryAssetSource>();
    noveltea::assets::AssetManager assets;
    assets.mount("project", memory);

    noveltea::script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    noveltea::RuntimeUI ui;
    REQUIRE(ui.initialize(&assets, nullptr, &scripts, nullptr, true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(ui, "gameplay", kDocument,
                                                             "preview://gameplay.rml", true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(ui, "menu", kDocument,
                                                             "preview://menu.rml", true));

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
    const auto listener = RuntimeUiFacadeAccess::add_event_listener(
        ui, "gameplay", "action", "click", [&activations]() { ++activations; });
    REQUIRE(listener != 0);

    auto* playback_driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(playback_driver);
    auto* action = playback_driver->element("gameplay", "action");
    REQUIRE(action);
    action->Focus();
    REQUIRE(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 1);

    REQUIRE(ui.apply_layout_policy("gameplay", gameplay, 2));
    action = playback_driver->element("gameplay", "action");
    REQUIRE(action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 2);

    REQUIRE(ui.reload_documents_and_styles());
    action = playback_driver->element("gameplay", "action");
    REQUIRE(action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 3);

    REQUIRE(ui.reset_backend());
    action = playback_driver->element("gameplay", "action");
    REQUIRE(action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 4);

    auto* menu_document = playback_driver->document("menu");
    REQUIRE(menu_document);
    CHECK_FALSE(menu_document->IsVisible());
    CHECK(RuntimeUiFacadeAccess::remove_event_listener(ui, listener));

    ui.shutdown();
    ui.shutdown();
    CHECK_FALSE(ui.is_initialized());
    REQUIRE(ui.initialize(&assets, nullptr, &scripts, nullptr, true));
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
    REQUIRE(ui.initialize(&assets, nullptr, &scripts, nullptr, true));
    RuntimeUiFacadeAccess::set_preview_virtual_file(ui, "project:/registry/virtual.rml", kDocument);
    REQUIRE(
        RuntimeUiFacadeAccess::load_document(ui, "virtual", "project:/registry/virtual.rml", true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(ui, "custom", kDocument,
                                                             "preview://custom.rml", true));
    REQUIRE(RuntimeUiFacadeAccess::load_title_document(ui));

    REQUIRE(ui.hide_document("virtual"));
    int activations = 0;
    const auto listener = RuntimeUiFacadeAccess::add_event_listener(
        ui, "custom", "action", "click", [&activations]() { ++activations; });
    REQUIRE(listener != 0);
    auto* playback_driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(playback_driver);
    auto* action = playback_driver->element("custom", "action");
    REQUIRE(action);
    action->Focus();

    CHECK_FALSE(
        RuntimeUiFacadeAccess::load_document(ui, "custom", "project:/registry/missing.rml", true));
    CHECK(playback_driver->element("custom", "action") == action);

    auto* original_action = action;
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "custom", kReplacementDocument, "preview://custom-replacement.rml", true));
    action = playback_driver->element("custom", "action");
    REQUIRE(action);
    CHECK(action != original_action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 1);

    REQUIRE(ui.reload_documents_and_styles());
    CHECK(ui.has_document("virtual"));
    CHECK(ui.has_document("custom"));
    CHECK(ui.has_document("runtime_title"));

    auto* virtual_document = playback_driver->document("virtual");
    REQUIRE(virtual_document);
    CHECK_FALSE(virtual_document->IsVisible());

    action = playback_driver->element("custom", "action");
    REQUIRE(action);
    CHECK(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 2);
    CHECK(RuntimeUiFacadeAccess::remove_event_listener(ui, listener));

    RuntimeUiFacadeAccess::clear_preview_virtual_files(ui);
}
