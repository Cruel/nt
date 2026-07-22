#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/surface.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"
#include "ui/runtime_ui_lifecycle_fixture.hpp"

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Event.h>
#include <RmlUi/Core/EventListener.h>
#include <RmlUi/Core/Types.h>
#include <SDL3/SDL_events.h>
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <concepts>
#include <fstream>
#include <functional>
#include <iterator>
#include <memory>
#include <utility>
#include <vector>

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

constexpr const char* kMediaQueryDocument = R"(
<rml>
  <head>
    <style>
      body { width: 100%; height: 100%; }
      #probe { display: block; width: 100px; height: 10px; }
      @media (min-width: 1500px) {
        #probe { width: 200px; }
      }
    </style>
  </head>
  <body>
    <div id="probe"></div>
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

class RecordingPointerCoordinates final : public Rml::EventListener {
public:
    void ProcessEvent(Rml::Event& event) override
    {
        ++calls;
        x = event.GetParameter<int>("mouse_x", -1);
        y = event.GetParameter<int>("mouse_y", -1);
    }

    int calls = 0;
    int x = -1;
    int y = -1;
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
concept HasDensityBypass = requires(noveltea::RuntimeUI& value) { T::set_density(value, 1.0f); };

template<class T>
concept HasBackendReset = requires(T& value) {
    { value.reset_backend() } -> std::same_as<bool>;
};

TEST_CASE("private RuntimeUI is a view and input adapter without runtime authority")
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
    STATIC_REQUIRE_FALSE(HasDensityBypass<RuntimeUiFacadeAccess>);
    STATIC_REQUIRE(HasBackendReset<noveltea::RuntimeUI>);

    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
}

TEST_CASE("RuntimeUI selector playback and native inspection use the internal playback driver")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    auto& ui = fixture.runtime_ui();
    CHECK(noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui) == nullptr);
    REQUIRE(fixture.initialize());
    const auto presentation = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1000, 800, 1500, 1200),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);
    ui.resize(presentation.value());
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(ui, "gameplay", kDocument,
                                                             "preview://playback.rml", true));

    int activations = 0;
    const auto listener = RuntimeUiFacadeAccess::add_event_listener(
        ui, "gameplay", "action", "click", [&activations]() { ++activations; });
    REQUIRE(listener != 0);
    ui.begin_frame({});

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* document = driver->document("gameplay");
    REQUIRE(document);
    auto* context = document->GetContext();
    REQUIRE(context);
    CHECK(context->GetDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(context->GetMediaQueryDimensions() ==
          Rml::Vector2i(presentation.value().ui_raster.size.width,
                        presentation.value().ui_raster.size.height));
    CHECK(context->GetDensityIndependentPixelRatio() ==
          Catch::Approx(static_cast<float>(presentation.value().ui_raster.size.width) / 1920.0f));
    CHECK(context->GetTextScaleFactor() == Catch::Approx(1.0f));
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

TEST_CASE("RuntimeUI keeps context-logical event coordinates and leaves on presentation bars")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    const auto presentation = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1000, 800, 1500, 1200),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);
    ui.resize(presentation.value());
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(ui, "gameplay", kDocument,
                                                             "preview://pointer-bars.rml", true));
    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);
    ui.begin_frame({});

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* action = driver->element("gameplay", "action");
    REQUIRE(action);

    const noveltea::PresentationTransform transform{presentation.value()};
    const Rml::Vector2f action_offset = action->GetAbsoluteOffset(Rml::BoxArea::Content);
    const Rml::Vector2f action_size = action->GetBox().GetSize(Rml::BoxArea::Content);
    const noveltea::Vec2 action_center{action_offset.x + action_size.x * 0.5f,
                                       action_offset.y + action_size.y * 0.5f};
    RecordingPointerCoordinates coordinates;
    action->AddEventListener("mousemove", &coordinates);
    const noveltea::Vec2 host_inside = transform.reference_to_host_logical(action_center);
    SDL_Event motion{};
    motion.type = SDL_EVENT_MOUSE_MOTION;
    motion.motion.x = host_inside.x;
    motion.motion.y = host_inside.y;
    (void)ui.process_event(motion);
    CHECK(action->IsPseudoClassSet("hover"));
    CHECK(coordinates.calls == 1);
    CHECK(coordinates.x == static_cast<int>(action_center.x));
    CHECK(coordinates.y == static_cast<int>(action_center.y));

    motion.motion.x = 500.0f;
    motion.motion.y = 10.0f;
    (void)ui.process_event(motion);
    CHECK_FALSE(action->IsPseudoClassSet("hover"));
    action->RemoveEventListener("mousemove", &coordinates);
}

TEST_CASE("RuntimeUI input sink rebinding preserves immutable gameplay UI values")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
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

TEST_CASE("RuntimeUI built-in settings controls follow loaded project accessibility policy")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_builtin_system_document(
        ui, "runtime_settings_menu", "system:/ui/menu/settings-menu.rml"));

    const auto settings = noveltea::core::RuntimeUserSettings::create(1.0, 1.4);
    REQUIRE(settings);
    noveltea::core::RuntimeShellViewState view;
    view.settings = settings.value();
    view.accessibility = {
        .ui_scale = {.enabled = false, .minimum = 0.8, .maximum = 1.5},
        .text_scale = {.enabled = true, .minimum = 1.1, .maximum = 1.8},
    };
    ui.apply_runtime_shell_view(view);
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{});

    auto* playback_driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(playback_driver);
    auto* ui_control =
        playback_driver->element("runtime_settings_menu", "nt-settings-ui-scale-control");
    auto* text_control =
        playback_driver->element("runtime_settings_menu", "nt-settings-text-scale-control");
    auto* text_minimum =
        playback_driver->element("runtime_settings_menu", "nt-settings-text-scale-minimum");
    auto* text_maximum =
        playback_driver->element("runtime_settings_menu", "nt-settings-text-scale-maximum");
    auto* text_value = playback_driver->element("runtime_settings_menu", "nt-settings-text-scale");
    REQUIRE(ui_control);
    REQUIRE(text_control);
    REQUIRE(text_minimum);
    REQUIRE(text_maximum);
    REQUIRE(text_value);
    CHECK_FALSE(ui_control->IsVisible());
    CHECK(text_control->IsVisible());
    CHECK(text_minimum->GetInnerRML() == "1.1");
    CHECK(text_maximum->GetInnerRML() == "1.8");
    CHECK(text_value->GetInnerRML() == "1.4");
}

TEST_CASE("RuntimeUI delegates ActiveText playback snapshot and completion to its presenter")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
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

TEST_CASE("RuntimeUI DPR-only resize rerasterizes native text without replacing document state")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    auto test_system_assets = std::make_shared<noveltea::assets::MemoryAssetSource>();
    std::ifstream font_file(std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                                "apps/sandbox/assets/rmlui/LiberationSans.ttf",
                            std::ios::binary);
    REQUIRE(font_file);
    noveltea::assets::AssetBytes font_bytes(std::istreambuf_iterator<char>(font_file), {});
    REQUIRE_FALSE(font_bytes.empty());
    test_system_assets->add("fonts/LiberationSans.ttf", std::move(font_bytes),
                            "ActiveText scale integration font");
    fixture.assets().mount("system", std::move(test_system_assets));
    auto& ui = fixture.runtime_ui();
    const auto high_density = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1920, 1080, 3840, 2160),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(high_density);
    ui.resize(high_density.value());
    REQUIRE(fixture.initialize());
    const auto settings = noveltea::core::RuntimeUserSettings::create(1.25, 1.5);
    REQUIRE(settings);
    REQUIRE(ui.reconfigure_user_settings(settings.value()));
    REQUIRE(RuntimeUiFacadeAccess::load_runtime_document(ui));

    const noveltea::core::MountedLayoutPolicy layout_policy{
        .plane = noveltea::core::PresentationPlane::WorldOverlay,
        .clock = noveltea::core::LayoutClockDomain::Gameplay,
        .input = noveltea::core::LayoutInputMode::Normal,
        .gameplay_pause = noveltea::core::GameplayPausePolicy::Continue,
        .visibility = noveltea::core::LayoutVisibility::Visible,
        .escape_dismissal = noveltea::core::EscapeDismissalPolicy::Ignore,
        .entrance_operation = std::nullopt,
        .exit_operation = std::nullopt,
    };
    const noveltea::core::LayoutScalePolicy inherited_scales{};
    const noveltea::core::LayoutScalePolicy ignored_ui_scale{
        noveltea::core::LayoutScaleInheritance::Ignore,
        noveltea::core::LayoutScaleInheritance::Inherit,
    };
    constexpr std::uint32_t composition_group = 17;
    REQUIRE(ui.load_document_from_memory_for_layout(
        "dpr-inherited", kDocument, "preview://dpr-inherited.rml", true, layout_policy,
        composition_group, noveltea::core::MountedLayoutOwner::Gameplay, inherited_scales, 0));
    REQUIRE(ui.load_document_from_memory_for_layout(
        "dpr-ignored", kDocument, "preview://dpr-ignored.rml", true, layout_policy,
        composition_group, noveltea::core::MountedLayoutOwner::Gameplay, ignored_ui_scale, 1));

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* document = driver->document("runtime_game");
    auto* element = driver->element("runtime_game", "rt_body");
    auto* title = driver->element("runtime_game", "rt_title");
    auto* inherited_document = driver->document("dpr-inherited");
    auto* ignored_document = driver->document("dpr-ignored");
    REQUIRE(document);
    REQUIRE(element);
    REQUIRE(title);
    REQUIRE(inherited_document);
    REQUIRE(ignored_document);
    auto* context = document->GetContext();
    auto* inherited_context = inherited_document->GetContext();
    auto* ignored_context = ignored_document->GetContext();
    REQUIRE(context);
    REQUIRE(inherited_context);
    REQUIRE(ignored_context);
    title->SetInnerRML("DPR-stable native RmlUi text");
    element->SetAttribute("data-resize-state", "preserved");
    inherited_document->SetAttribute("data-resize-state", "inherited-preserved");
    ignored_document->SetAttribute("data-resize-state", "ignored-preserved");
    context->Update();
    inherited_context->Update();
    ignored_context->Update();

    const auto room = noveltea::core::RoomId::create("room");
    REQUIRE(room);
    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "room";
    values.view.room = noveltea::core::RoomView{
        .room = *room.value_if(),
        .description = "Scale-aware ActiveText keeps shaping logical and rasterization native.",
        .description_markup = noveltea::core::TextMarkup::ActiveText};
    REQUIRE(ui.apply_gameplay_ui_values(values));
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{.gameplay_delta = std::chrono::seconds(2),
                                                      .gameplay_time = std::chrono::seconds(2)});

    CHECK(context->GetDimensions() == Rml::Vector2i(1536, 864));
    CHECK(context->GetTextScaleFactor() == Catch::Approx(1.5f));
    CHECK(context->GetFontRasterScale() == Catch::Approx(2.5f));
    CHECK(inherited_context->GetDimensions() == Rml::Vector2i(1536, 864));
    CHECK(inherited_context->GetMediaQueryDimensions() == Rml::Vector2i(3840, 2160));
    CHECK(inherited_context->GetDensityIndependentPixelRatio() == Catch::Approx(2.5f));
    CHECK(inherited_context->GetTextScaleFactor() == Catch::Approx(1.5f));
    CHECK(inherited_context->GetFontRasterScale() == Catch::Approx(2.5f));
    CHECK(ignored_context->GetDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(ignored_context->GetMediaQueryDimensions() == Rml::Vector2i(3840, 2160));
    CHECK(ignored_context->GetDensityIndependentPixelRatio() == Catch::Approx(2.0f));
    CHECK(ignored_context->GetTextScaleFactor() == Catch::Approx(1.5f));
    CHECK(ignored_context->GetFontRasterScale() == Catch::Approx(2.0f));
    const Rml::FontFaceHandle high_density_rmlui_font = title->GetFontFaceHandle();
    REQUIRE(high_density_rmlui_font != 0);

    const auto content_offset = element->GetAbsoluteOffset(Rml::BoxArea::Content);
    const auto content_size = element->GetBox().GetSize(Rml::BoxArea::Content);
    const auto high_density_layout = ui.active_text_render_snapshot();
    REQUIRE_FALSE(high_density_layout.glyphs.empty());
    CHECK(high_density_layout.bounds.x == Catch::Approx(content_offset.x));
    CHECK(high_density_layout.bounds.y == Catch::Approx(content_offset.y));
    CHECK(high_density_layout.bounds.width == Catch::Approx(content_size.x));
    CHECK(high_density_layout.bounds.height == Catch::Approx(content_size.y));
    REQUIRE(high_density_layout.glyphs.front().has_shaped_glyph);
    CHECK(high_density_layout.glyphs.front().shaped_glyph.logical_pixel_size ==
          Catch::Approx(25.5f));
    CHECK(high_density_layout.glyphs.front().shaped_glyph.raster_pixel_size ==
          Catch::Approx(64.0f));
    CHECK(std::any_of(high_density_layout.glyphs.begin(), high_density_layout.glyphs.end(),
                      [](const auto& glyph) {
                          return glyph.has_shaped_glyph &&
                                 std::abs(glyph.shaped_glyph.advance.x -
                                          std::round(glyph.shaped_glyph.advance.x)) > 0.01f;
                      }));
    const auto stable_visible_text = high_density_layout.visible_text;
    const auto stable_phase = ui.active_text_presentation_phase();

    const auto native_density = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1920, 1080, 1920, 1080),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(native_density);
    ui.resize(native_density.value());
    ui.begin_frame({});
    context->Update();
    inherited_context->Update();
    ignored_context->Update();
    CHECK(driver->document("runtime_game") == document);
    CHECK(driver->element("runtime_game", "rt_body") == element);
    CHECK(driver->document("dpr-inherited") == inherited_document);
    CHECK(driver->document("dpr-ignored") == ignored_document);
    CHECK(document->GetContext() == context);
    CHECK(inherited_document->GetContext() == inherited_context);
    CHECK(ignored_document->GetContext() == ignored_context);
    CHECK(element->GetAttribute<Rml::String>("data-resize-state", "") == "preserved");
    CHECK(inherited_document->GetAttribute<Rml::String>("data-resize-state", "") ==
          "inherited-preserved");
    CHECK(ignored_document->GetAttribute<Rml::String>("data-resize-state", "") ==
          "ignored-preserved");
    CHECK(context->GetDimensions() == Rml::Vector2i(1536, 864));
    CHECK(context->GetTextScaleFactor() == Catch::Approx(1.5f));
    CHECK(context->GetFontRasterScale() == Catch::Approx(1.25f));
    CHECK(inherited_context->GetDimensions() == Rml::Vector2i(1536, 864));
    CHECK(inherited_context->GetMediaQueryDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(inherited_context->GetDensityIndependentPixelRatio() == Catch::Approx(1.25f));
    CHECK(inherited_context->GetTextScaleFactor() == Catch::Approx(1.5f));
    CHECK(inherited_context->GetFontRasterScale() == Catch::Approx(1.25f));
    CHECK(ignored_context->GetDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(ignored_context->GetMediaQueryDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(ignored_context->GetDensityIndependentPixelRatio() == Catch::Approx(1.0f));
    CHECK(ignored_context->GetTextScaleFactor() == Catch::Approx(1.5f));
    CHECK(ignored_context->GetFontRasterScale() == Catch::Approx(1.0f));
    const Rml::FontFaceHandle native_density_rmlui_font = title->GetFontFaceHandle();
    REQUIRE(native_density_rmlui_font != 0);
    CHECK(native_density_rmlui_font != high_density_rmlui_font);
    const auto native_density_layout = ui.active_text_render_snapshot();
    REQUIRE_FALSE(native_density_layout.glyphs.empty());
    REQUIRE(native_density_layout.glyphs.front().has_shaped_glyph);
    CHECK(native_density_layout.bounds.x == Catch::Approx(high_density_layout.bounds.x));
    CHECK(native_density_layout.bounds.y == Catch::Approx(high_density_layout.bounds.y));
    CHECK(native_density_layout.bounds.width == Catch::Approx(high_density_layout.bounds.width));
    CHECK(native_density_layout.bounds.height == Catch::Approx(high_density_layout.bounds.height));
    CHECK(native_density_layout.glyphs.front().shaped_glyph.logical_pixel_size ==
          Catch::Approx(25.5f));
    CHECK(native_density_layout.glyphs.front().shaped_glyph.raster_pixel_size ==
          Catch::Approx(32.0f));
    CHECK(native_density_layout.metrics.width ==
          Catch::Approx(high_density_layout.metrics.width).margin(1.0f));
    CHECK(native_density_layout.visible_text == stable_visible_text);
    CHECK(ui.active_text_presentation_phase() == stable_phase);

    ui.resize(native_density.value());
    ui.begin_frame({});
    context->Update();
    inherited_context->Update();
    ignored_context->Update();
    CHECK(driver->document("runtime_game") == document);
    CHECK(driver->document("dpr-inherited") == inherited_document);
    CHECK(driver->document("dpr-ignored") == ignored_document);
    CHECK(title->GetFontFaceHandle() == native_density_rmlui_font);
    CHECK(inherited_context->GetFontRasterScale() == Catch::Approx(1.25f));
    CHECK(ignored_context->GetFontRasterScale() == Catch::Approx(1.0f));
    CHECK(ui.active_text_render_snapshot().visible_text == stable_visible_text);
    CHECK(ui.active_text_presentation_phase() == stable_phase);
}

TEST_CASE("RuntimeUI preserves lifecycle document state across migration and reload")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
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
    auto* action_before_context_migration = action;
    action->Focus();
    REQUIRE(action->IsPseudoClassSet("focus"));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 1);

    REQUIRE(ui.apply_layout_policy("gameplay", gameplay, 2));
    action = playback_driver->element("gameplay", "action");
    REQUIRE(action);
    CHECK(action != action_before_context_migration);
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
    REQUIRE(fixture.initialize());
    CHECK(ui.is_initialized());
}

TEST_CASE("RuntimeUI migrates a Layout when its effective scale domain changes")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    const noveltea::core::MountedLayoutPolicy policy{
        .plane = noveltea::core::PresentationPlane::GameUi,
        .clock = noveltea::core::LayoutClockDomain::Gameplay,
        .input = noveltea::core::LayoutInputMode::Normal,
        .gameplay_pause = noveltea::core::GameplayPausePolicy::Continue,
        .visibility = noveltea::core::LayoutVisibility::Visible,
        .escape_dismissal = noveltea::core::EscapeDismissalPolicy::Ignore,
        .entrance_operation = std::nullopt,
        .exit_operation = std::nullopt,
    };
    REQUIRE(ui.load_document_from_memory_for_layout(
        "scaled", kDocument, "preview://scaled.rml", true, policy, 1,
        noveltea::core::MountedLayoutOwner::Gameplay, noveltea::core::LayoutScalePolicy{}, 0));
    REQUIRE(ui.load_document_from_memory_for_layout(
        "scaled-peer", kDocument, "preview://scaled-peer.rml", true, policy, 1,
        noveltea::core::MountedLayoutOwner::Gameplay, noveltea::core::LayoutScalePolicy{}, 0));

    int activations = 0;
    const auto listener = RuntimeUiFacadeAccess::add_event_listener(
        ui, "scaled", "action", "click", [&activations]() { ++activations; });
    REQUIRE(listener != 0);
    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* document = driver->document("scaled");
    auto* peer_document = driver->document("scaled-peer");
    auto* action = driver->element("scaled", "action");
    REQUIRE(document);
    REQUIRE(peer_document);
    REQUIRE(action);
    auto* context = document->GetContext();
    REQUIRE(context);
    CHECK(peer_document->GetContext() == context);
    action->Focus();
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 1);

    const noveltea::core::LayoutScalePolicy ignore_ui{
        noveltea::core::LayoutScaleInheritance::Ignore,
        noveltea::core::LayoutScaleInheritance::Inherit,
    };
    REQUIRE(ui.apply_layout_policy("scaled", policy, 1,
                                   noveltea::core::MountedLayoutOwner::Gameplay, ignore_ui, 0));
    auto* migrated_document = driver->document("scaled");
    auto* migrated_action = driver->element("scaled", "action");
    REQUIRE(migrated_document);
    REQUIRE(migrated_action);
    CHECK(migrated_document != document);
    CHECK(migrated_document->GetContext() != context);
    CHECK(driver->document("scaled-peer") == peer_document);
    CHECK(peer_document->GetContext() == context);
    CHECK(migrated_document->IsVisible());
    CHECK(migrated_action->IsPseudoClassSet("focus"));
    REQUIRE(migrated_action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 2);

    REQUIRE(ui.apply_layout_policy("scaled", policy, 1,
                                   noveltea::core::MountedLayoutOwner::Gameplay, ignore_ui, 0));
    CHECK(driver->document("scaled") == migrated_document);
    CHECK(driver->element("scaled", "action") == migrated_action);
    CHECK(RuntimeUiFacadeAccess::remove_event_listener(ui, listener));
}

TEST_CASE("RuntimeUI reconfigures user scales without replacing documents focus or listeners")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(ui, "gameplay", kDocument,
                                                             "preview://gameplay.rml", true));

    int activations = 0;
    const auto listener = RuntimeUiFacadeAccess::add_event_listener(
        ui, "gameplay", "action", "click", [&activations]() { ++activations; });
    REQUIRE(listener != 0);
    auto* playback_driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(playback_driver);
    auto* document = playback_driver->document("gameplay");
    auto* action = playback_driver->element("gameplay", "action");
    REQUIRE(document);
    REQUIRE(action);
    auto* context = action->GetContext();
    REQUIRE(context);
    const auto dimensions_before = context->GetDimensions();
    action->Focus();
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 1);

    const auto settings = noveltea::core::RuntimeUserSettings::create(1.25, 1.4);
    REQUIRE(settings);
    REQUIRE(ui.reconfigure_user_settings(settings.value()));

    CHECK(playback_driver->document("gameplay") == document);
    CHECK(playback_driver->element("gameplay", "action") == action);
    CHECK(action->IsPseudoClassSet("focus"));
    CHECK(action->GetContext() == context);
    CHECK(context->GetDimensions() != dimensions_before);
    CHECK(context->GetTextScaleFactor() == Catch::Approx(1.4f));
    REQUIRE(action->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(activations == 2);
    CHECK(RuntimeUiFacadeAccess::remove_event_listener(ui, listener));
}

TEST_CASE("RuntimeUI applies distinct metrics to simultaneous inherited and ignored scale domains")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    const auto presentation = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1920, 1080, 3840, 2160),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);
    ui.resize(presentation.value());

    const noveltea::core::MountedLayoutPolicy policy{
        .plane = noveltea::core::PresentationPlane::GameUi,
        .clock = noveltea::core::LayoutClockDomain::Gameplay,
        .input = noveltea::core::LayoutInputMode::Normal,
        .gameplay_pause = noveltea::core::GameplayPausePolicy::Continue,
        .visibility = noveltea::core::LayoutVisibility::Visible,
        .escape_dismissal = noveltea::core::EscapeDismissalPolicy::Ignore,
        .entrance_operation = std::nullopt,
        .exit_operation = std::nullopt,
    };
    const noveltea::core::LayoutScalePolicy ignore_both{
        noveltea::core::LayoutScaleInheritance::Ignore,
        noveltea::core::LayoutScaleInheritance::Ignore,
    };
    REQUIRE(ui.load_document_from_memory_for_layout(
        "inherits-scales", kDocument, "preview://inherits-scales.rml", true, policy, 7,
        noveltea::core::MountedLayoutOwner::Gameplay, {}, 0));
    REQUIRE(ui.load_document_from_memory_for_layout(
        "ignores-scales", kDocument, "preview://ignores-scales.rml", true, policy, 7,
        noveltea::core::MountedLayoutOwner::Gameplay, ignore_both, 0));

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* inherited_document = driver->document("inherits-scales");
    auto* ignored_document = driver->document("ignores-scales");
    REQUIRE(inherited_document);
    REQUIRE(ignored_document);
    auto* inherited_context = inherited_document->GetContext();
    auto* ignored_context = ignored_document->GetContext();
    REQUIRE(inherited_context);
    REQUIRE(ignored_context);
    REQUIRE(inherited_context != ignored_context);

    const auto settings = noveltea::core::RuntimeUserSettings::create(1.25, 1.4);
    REQUIRE(settings);
    REQUIRE(ui.reconfigure_user_settings(settings.value()));
    ui.begin_frame({});

    CHECK(driver->document("inherits-scales") == inherited_document);
    CHECK(driver->document("ignores-scales") == ignored_document);
    CHECK(inherited_document->GetContext() == inherited_context);
    CHECK(ignored_document->GetContext() == ignored_context);

    CHECK(inherited_context->GetDimensions() == Rml::Vector2i(1536, 864));
    CHECK(inherited_context->GetMediaQueryDimensions() == Rml::Vector2i(3840, 2160));
    CHECK(inherited_context->GetDensityIndependentPixelRatio() == Catch::Approx(2.5f));
    CHECK(inherited_context->GetTextScaleFactor() == Catch::Approx(1.4f));
    CHECK(inherited_context->GetFontRasterScale() == Catch::Approx(2.5f));

    CHECK(ignored_context->GetDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(ignored_context->GetMediaQueryDimensions() == Rml::Vector2i(3840, 2160));
    CHECK(ignored_context->GetDensityIndependentPixelRatio() == Catch::Approx(2.0f));
    CHECK(ignored_context->GetTextScaleFactor() == Catch::Approx(1.0f));
    CHECK(ignored_context->GetFontRasterScale() == Catch::Approx(2.0f));

    REQUIRE(driver->element("inherits-scales", "action"));
    REQUIRE(driver->element("ignores-scales", "action"));
}

TEST_CASE("RuntimeUI renders interleaved Layout scale domains through isolated context metrics")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    const auto presentation = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1920, 1080, 3840, 2160),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);
    ui.resize(presentation.value());
    const auto settings = noveltea::core::RuntimeUserSettings::create(1.25, 1.0);
    REQUIRE(settings);
    REQUIRE(ui.reconfigure_user_settings(settings.value()));

    const noveltea::core::MountedLayoutPolicy policy{
        .plane = noveltea::core::PresentationPlane::WorldOverlay,
        .clock = noveltea::core::LayoutClockDomain::Gameplay,
        .input = noveltea::core::LayoutInputMode::Normal,
        .gameplay_pause = noveltea::core::GameplayPausePolicy::Continue,
        .visibility = noveltea::core::LayoutVisibility::Visible,
        .escape_dismissal = noveltea::core::EscapeDismissalPolicy::Ignore,
        .entrance_operation = std::nullopt,
        .exit_operation = std::nullopt,
    };
    const noveltea::core::LayoutScalePolicy inherited{};
    const noveltea::core::LayoutScalePolicy ignored_ui{
        noveltea::core::LayoutScaleInheritance::Ignore,
        noveltea::core::LayoutScaleInheritance::Inherit,
    };
    constexpr std::uint32_t composition_group = 9;
    REQUIRE(ui.load_document_from_memory_for_layout(
        "world-inherited-first", kDocument, "preview://world-inherited-first.rml", true, policy,
        composition_group, noveltea::core::MountedLayoutOwner::Gameplay, inherited, 0));
    REQUIRE(ui.load_document_from_memory_for_layout(
        "world-ignored-middle", kDocument, "preview://world-ignored-middle.rml", true, policy,
        composition_group, noveltea::core::MountedLayoutOwner::Gameplay, ignored_ui, 1));
    REQUIRE(ui.load_document_from_memory_for_layout(
        "world-inherited-last", kDocument, "preview://world-inherited-last.rml", true, policy,
        composition_group, noveltea::core::MountedLayoutOwner::Gameplay, inherited, 2));

    struct RenderedContext {
        noveltea::ui::rmlui::LifecycleContextKey key;
        noveltea::ResolvedContextMetrics metrics;
    };
    std::vector<RenderedContext> rendered;
    RuntimeUiFacadeAccess::set_context_render_observer(
        ui, [&](const auto& key, const auto& metrics) {
            if (key.plane == noveltea::core::PresentationPlane::WorldOverlay &&
                key.composition_group == composition_group) {
                rendered.push_back({key, metrics});
            }
        });

    ui.begin_frame({});
    ui.end_frame();
    REQUIRE(rendered.size() == 3);
    CHECK(rendered[0].key.compatibility_group == 0);
    CHECK(rendered[1].key.compatibility_group == 1);
    CHECK(rendered[2].key.compatibility_group == 2);
    CHECK(rendered[0].key.scale_domain ==
          noveltea::ui::rmlui::LayoutScaleDomain::UiInheritTextInherit);
    CHECK(rendered[1].key.scale_domain ==
          noveltea::ui::rmlui::LayoutScaleDomain::UiIgnoreTextInherit);
    CHECK(rendered[2].key.scale_domain ==
          noveltea::ui::rmlui::LayoutScaleDomain::UiInheritTextInherit);
    CHECK(rendered[0].metrics.layout_size == noveltea::IntegerSize{1536, 864});
    CHECK(rendered[1].metrics.layout_size == noveltea::IntegerSize{1920, 1080});
    CHECK(rendered[2].metrics.layout_size == noveltea::IntegerSize{1536, 864});

    const noveltea::PresentationTransform transform(presentation.value());
    const noveltea::Vec2 reference_anchor_with_offset{1008.0f, 516.0f};
    std::vector<noveltea::Vec2> raster_points;
    for (const auto& context : rendered) {
        const auto logical =
            transform.reference_to_context_logical(reference_anchor_with_offset, context.metrics);
        raster_points.push_back(
            transform.context_logical_to_native_ui_raster(logical, context.metrics));
    }
    REQUIRE(raster_points.size() == 3);
    CHECK(raster_points[0].x == Catch::Approx(2016.0f));
    CHECK(raster_points[0].y == Catch::Approx(1032.0f));
    CHECK(raster_points[1].x == Catch::Approx(raster_points[0].x));
    CHECK(raster_points[1].y == Catch::Approx(raster_points[0].y));
    CHECK(raster_points[2].x == Catch::Approx(raster_points[0].x));
    CHECK(raster_points[2].y == Catch::Approx(raster_points[0].y));
    RuntimeUiFacadeAccess::set_context_render_observer(ui, {});
}

TEST_CASE("RuntimeUI reevaluates output media dimensions and rejects invalid environment updates")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    const auto small = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1280, 720, 1280, 720),
        {.reference = {.size = {1920, 1080}}});
    const auto large = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1920, 1080, 1920, 1080),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(small);
    REQUIRE(large);
    ui.resize(small.value());
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(ui, "media-query", kMediaQueryDocument,
                                                             "preview://media-query.rml", true));
    ui.begin_frame({});

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* document = driver->document("media-query");
    auto* probe = driver->element("media-query", "probe");
    REQUIRE(document);
    REQUIRE(probe);
    auto* context = document->GetContext();
    REQUIRE(context);
    CHECK(context->GetDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(context->GetMediaQueryDimensions() == Rml::Vector2i(1280, 720));
    CHECK(probe->GetBox().GetSize().x == Catch::Approx(100.0f));

    ui.resize(large.value());
    ui.begin_frame({});
    CHECK(driver->document("media-query") == document);
    CHECK(document->GetContext() == context);
    CHECK(context->GetDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(context->GetMediaQueryDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(probe->GetBox().GetSize().x == Catch::Approx(200.0f));

    auto invalid = large.value();
    invalid.ui_raster.size.width = 0;
    ui.resize(invalid);
    ui.begin_frame({});
    CHECK(context->GetDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(context->GetMediaQueryDimensions() == Rml::Vector2i(1920, 1080));
    CHECK(context->GetDensityIndependentPixelRatio() == Catch::Approx(1.0f));
    CHECK(probe->GetBox().GetSize().x == Catch::Approx(200.0f));
}

TEST_CASE("RuntimeUI document registry restores virtual path memory and built-in documents")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
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
