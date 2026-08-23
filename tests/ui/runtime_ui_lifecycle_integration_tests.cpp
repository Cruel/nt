#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/presentation/runtime_layout_manager.hpp"
#include "noveltea/surface.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"
#include "ui/rmlui/rmlui_host.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"
#include "ui/runtime_ui_lifecycle_fixture.hpp"

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/ComputedValues.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Event.h>
#include <RmlUi/Core/EventListener.h>
#include <RmlUi/Core/Types.h>
#include <SDL3/SDL_events.h>
#include <SDL3/SDL_mouse.h>
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <lua.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <concepts>
#include <fstream>
#include <functional>
#include <iterator>
#include <memory>
#include <utility>
#include <variant>
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

constexpr const char* kBaselineDocument = R"(
<rml>
  <head></head>
  <body id="baseline-body">
    <p id="baseline-paragraph">Baseline paragraph</p>
    <button id="baseline-button">Baseline button</button>
  </body>
</rml>
)";

constexpr const char* kBaselineOverrideDocument = R"(
<rml>
  <head>
    <style>
      body { color: #010203; }
      p { display: inline-block; }
      button { background-color: #040506; }
    </style>
  </head>
  <body id="override-body">
    <p id="override-paragraph">Override paragraph</p>
    <button id="override-button">Override button</button>
  </body>
</rml>
)";

constexpr const char* kShellBindingDocument = R"(
<rml>
  <head></head>
  <body data-model="noveltea">
    <span id="nt-shell-status">{{ shell.status }}</span>
  </body>
</rml>
)";

constexpr const char* kAuthoredGameHudDocument = R"(
<rml>
  <head></head>
  <body data-model="noveltea">
    <span id="rt_mode">{{ gameplay.mode }}</span>
    <span id="rt_notification">{{ gameplay.notification }}</span>
    <div id="rt_background_image"><span>sentinel</span></div>
  </body>
</rml>
)";

constexpr const char* kCustomComponentScopeDocument = R"(
<rml>
  <head></head>
  <body>
    <nt-active-text id="active"></nt-active-text>
    <nt-map-view id="map"></nt-map-view>
  </body>
</rml>
)";

constexpr const char* kBinderCharacterizationDocument = R"RML(
<rml>
  <head></head>
  <body data-model="noveltea">
    <span id="rt_mode">{{ gameplay.mode }}</span>
    <span id="rt_title" data-if="gameplay.title != ''">{{ gameplay.title }}</span>
    <span id="rt_notification" data-if="gameplay.notification != ''">{{ gameplay.notification }}</span>
    <div id="rt_prompt">
      <button class="continue" data-if="gameplay.can_continue" data-event-click="ui_continue()">Continue</button>
    </div>
    <div id="rt_options">
      <button class="model-option" data-for="choice : gameplay.choices"
              data-class-disabled="!choice.enabled" data-attrif-disabled="!choice.enabled"
              data-event-click="ui_choose(choice.kind, choice.id)">{{ choice.label }}</button>
    </div>
    <div id="rt_text_panel"
         data-if="gameplay.active_text_available || gameplay.choices.size > 0"
         data-style-pointer-events="gameplay.can_continue || gameplay.choices.size > 0 ? 'auto' : 'none'"></div>
    <div id="rt_actors">
      <div class="model-actor" data-for="actor : gameplay.actors"
           data-attr-data-character-id="actor.character_id"
           data-attr-data-slot-id="actor.instance_id"
           data-attr-data-pose-id="actor.pose_id"
           data-attr-data-expression-id="actor.expression_id"
           data-attr-data-presentation-complete="actor.presentation_complete"></div>
    </div>
    <div id="rt_navigation" data-if="gameplay.room.has_enabled_exits">
      <button class="model-exit" data-for="exit : gameplay.room.exits" data-if="exit.enabled"
              data-attr-data-exit-id="exit.id" data-attr-data-direction="exit.direction"
              data-event-click="ui_navigate_room(exit.id)">{{ exit.glyph }} {{ exit.label }}</button>
    </div>
    <div id="rt_interaction_dock"
         data-if="gameplay.room.objects.size > 0 || gameplay.inventory.items.size > 0 || gameplay.interaction.has_selection || gameplay.interaction.actions.size > 0">
      <div id="rt_objects_group" data-if="gameplay.room.objects.size > 0"><div id="rt_objects">
        <button class="model-object" data-for="object : gameplay.room.objects"
                data-class-disabled="!object.enabled" data-class-selected="object.selected"
                data-attrif-disabled="!object.enabled"
                data-event-click="ui_toggle_subject(object.subject_kind, object.subject_id)">{{ object.label }}</button>
      </div></div>
      <div id="rt_inventory_group" data-if="gameplay.inventory.items.size > 0"><div id="rt_inventory">
        <button class="model-inventory" data-for="item : gameplay.inventory.items"
                data-class-disabled="!item.enabled" data-class-selected="item.selected"
                data-attrif-disabled="!item.enabled"
                data-event-click="ui_toggle_subject('interactable', item.id)">{{ item.display_name }}</button>
      </div></div>
      <div id="rt_actions_group"
           data-if="gameplay.interaction.has_selection || gameplay.interaction.actions.size > 0"><div id="rt_actions">
        <button class="clear-selection" data-if="gameplay.interaction.has_selection"
                data-event-click="ui_clear_selection()">Clear selection</button>
        <button class="model-action" data-for="action : gameplay.interaction.actions"
                data-class-disabled="!action.enabled" data-attrif-disabled="!action.enabled"
                data-event-click="ui_invoke_interaction(action.verb_id)">{{ action.label }}</button>
      </div></div>
    </div>
  </body>
</rml>
)RML";

constexpr const char* kTextLogDataModelDocument = R"RML(
<rml>
  <head></head>
  <body data-model="noveltea">
    <div id="text-log">
      <div id="text-log-empty" data-if="gameplay.text_log.entries.size == 0">No log entries</div>
      <div class="text-log-entry" data-for="entry : gameplay.text_log.entries"
           data-attr-data-sequence="entry.sequence" data-attr-data-kind="entry.kind">
        <span class="text-log-speaker" data-if="entry.has_speaker">{{ entry.speaker_id }}</span>
        <div class="text-log-body" data-rml="entry.body_rml"></div>
      </div>
    </div>
  </body>
</rml>
)RML";

constexpr const char* kAuthoredTitleDocument = R"(
<rml>
  <head></head>
  <body data-model="noveltea">
    <span id="project-title">{{ project.title }}</span>
    <span id="project-subtitle">{{ project.subtitle }}</span>
    <span id="project-start">{{ project.start_label }}</span>
    <span id="shell-status">{{ shell.status }}</span>
  </body>
</rml>
)";

constexpr const char* kAuthoredSettingsDocument = R"(
<rml>
  <head></head>
  <body>
    <div id="nt-settings-ui-scale-control"><span id="nt-settings-ui-scale"></span></div>
    <span id="nt-settings-ui-scale-minimum"></span>
    <span id="nt-settings-ui-scale-maximum"></span>
    <div id="nt-settings-text-scale-control"><span id="nt-settings-text-scale"></span></div>
    <span id="nt-settings-text-scale-minimum"></span>
    <span id="nt-settings-text-scale-maximum"></span>
    <span id="nt-shell-status"></span>
  </body>
</rml>
)";

constexpr const char* kAuthoredSaveDocument = R"RML(
<rml>
  <head></head>
  <body data-model="noveltea">
    <span id="nt-shell-status">{{ shell.status }}</span>
    <span id="nt-checkpoint-summary">{{ shell.checkpoint.summary }}</span>
    <div id="nt-save-slots">
      <section class="nt-save-slot" data-for="slot : shell.save_slots" data-if="slot.kind != 'autosave'">
        <h2>{{ slot.label }}</h2><p>{{ slot.detail }}</p>
        <img class="nt-save-thumbnail" data-if="slot.thumbnail_available" data-attr-src="slot.thumbnail_url"/>
        <p class="nt-save-thumbnail-missing" data-if="!slot.thumbnail_available">No thumbnail</p>
        <button data-event-click="shell_save_slot(slot.number)">Save</button>
      </section>
    </div>
  </body>
</rml>
)RML";

constexpr const char* kAuthoredLoadDocument = R"RML(
<rml>
  <head></head>
  <body data-model="noveltea">
    <span id="nt-shell-status">{{ shell.status }}</span>
    <span id="nt-checkpoint-summary">{{ shell.checkpoint.summary }}</span>
    <div id="nt-save-slots">
      <section class="nt-save-slot" data-for="slot : shell.save_slots">
        <h2>{{ slot.label }}</h2><p>{{ slot.detail }}</p>
        <img class="nt-save-thumbnail" data-if="slot.thumbnail_available" data-attr-src="slot.thumbnail_url"/>
        <p class="nt-save-thumbnail-missing" data-if="!slot.thumbnail_available">No thumbnail</p>
        <button data-if="slot.occupied" data-event-click="shell_load_slot(slot.kind, slot.number)">Load</button>
      </section>
    </div>
  </body>
</rml>
)RML";

constexpr const char* kAuthoredModalDocument = R"(
<rml>
  <head></head>
  <body>
    <span id="nt-shell-status"></span>
    <span id="nt-modal-prompt"></span>
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

constexpr const char* kDataModelDocument = R"RML(
<rml>
  <head>
    <style>
      body { width: 640px; height: 360px; }
      #binding-probe { display: block; }
      button { display: block; width: 160px; height: 32px; }
    </style>
  </head>
  <body>
    <span id="outside">{{ 10 }}</span>
    <section id="model-root" data-model="noveltea">
      <span id="inside">{{ 10 }}</span>
      <span id="project-title">{{ project.title }}</span>
      <span id="gameplay-mode">{{ gameplay.mode }}</span>
      <span id="shell-status">{{ shell.status }}</span>
      <div id="binding-probe"
           data-if="gameplay.available"
           data-class-available="gameplay.available"
           data-attr-data-mode="gameplay.mode"
           data-style-width="'37px'">probe</div>
      <div id="choices"><span class="model-choice" data-for="choice : gameplay.choices">{{ choice.label }}</span></div>
      <button id="choose" data-event-click="ui_choose('scene', 'choice-enabled')">Choose</button>
      <button id="assign" data-event-click="project.title = 'Mutated'">Assign</button>
    </section>
  </body>
</rml>
)RML";

constexpr const char* kDataModelCallbackDocument = R"RML(
<rml>
  <head></head>
  <body data-model="noveltea">
    <button id="ui-continue" data-event-click="ui_continue()">Continue</button>
    <button id="ui-choose-scene" data-event-click="ui_choose('scene', 'scene-enabled')">Scene</button>
    <button id="ui-choose-dialogue" data-event-click="ui_choose('dialogue', 'dialogue-enabled')">Dialogue</button>
    <button id="ui-navigate-room" data-event-click="ui_navigate_room('exit-enabled')">Navigate</button>
    <button id="ui-toggle-interactable" data-event-click="ui_toggle_subject('interactable', 'key')">Interactable</button>
    <button id="ui-toggle-character" data-event-click="ui_toggle_subject('character', 'alice')">Character</button>
    <button id="ui-clear-selection" data-event-click="ui_clear_selection()">Clear</button>
    <button id="ui-invoke-interaction" data-event-click="ui_invoke_interaction('inspect')">Invoke</button>

    <button id="shell-start" data-event-click="shell_start()">Start</button>
    <button id="shell-pause" data-event-click="shell_pause()">Pause</button>
    <button id="shell-resume" data-event-click="shell_resume()">Resume</button>
    <button id="shell-open-settings" data-event-click="shell_open_settings()">Settings</button>
    <button id="shell-open-save" data-event-click="shell_open_save()">Save menu</button>
    <button id="shell-open-load" data-event-click="shell_open_load()">Load menu</button>
    <button id="shell-open-text-log" data-event-click="shell_open_text_log()">Text log</button>
    <button id="shell-open-debug" data-event-click="shell_open_debug()">Debug</button>
    <button id="shell-close" data-event-click="shell_close()">Close</button>
    <button id="shell-return-to-title" data-event-click="shell_return_to_title()">Title</button>
    <button id="shell-quit" data-event-click="shell_quit()">Quit</button>
    <button id="shell-save-slot" data-event-click="shell_save_slot(7)">Save slot</button>
    <button id="shell-load-manual" data-event-click="shell_load_slot('manual', 8)">Load slot</button>
    <button id="shell-load-autosave" data-event-click="shell_load_slot('autosave', 0)">Autosave</button>
    <button id="shell-set-ui-scale" data-event-click="shell_set_ui_scale(1.25)">UI scale</button>
    <button id="shell-set-text-scale" data-event-click="shell_set_text_scale(1.5)">Text scale</button>
    <button id="shell-confirm" data-event-click="shell_confirm()">Confirm</button>
    <button id="shell-cancel" data-event-click="shell_cancel()">Cancel</button>

    <button id="shell-save-missing" data-event-click="shell_save_slot()">Bad save</button>
    <button id="shell-save-invalid-type" data-event-click="shell_save_slot('bad')">Bad save type</button>
    <button id="shell-save-hidden" data-event-click="shell_save_slot(9)">Hidden save</button>
    <button id="shell-load-missing-number" data-event-click="shell_load_slot('autosave')">Bad load</button>
    <button id="shell-load-invalid-kind" data-event-click="shell_load_slot('unknown', 0)">Bad load kind</button>
    <button id="shell-load-hidden" data-event-click="shell_load_slot('manual', 9)">Hidden load</button>
    <button id="shell-load-empty" data-event-click="shell_load_slot('manual', 7)">Empty load</button>
  </body>
</rml>
)RML";

class RecordingRuntimeUiInputSink final : public noveltea::RuntimeUiInputSink {
public:
    [[nodiscard]] bool submit_gameplay_input(noveltea::core::RuntimeInputMessage input) override
    {
        ++gameplay_inputs;
        last_gameplay_input = std::move(input);
        return true;
    }

    [[nodiscard]] bool submit_shell_command(noveltea::core::RuntimeShellCommand command) override
    {
        ++shell_commands;
        last_shell_command = std::move(command);
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
    std::optional<noveltea::core::RuntimeInputMessage> last_gameplay_input;
    std::optional<noveltea::core::RuntimeShellCommand> last_shell_command;
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

TEST_CASE("RuntimeUI noveltea data model binds seeded state across authored lifecycle contexts")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    auto& ui = fixture.runtime_ui();

    const auto scene = noveltea::core::SceneId::create("scene");
    const auto step = noveltea::core::SceneStepId::create("step");
    const auto choice = noveltea::core::SceneChoiceOptionId::create("choice-enabled");
    REQUIRE(scene);
    REQUIRE(step);
    REQUIRE(choice);

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "seeded-mode";
    values.view.scene = noveltea::core::SceneView{
        .scene = scene.value(),
        .choice = noveltea::core::SceneChoiceState{
            .scene = scene.value(),
            .step = step.value(),
            .options = {{.option = choice.value(), .label = "Enabled choice", .enabled = true}}}};
    auto prepared = ui.prepare_gameplay_ui_values(values);
    REQUIRE(prepared);
    ui.commit_gameplay_ui_values(std::move(*prepared.value_if()));
    ui.bind_title_document("Seeded Project", "Seeded subtitle", "Begin");
    noveltea::core::RuntimeShellViewState shell;
    shell.status = "Seeded shell";
    ui.apply_runtime_shell_view(shell);

    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);
    REQUIRE(fixture.initialize());

    const noveltea::core::MountedLayoutPolicy primary_policy{
        .plane = noveltea::core::PresentationPlane::GameUi,
        .clock = noveltea::core::LayoutClockDomain::Gameplay,
        .input = noveltea::core::LayoutInputMode::Normal,
        .gameplay_pause = noveltea::core::GameplayPausePolicy::Continue,
        .visibility = noveltea::core::LayoutVisibility::Visible,
        .escape_dismissal = noveltea::core::EscapeDismissalPolicy::Ignore,
    };
    const noveltea::core::MountedLayoutPolicy secondary_policy{
        .plane = noveltea::core::PresentationPlane::MenuOverlay,
        .clock = noveltea::core::LayoutClockDomain::UnscaledPresentation,
        .input = noveltea::core::LayoutInputMode::BlockGameplay,
        .gameplay_pause = noveltea::core::GameplayPausePolicy::Continue,
        .visibility = noveltea::core::LayoutVisibility::Visible,
        .escape_dismissal = noveltea::core::EscapeDismissalPolicy::Ignore,
    };
    REQUIRE(ui.load_document_from_memory_for_layout(
        "model-primary", kDataModelDocument, "preview://model-primary.rml", true, primary_policy,
        17, noveltea::core::MountedLayoutOwner::Gameplay));
    REQUIRE(ui.load_document_from_memory_for_layout(
        "model-secondary", kDataModelDocument, "preview://model-secondary.rml", true,
        secondary_policy, 18, noveltea::core::MountedLayoutOwner::Gameplay));

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* primary = driver->document("model-primary");
    auto* secondary = driver->document("model-secondary");
    REQUIRE(primary);
    REQUIRE(secondary);
    REQUIRE(primary->GetContext());
    REQUIRE(secondary->GetContext());
    CHECK(primary->GetContext() != secondary->GetContext());
    primary->GetContext()->Update();
    secondary->GetContext()->Update();

    const auto check_model_document = [&](const char* id) {
        auto* outside = driver->element(id, "outside");
        auto* inside = driver->element(id, "inside");
        auto* title = driver->element(id, "project-title");
        auto* mode = driver->element(id, "gameplay-mode");
        auto* status = driver->element(id, "shell-status");
        auto* probe = driver->element(id, "binding-probe");
        REQUIRE(outside);
        REQUIRE(inside);
        REQUIRE(title);
        REQUIRE(mode);
        REQUIRE(status);
        REQUIRE(probe);
        CHECK(outside->GetInnerRML().find("{{ 10 }}") != std::string::npos);
        CHECK(inside->GetInnerRML() == "10");
        CHECK(title->GetInnerRML() == "Seeded Project");
        CHECK(mode->GetInnerRML() == "seeded-mode");
        CHECK(status->GetInnerRML() == "Seeded shell");
        CHECK(probe->IsClassSet("available"));
        CHECK(probe->GetAttribute<Rml::String>("data-mode", "") == "seeded-mode");
        CHECK(probe->GetClientWidth() == Catch::Approx(37.0f));
        Rml::ElementList choices;
        driver->document(id)->GetElementsByClassName(choices, "model-choice");
        CHECK(std::count_if(choices.begin(), choices.end(), [](const Rml::Element* element) {
                  return element && element->GetInnerRML() == "Enabled choice";
              }) == 1);
    };
    check_model_document("model-primary");
    check_model_document("model-secondary");

    auto* choose_button = driver->element("model-primary", "choose");
    REQUIRE(choose_button);
    REQUIRE(choose_button->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(input_sink.gameplay_inputs == 1);
    REQUIRE(input_sink.last_gameplay_input);
    REQUIRE(std::holds_alternative<noveltea::core::SelectSceneChoiceInput>(
        *input_sink.last_gameplay_input));
    CHECK(
        std::get<noveltea::core::SelectSceneChoiceInput>(*input_sink.last_gameplay_input).option ==
        choice.value());

    values.revision = 2;
    values.view.scene->choice->options.front().enabled = false;
    REQUIRE(ui.apply_gameplay_ui_values(values));
    primary->GetContext()->Update();
    secondary->GetContext()->Update();
    REQUIRE(choose_button->DispatchEvent("click", Rml::Dictionary{}));
    CHECK(input_sink.gameplay_inputs == 1);

    auto* assign_button = driver->element("model-primary", "assign");
    REQUIRE(assign_button);
    REQUIRE(assign_button->DispatchEvent("click", Rml::Dictionary{}));
    primary->GetContext()->Update();
    CHECK(driver->element("model-primary", "project-title")->GetInnerRML() == "Seeded Project");

    ui.bind_title_document("Updated Project", "Updated subtitle", "Continue");
    shell.status = "Updated shell";
    ui.apply_runtime_shell_view(shell);
    primary->GetContext()->Update();
    secondary->GetContext()->Update();
    CHECK(driver->element("model-primary", "project-title")->GetInnerRML() == "Updated Project");
    CHECK(driver->element("model-secondary", "project-title")->GetInnerRML() == "Updated Project");
    CHECK(driver->element("model-primary", "shell-status")->GetInnerRML() == "Updated shell");
    CHECK(driver->element("model-secondary", "shell-status")->GetInnerRML() == "Updated shell");

    ui.clear_gameplay_ui_values();
    primary->GetContext()->Update();
    secondary->GetContext()->Update();
    REQUIRE(driver->element("model-primary", "binding-probe"));
    REQUIRE(driver->element("model-secondary", "binding-probe"));
    CHECK_FALSE(driver->element("model-primary", "binding-probe")->IsVisible());
    CHECK_FALSE(driver->element("model-secondary", "binding-probe")->IsVisible());
}

TEST_CASE("RuntimeUI noveltea model callbacks preserve the Lua action paths and reject malformed "
          "slot arguments")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    auto& ui = fixture.runtime_ui();
    RecordingRuntimeUiInputSink input_sink;
    REQUIRE(fixture.initialize());
    ui.bind_input_sink(&input_sink);

    noveltea::core::RuntimeShellViewState shell_view;
    shell_view.slots = {
        {.slot = noveltea::core::TypedSaveSlotId::autosave(), .occupied = true},
        {.slot = noveltea::core::TypedSaveSlotId::manual(7), .occupied = false},
        {.slot = noveltea::core::TypedSaveSlotId::manual(8), .occupied = true},
    };
    ui.apply_runtime_shell_view(shell_view);

    const auto scene = noveltea::core::SceneId::create("scene");
    const auto step = noveltea::core::SceneStepId::create("step");
    const auto scene_choice = noveltea::core::SceneChoiceOptionId::create("scene-enabled");
    const auto dialogue = noveltea::core::DialogueId::create("dialogue");
    const auto block = noveltea::core::DialogueBlockId::create("block");
    const auto dialogue_choice = noveltea::core::DialogueEdgeId::create("dialogue-enabled");
    const auto room = noveltea::core::RoomId::create("room");
    const auto target = noveltea::core::RoomId::create("target");
    const auto exit = noveltea::core::RoomExitId::create("exit-enabled");
    const auto placement = noveltea::core::RoomPlacementId::create("placement");
    const auto interactable = noveltea::core::InteractableId::create("key");
    const auto character = noveltea::core::CharacterId::create("alice");
    const auto verb = noveltea::core::VerbId::create("inspect");
    const auto target_slot = noveltea::core::VerbSlotId::create("target");
    REQUIRE(scene);
    REQUIRE(step);
    REQUIRE(scene_choice);
    REQUIRE(dialogue);
    REQUIRE(block);
    REQUIRE(dialogue_choice);
    REQUIRE(room);
    REQUIRE(target);
    REQUIRE(exit);
    REQUIRE(placement);
    REQUIRE(interactable);
    REQUIRE(character);
    REQUIRE(verb);
    REQUIRE(target_slot);

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.can_continue = true;
    values.view.scene =
        noveltea::core::SceneView{.scene = scene.value(),
                                  .choice = noveltea::core::SceneChoiceState{
                                      .scene = scene.value(),
                                      .step = step.value(),
                                      .options = {{scene_choice.value(), "Scene", true}}}};
    values.view.dialogue =
        noveltea::core::DialogueView{.dialogue = dialogue.value(),
                                     .choice = noveltea::core::DialogueChoiceState{
                                         .dialogue = dialogue.value(),
                                         .block = block.value(),
                                         .options = {{dialogue_choice.value(), "Dialogue", true}}}};
    values.view.room = noveltea::core::RoomView{
        .room = room.value(),
        .placements = {{.placement = placement.value(),
                        .occupants = {{.subject =
                                           noveltea::core::compiled::InteractableInteractionSubject{
                                               interactable.value()},
                                       .enabled = true,
                                       .visible = true},
                                      {.subject =
                                           noveltea::core::compiled::CharacterInteractionSubject{
                                               character.value()},
                                       .enabled = true,
                                       .visible = true}}}},
        .exits = {{exit.value(), target.value(), noveltea::core::compiled::RoomExitDirection::North,
                   "North", true}},
        .controls = {{verb.value(), "Inspect", {target_slot.value()}, false, true}}};
    REQUIRE(ui.apply_gameplay_ui_values(values));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "model-callbacks", kDataModelCallbackDocument, "preview://model-callbacks.rml", true));
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{});

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    const auto dispatch = [&](const char* id) {
        auto* button = driver->element("model-callbacks", id);
        REQUIRE(button);
        REQUIRE(button->DispatchEvent("click", Rml::Dictionary{}));
    };
    const auto expect_gameplay_parity = [&](const char* id, const char* lua_script) {
        const auto before = input_sink.gameplay_inputs;
        input_sink.last_gameplay_input.reset();
        dispatch(id);
        CHECK(input_sink.gameplay_inputs == before + 1);
        REQUIRE(input_sink.last_gameplay_input);
        const auto model_input = *input_sink.last_gameplay_input;
        input_sink.last_gameplay_input.reset();
        REQUIRE(luaL_dostring(fixture.lua_state(), lua_script) == LUA_OK);
        CHECK(input_sink.gameplay_inputs == before + 2);
        REQUIRE(input_sink.last_gameplay_input);
        CHECK(*input_sink.last_gameplay_input == model_input);
    };
    const auto expect_shell_parity = [&](const char* id, const char* lua_script) {
        const auto before = input_sink.shell_commands;
        input_sink.last_shell_command.reset();
        dispatch(id);
        CHECK(input_sink.shell_commands == before + 1);
        REQUIRE(input_sink.last_shell_command);
        const auto model_command = *input_sink.last_shell_command;
        input_sink.last_shell_command.reset();
        REQUIRE(luaL_dostring(fixture.lua_state(), lua_script) == LUA_OK);
        CHECK(input_sink.shell_commands == before + 2);
        REQUIRE(input_sink.last_shell_command);
        CHECK(*input_sink.last_shell_command == model_command);
    };

    expect_gameplay_parity("ui-continue", "assert(Game.ui.continue())");
    expect_gameplay_parity("ui-choose-scene", "assert(Game.ui.choose_scene('scene-enabled'))");
    expect_gameplay_parity("ui-choose-dialogue",
                           "assert(Game.ui.choose_dialogue('dialogue-enabled'))");
    expect_gameplay_parity("ui-navigate-room", "assert(Game.ui.navigate_room('exit-enabled'))");
    expect_gameplay_parity("ui-toggle-interactable", "assert(Game.ui.toggle_interactable('key'))");
    expect_gameplay_parity("ui-toggle-character", "assert(Game.ui.toggle_character('alice'))");
    expect_gameplay_parity("ui-clear-selection", "assert(Game.ui.clear_selection())");
    expect_gameplay_parity("ui-invoke-interaction",
                           "assert(Game.ui.invoke_interaction('inspect'))");

    expect_shell_parity("shell-start", "assert(Game.start())");
    expect_shell_parity("shell-pause", "assert(Game.shell.pause())");
    expect_shell_parity("shell-resume", "assert(Game.shell.resume())");
    expect_shell_parity("shell-open-settings", "assert(Game.shell.open_settings())");
    expect_shell_parity("shell-open-save", "assert(Game.shell.open_save())");
    expect_shell_parity("shell-open-load", "assert(Game.shell.open_load())");
    expect_shell_parity("shell-open-text-log", "assert(Game.shell.open_text_log())");
    expect_shell_parity("shell-open-debug", "assert(Game.shell.open_debug())");
    expect_shell_parity("shell-close", "assert(Game.shell.close())");
    expect_shell_parity("shell-return-to-title", "assert(Game.shell.return_to_title())");
    expect_shell_parity("shell-quit", "assert(Game.shell.quit())");
    expect_shell_parity("shell-save-slot", "assert(Game.shell.save(7))");
    expect_shell_parity("shell-load-manual", "assert(Game.shell.load(8))");
    expect_shell_parity("shell-load-autosave", "assert(Game.shell.load_autosave())");
    expect_shell_parity("shell-set-ui-scale", "assert(Game.shell.set_ui_scale(1.25))");
    expect_shell_parity("shell-set-text-scale", "assert(Game.shell.set_text_scale(1.5))");
    expect_shell_parity("shell-confirm", "assert(Game.shell.confirm())");
    expect_shell_parity("shell-cancel", "assert(Game.shell.cancel())");

    const auto shell_commands_before_invalid = input_sink.shell_commands;
    dispatch("shell-save-missing");
    dispatch("shell-save-invalid-type");
    dispatch("shell-save-hidden");
    dispatch("shell-load-missing-number");
    dispatch("shell-load-invalid-kind");
    dispatch("shell-load-hidden");
    dispatch("shell-load-empty");
    REQUIRE(luaL_dostring(fixture.lua_state(), "assert(not Game.shell.save(9))") == LUA_OK);
    REQUIRE(luaL_dostring(fixture.lua_state(), "assert(not Game.shell.load(9))") == LUA_OK);
    REQUIRE(luaL_dostring(fixture.lua_state(), "assert(not Game.shell.load(7))") == LUA_OK);
    CHECK(input_sink.shell_commands == shell_commands_before_invalid);
}

TEST_CASE("RuntimeUI Layout Slot Lua conversion accepts only declared persistable trees")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    auto& ui = fixture.runtime_ui();
    RecordingRuntimeUiInputSink input_sink;
    REQUIRE(fixture.initialize());
    ui.bind_input_sink(&input_sink);

    const auto instance = noveltea::core::ScopedLayoutInstanceId::create("stateful");
    REQUIRE(instance);
    const auto key = noveltea::core::MountedLayoutPresentationKey{
        noveltea::core::ScopedLayoutMountKey{instance.value()}};
    const auto owner = noveltea::core::PresentationOwner{noveltea::core::SessionPresentationOwner{
        noveltea::core::PresentationSessionId::from_number(1)}};

    noveltea::core::LayoutStateShape nested_array{
        .type = noveltea::core::LayoutStateShapeType::Array,
        .nullable = false,
        .default_value = std::nullopt,
        .items = {noveltea::core::LayoutStateShape{
            .type = noveltea::core::LayoutStateShapeType::Array,
            .nullable = false,
            .default_value = std::nullopt,
            .items = {noveltea::core::LayoutStateShape{
                .type = noveltea::core::LayoutStateShapeType::String,
                .nullable = true,
                .default_value = std::nullopt,
                .items = {},
                .fields = {}}},
            .fields = {}}},
        .fields = {}};
    ui.set_layout_mount_context(
        "state-doc",
        noveltea::RuntimeUiLayoutMountContext{
            owner,
            key,
            noveltea::core::LayoutMountOccurrenceId::from_number(7),
            {},
            {},
            nested_array,
            {{noveltea::core::LayoutStateScope::Session,
              noveltea::core::PersistableValue{noveltea::core::PersistableValue::Array{
                  noveltea::core::PersistableValue{noveltea::core::PersistableValue::Array{
                      noveltea::core::PersistableValue{std::monostate{}},
                      noveltea::core::PersistableValue{std::string("saved")}}}}}}}});

    REQUIRE(luaL_dostring(fixture.lua_state(),
                          "local m=assert(Game.mount_context('state-doc')); "
                          "local s=assert(m:state('session')); assert(s[1][1]==m.null); "
                          "assert(s[1][2]=='saved'); "
                          "assert(m:commit_state('session', {{m.null, 'ok'}}))") == LUA_OK);
    REQUIRE(input_sink.gameplay_inputs == 1);
    REQUIRE(input_sink.last_gameplay_input);
    CHECK(std::holds_alternative<noveltea::core::CommitLayoutStateInput>(
        *input_sink.last_gameplay_input));

    const auto accepted = input_sink.gameplay_inputs;
    REQUIRE(
        luaL_dostring(
            fixture.lua_state(),
            "local m=Game.mount_context('state-doc'); "
            "local sparse={[1]={'a'},[3]={'b'}}; assert(not m:commit_state('session', sparse)); "
            "local mixed={{'a'}}; mixed.x={'b'}; assert(not m:commit_state('session', mixed)); "
            "local cycle={}; cycle[1]=cycle; assert(not m:commit_state('session', cycle)); "
            "local meta=setmetatable({{'a'}}, {}); assert(not m:commit_state('session', meta)); "
            "assert(not m:commit_state('session', function() end)); "
            "assert(not m:commit_state('session', coroutine.create(function() end)))") == LUA_OK);
    CHECK(input_sink.gameplay_inputs == accepted);

    noveltea::core::LayoutStateShape object_shape{
        .type = noveltea::core::LayoutStateShapeType::Object,
        .nullable = false,
        .default_value = std::nullopt,
        .items = {},
        .fields = {
            {noveltea::core::LayoutStateObjectField{
                .id = "a",
                .required = true,
                .shape = {noveltea::core::LayoutStateShape{
                    .type = noveltea::core::LayoutStateShapeType::String,
                    .nullable = false,
                    .default_value = std::nullopt,
                    .items = {},
                    .fields = {}}}}},
            {noveltea::core::LayoutStateObjectField{
                .id = "z",
                .required = true,
                .shape = {noveltea::core::LayoutStateShape{
                    .type = noveltea::core::LayoutStateShapeType::String,
                    .nullable = false,
                    .default_value = std::nullopt,
                    .items = {},
                    .fields = {}}}}},
        }};
    ui.set_layout_mount_context("state-doc",
                                noveltea::RuntimeUiLayoutMountContext{
                                    owner,
                                    key,
                                    noveltea::core::LayoutMountOccurrenceId::from_number(7),
                                    {},
                                    {},
                                    object_shape,
                                    {}});
    input_sink.last_gameplay_input.reset();
    REQUIRE(luaL_dostring(fixture.lua_state(),
                          "local m=Game.mount_context('state-doc'); "
                          "local value={}; value.z='last'; value.a='first'; "
                          "assert(m:commit_state('session', value))") == LUA_OK);
    REQUIRE(input_sink.last_gameplay_input);
    const auto& canonical_commit =
        std::get<noveltea::core::CommitLayoutStateInput>(*input_sink.last_gameplay_input);
    const auto& canonical_object =
        std::get<noveltea::core::PersistableValue::Object>(canonical_commit.value.value);
    REQUIRE(canonical_object.size() == 2);
    CHECK(canonical_object[0].first == "a");
    CHECK(canonical_object[1].first == "z");

    const auto accepted_after_object = input_sink.gameplay_inputs;
    noveltea::core::LayoutStateShape number_shape{.type =
                                                      noveltea::core::LayoutStateShapeType::Number,
                                                  .nullable = false,
                                                  .default_value = std::nullopt,
                                                  .items = {},
                                                  .fields = {}};
    ui.set_layout_mount_context("state-doc",
                                noveltea::RuntimeUiLayoutMountContext{
                                    owner,
                                    key,
                                    noveltea::core::LayoutMountOccurrenceId::from_number(7),
                                    {},
                                    {},
                                    number_shape,
                                    {}});
    REQUIRE(luaL_dostring(fixture.lua_state(),
                          "local m=Game.mount_context('state-doc'); "
                          "assert(not m:commit_state('session', math.huge)); "
                          "assert(not m:commit_state('session', 0/0))") == LUA_OK);
    CHECK(input_sink.gameplay_inputs == accepted_after_object);
}

TEST_CASE("RmlUiHost fails primary context creation when required context initialization fails")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize_scripts_only());
    const auto presentation = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1280, 720, 1280, 720),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);

    noveltea::ui::rmlui::RmlUiHost host;
    std::size_t initializer_calls = 0;
    host.set_context_initializer([&](Rml::Context&) {
        ++initializer_calls;
        return false;
    });
    CHECK_FALSE(host.initialize({.assets = &fixture.assets(),
                                 .lua_state = fixture.lua_state(),
                                 .presentation = presentation.value(),
                                 .headless_render = true}));
    CHECK(initializer_calls == 1);
    CHECK(host.primary_context() == nullptr);
    CHECK(host.contexts().empty());
}

TEST_CASE("RmlUiHost rejects a secondary context when required context initialization fails")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize_scripts_only());
    const auto presentation = noveltea::make_presentation_metrics(
        noveltea::make_host_surface_metrics(1280, 720, 1280, 720),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);

    noveltea::ui::rmlui::RmlUiHost host;
    std::size_t initializer_calls = 0;
    host.set_context_initializer([&](Rml::Context&) {
        ++initializer_calls;
        return initializer_calls == 1;
    });
    REQUIRE(host.initialize({.assets = &fixture.assets(),
                             .lua_state = fixture.lua_state(),
                             .presentation = presentation.value(),
                             .headless_render = true}));
    REQUIRE(host.primary_context());
    REQUIRE(host.contexts().size() == 1);

    const noveltea::ui::rmlui::RmlUiHost::ContextKey secondary{
        .plane = noveltea::core::PresentationPlane::MenuOverlay,
        .composition_group = 1,
        .clock = noveltea::core::LayoutClockDomain::UnscaledPresentation,
        .input = noveltea::core::LayoutInputMode::BlockGameplay,
        .owner = noveltea::core::MountedLayoutOwner::Shell,
    };
    CHECK(host.context_for(secondary) == nullptr);
    CHECK(initializer_calls == 2);
    CHECK(host.contexts().size() == 1);
    CHECK(host.primary_context() != nullptr);
    host.shutdown();
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

    const auto direct_click = driver->click({.document_id = "gameplay", .selector = "#action"});
    CHECK(direct_click.status == noveltea::ui::rmlui::RuntimeUiPlaybackClickStatus::Dispatched);
    CHECK(direct_click.dispatched);
    CHECK(activations == 1);

    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);
    const auto click = driver->click({.document_id = "gameplay", .selector = "#action"});
    CHECK(click.status == noveltea::ui::rmlui::RuntimeUiPlaybackClickStatus::Dispatched);
    CHECK(click.dispatched);
    CHECK(click.target_id == "action");
    CHECK(click.target_tag == "button");
    CHECK(click.width > 0.0f);
    CHECK(click.height > 0.0f);
    CHECK(activations == 2);
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

TEST_CASE("RuntimeUI input sink rebinding preserves gameplay revision and shell bindings")
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
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{});

    auto* playback_driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(playback_driver);
    auto* shell_status = playback_driver->element("runtime_title", "nt-shell-status");
    REQUIRE(shell_status);
    CHECK(shell_status->GetInnerRML() == "shell-ready");

    ui.set_runtime_notification("after-rebind");
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{});

    auto* notification = playback_driver->element("runtime_game", "rt_notification");
    REQUIRE(notification);
    CHECK(playback_driver->element("runtime_game", "rt_mode") == nullptr);
    CHECK(notification->GetInnerRML() == "after-rebind");

    values.revision = 2;
    values.view.mode = "current";
    REQUIRE(ui.apply_gameplay_ui_values(values));
    values.revision = 1;
    values.view.mode = "stale";
    CHECK_FALSE(ui.apply_gameplay_ui_values(values));
    CHECK(notification->GetInnerRML() == "after-rebind");
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
    view.status = "settings-ready";
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
    auto* shell_status = playback_driver->element("runtime_settings_menu", "nt-shell-status");
    REQUIRE(ui_control);
    REQUIRE(text_control);
    REQUIRE(text_minimum);
    REQUIRE(text_maximum);
    REQUIRE(text_value);
    REQUIRE(shell_status);
    CHECK_FALSE(ui_control->IsVisible());
    CHECK(text_control->IsVisible());
    CHECK(text_minimum->GetInnerRML() == "1.1");
    CHECK(text_maximum->GetInnerRML() == "1.8");
    CHECK(text_value->GetInnerRML() == "1.4");
    CHECK(shell_status->GetInnerRML() == "settings-ready");
}

TEST_CASE("RuntimeUI built-in title and modal render and dispatch through the data model")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_title_document(ui));
    REQUIRE(RuntimeUiFacadeAccess::load_builtin_system_document(ui, "runtime_modal",
                                                                "system:/ui/menu/modal.rml"));

    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);
    ui.bind_title_document("Project <One>", "Subtitle & more", "Begin");
    noveltea::core::RuntimeShellViewState view;
    view.status = "shell <ready>";
    view.confirmation = noveltea::core::RuntimeShellConfirmation{
        .kind = noveltea::core::RuntimeShellConfirmationKind::Quit,
        .slot = std::nullopt,
        .prompt = "Quit <now>?"};
    ui.apply_runtime_shell_view(std::move(view));
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{});

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* project = driver->element("runtime_title", "nt-title-project");
    auto* subtitle = driver->element("runtime_title", "nt-title-subtitle");
    auto* start = driver->element("runtime_title", "nt-title-start");
    auto* title_status = driver->element("runtime_title", "nt-shell-status");
    auto* prompt = driver->element("runtime_modal", "nt-modal-prompt");
    REQUIRE(project);
    REQUIRE(subtitle);
    REQUIRE(start);
    REQUIRE(title_status);
    REQUIRE(prompt);
    CHECK(project->GetInnerRML() == "Project &lt;One&gt;");
    CHECK(subtitle->GetInnerRML() == "Subtitle &amp; more");
    CHECK(start->GetInnerRML() == "Begin");
    CHECK(title_status->GetInnerRML() == "shell &lt;ready&gt;");
    CHECK(prompt->GetInnerRML() == "Quit &lt;now&gt;?");

    REQUIRE(start->DispatchEvent("click", Rml::Dictionary{}));
    REQUIRE(input_sink.last_shell_command);
    CHECK(std::holds_alternative<noveltea::core::StartGameShellCommand>(
        *input_sink.last_shell_command));
}

TEST_CASE("RuntimeUI binds gameplay values to the active authored Game HUD document")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "authored-game-hud", kAuthoredGameHudDocument,
        "project://generated/layouts/authored-game-hud.rml", true));
    ui.set_system_layout_documents({{.role = noveltea::core::compiled::SystemLayoutRole::GameHud,
                                     .document_id = "authored-game-hud"}});

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "authored-room";
    REQUIRE(ui.apply_gameplay_ui_values(values));
    ui.set_runtime_notification("authored-notification");

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* mode = driver->element("authored-game-hud", "rt_mode");
    auto* notification = driver->element("authored-game-hud", "rt_notification");
    auto* background = driver->element("authored-game-hud", "rt_background_image");
    REQUIRE(mode);
    REQUIRE(notification);
    REQUIRE(background);
    REQUIRE(driver->document("authored-game-hud"));
    REQUIRE(driver->document("authored-game-hud")->GetContext());
    driver->document("authored-game-hud")->GetContext()->Update();
    CHECK(mode->GetInnerRML() == "authored-room");
    CHECK(notification->GetInnerRML() == "authored-notification");
    CHECK(background->GetInnerRML().find("sentinel") != std::string::npos);
    CHECK(driver->document("runtime_game") == nullptr);

    REQUIRE(ui.reload_documents_and_styles());
    mode = driver->element("authored-game-hud", "rt_mode");
    notification = driver->element("authored-game-hud", "rt_notification");
    REQUIRE(mode);
    REQUIRE(notification);
    REQUIRE(driver->document("authored-game-hud")->GetContext());
    driver->document("authored-game-hud")->GetContext()->Update();
    CHECK(mode->GetInnerRML() == "authored-room");
    CHECK(notification->GetInnerRML() == "authored-notification");
    background = driver->element("authored-game-hud", "rt_background_image");
    REQUIRE(background);
    CHECK(background->GetInnerRML().find("sentinel") != std::string::npos);
}

TEST_CASE("RuntimeUI renders Phase 3 gameplay collections in an ordinary non-system Layout")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "binder-characterization", kBinderCharacterizationDocument,
        "preview://binder-characterization.rml", true));

    const auto scene = noveltea::core::SceneId::create("scene");
    const auto scene_step = noveltea::core::SceneStepId::create("step");
    const auto scene_choice = noveltea::core::SceneChoiceOptionId::create("scene-enabled");
    const auto scene_choice_disabled =
        noveltea::core::SceneChoiceOptionId::create("scene-disabled");
    const auto character = noveltea::core::CharacterId::create("alice");
    const auto pose = noveltea::core::CharacterPoseId::create("idle");
    const auto expression = noveltea::core::CharacterExpressionId::create("smile");
    const auto room = noveltea::core::RoomId::create("room");
    const auto target = noveltea::core::RoomId::create("target");
    const auto north = noveltea::core::RoomExitId::create("north");
    const auto south = noveltea::core::RoomExitId::create("south-disabled");
    const auto placement = noveltea::core::RoomPlacementId::create("placement");
    const auto interactable = noveltea::core::InteractableId::create("key");
    const auto hidden_interactable = noveltea::core::InteractableId::create("hidden-key");
    const auto player_inventory = noveltea::core::InventoryId::create("player");
    const auto verb = noveltea::core::VerbId::create("inspect");
    const auto disabled_verb = noveltea::core::VerbId::create("use");
    const auto target_slot = noveltea::core::VerbSlotId::create("target");
    const auto map = noveltea::core::MapId::create("map");
    REQUIRE(scene);
    REQUIRE(scene_step);
    REQUIRE(scene_choice);
    REQUIRE(scene_choice_disabled);
    REQUIRE(character);
    REQUIRE(pose);
    REQUIRE(expression);
    REQUIRE(room);
    REQUIRE(target);
    REQUIRE(north);
    REQUIRE(south);
    REQUIRE(placement);
    REQUIRE(interactable);
    REQUIRE(hidden_interactable);
    REQUIRE(player_inventory);
    REQUIRE(verb);
    REQUIRE(disabled_verb);
    REQUIRE(target_slot);
    REQUIRE(map);

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "scene";
    values.view.can_continue = true;
    values.view.scene = noveltea::core::SceneView{
        .scene = scene.value(),
        .actors = {{.key = noveltea::core::CharacterActorKey{character.value()},
                    .character = character.value(),
                    .pose = pose.value(),
                    .expression = expression.value(),
                    .visible = true,
                    .presentation_complete = true}},
        .choice = noveltea::core::SceneChoiceState{
            .scene = scene.value(),
            .step = scene_step.value(),
            .options = {
                {.option = scene_choice.value(), .label = "Open <door>", .enabled = true},
                {.option = scene_choice_disabled.value(), .label = "Locked", .enabled = false}}}};
    values.view.room = noveltea::core::RoomView{
        .room = room.value(),
        .description = "Room body",
        .description_markup = noveltea::core::TextMarkup::Plain,
        .placements = {{.placement = placement.value(),
                        .label = "Brass <Key>",
                        .occupants = {{.subject =
                                           noveltea::core::compiled::InteractableInteractionSubject{
                                               interactable.value()},
                                       .enabled = true,
                                       .visible = true},
                                      {.subject =
                                           noveltea::core::compiled::InteractableInteractionSubject{
                                               hidden_interactable.value()},
                                       .enabled = true,
                                       .visible = false}}}},
        .exits = {{north.value(), target.value(),
                   noveltea::core::compiled::RoomExitDirection::North, "North Hall", true},
                  {south.value(), target.value(),
                   noveltea::core::compiled::RoomExitDirection::South, "Blocked South", false}},
        .controls = {{verb.value(), "Inspect", {target_slot.value()}, false, true},
                     {disabled_verb.value(), "Use", {target_slot.value()}, false, false}}};
    values.view.inventory.items = {
        {.interactable = interactable.value(),
         .inventory = {noveltea::core::compiled::ProjectInventoryOwner{}, player_inventory.value()},
         .effective_room = std::nullopt,
         .display_name = "Inventory Key",
         .presentation = {.hotspots = noveltea::core::compiled::CustomInteractableHotspots{}},
         .enabled = true,
         .visible = true},
        {.interactable = hidden_interactable.value(),
         .inventory = {noveltea::core::compiled::ProjectInventoryOwner{}, player_inventory.value()},
         .effective_room = std::nullopt,
         .display_name = "Hidden",
         .presentation = {.hotspots = noveltea::core::compiled::CustomInteractableHotspots{}},
         .enabled = true,
         .visible = false}};
    values.view.selected_subjects = {
        noveltea::core::compiled::InteractableInteractionSubject{interactable.value()}};
    values.view.interaction = noveltea::core::InteractionView{
        .verb = verb.value(), .notification = "Interaction fallback"};
    values.view.maps.push_back(
        noveltea::core::MapView{.map = map.value(),
                                .initial_mode = noveltea::core::compiled::InitialMapMode::Minimap,
                                .title = "Map <Title>"});
    REQUIRE(ui.apply_gameplay_ui_values(values));

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* document = driver->document("binder-characterization");
    REQUIRE(document);
    REQUIRE(document->GetContext());
    document->GetContext()->Update();
    CHECK(driver->element("binder-characterization", "rt_mode")->GetInnerRML() == "scene");
    CHECK(driver->element("binder-characterization", "rt_title")->GetInnerRML().empty());
    CHECK(driver->element("binder-characterization", "rt_notification")->GetInnerRML() ==
          "Interaction fallback");
    Rml::ElementList continue_buttons;
    document->GetElementsByClassName(continue_buttons, "continue");
    REQUIRE(continue_buttons.size() == 1);
    CHECK(continue_buttons.front()->IsVisible());
    Rml::ElementList options;
    document->GetElementsByClassName(options, "model-option");
    REQUIRE(options.size() == 3);
    const auto find_inner = [](const Rml::ElementList& elements, std::string_view inner) {
        const auto found = std::find_if(elements.begin(), elements.end(), [&](const auto* element) {
            return element->GetInnerRML() == inner;
        });
        return found == elements.end() ? nullptr : *found;
    };
    auto* enabled_option = find_inner(options, "Open &lt;door&gt;");
    auto* disabled_option = find_inner(options, "Locked");
    REQUIRE(enabled_option);
    REQUIRE(disabled_option);
    CHECK(enabled_option->IsVisible());
    CHECK_FALSE(enabled_option->HasAttribute("disabled"));
    CHECK(disabled_option->HasAttribute("disabled"));
    CHECK(disabled_option->IsClassSet("disabled"));
    CHECK(driver->element("binder-characterization", "rt_text_panel")
              ->GetComputedValues()
              .pointer_events() == Rml::Style::PointerEvents::Auto);
    Rml::ElementList actors;
    document->GetElementsByClassName(actors, "model-actor");
    REQUIRE(actors.size() == 2);
    const auto actor = std::find_if(actors.begin(), actors.end(), [](const Rml::Element* element) {
        return element->GetAttribute<Rml::String>("data-character-id", "") == "alice";
    });
    REQUIRE(actor != actors.end());
    CHECK((*actor)->GetAttribute<Rml::String>("data-slot-id", "") == "alice");
    CHECK((*actor)->GetAttribute<Rml::String>("data-presentation-complete", "") == "1");

    Rml::ElementList exits;
    document->GetElementsByClassName(exits, "model-exit");
    REQUIRE(exits.size() == 3);
    const auto find_exit = [&](std::string_view id) {
        const auto found =
            std::find_if(exits.begin(), exits.end(), [&](const Rml::Element* element) {
                return element->GetAttribute<Rml::String>("data-exit-id", "") == id;
            });
        return found == exits.end() ? nullptr : *found;
    };
    auto* north_button = find_exit("north");
    auto* south_button = find_exit("south-disabled");
    REQUIRE(north_button);
    REQUIRE(south_button);
    CHECK(north_button->IsVisible());
    CHECK(north_button->GetInnerRML() == "N North Hall");
    CHECK_FALSE(south_button->IsVisible());
    CHECK(driver->element("binder-characterization", "rt_navigation")->IsVisible());

    Rml::ElementList objects;
    document->GetElementsByClassName(objects, "model-object");
    REQUIRE(objects.size() == 2);
    auto* room_object = find_inner(objects, "Brass &lt;Key&gt;");
    REQUIRE(room_object);
    CHECK(room_object->IsClassSet("selected"));
    Rml::ElementList inventory;
    document->GetElementsByClassName(inventory, "model-inventory");
    REQUIRE(inventory.size() == 2);
    auto* inventory_item = find_inner(inventory, "Inventory Key");
    REQUIRE(inventory_item);
    CHECK(inventory_item->IsClassSet("selected"));
    Rml::ElementList actions;
    document->GetElementsByClassName(actions, "model-action");
    REQUIRE(actions.size() == 3);
    auto* inspect_action = find_inner(actions, "Inspect");
    auto* use_action = find_inner(actions, "Use");
    REQUIRE(inspect_action);
    REQUIRE(use_action);
    CHECK(use_action->HasAttribute("disabled"));
    CHECK(driver->element("binder-characterization", "rt_objects_group")->IsVisible());
    CHECK(driver->element("binder-characterization", "rt_inventory_group")->IsVisible());
    CHECK(driver->element("binder-characterization", "rt_actions_group")->IsVisible());
    CHECK(driver->element("binder-characterization", "rt_interaction_dock")->IsVisible());

    ui.set_runtime_notification("Output notification");
    document->GetContext()->Update();
    CHECK(driver->element("binder-characterization", "rt_notification")->GetInnerRML() ==
          "Output notification");

    values.revision = 2;
    values.view.scene.reset();
    const auto dialogue = noveltea::core::DialogueId::create("dialogue");
    const auto block = noveltea::core::DialogueBlockId::create("block");
    const auto edge = noveltea::core::DialogueEdgeId::create("edge");
    REQUIRE(dialogue);
    REQUIRE(block);
    REQUIRE(edge);
    values.view.dialogue = noveltea::core::DialogueView{
        .dialogue = dialogue.value(),
        .choice = noveltea::core::DialogueChoiceState{
            .dialogue = dialogue.value(),
            .block = block.value(),
            .options = {{.edge = edge.value(), .label = "Dialogue choice", .enabled = true}}}};
    values.view.can_continue = false;
    values.view.room->description.clear();
    REQUIRE(ui.apply_gameplay_ui_values(values));
    document->GetContext()->Update();
    options.clear();
    document->GetElementsByClassName(options, "model-option");
    REQUIRE(options.size() == 2);
    REQUIRE(find_inner(options, "Dialogue choice"));
    CHECK_FALSE(continue_buttons.front()->IsVisible());
}

TEST_CASE("RuntimeUI renders Text Log entries declaratively from the NovelTea data model")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "text-log-model", kTextLogDataModelDocument, "preview://text-log-model.rml", true));

    const auto speaker = noveltea::core::CharacterId::create("alice");
    REQUIRE(speaker);
    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.text_log.entries = {
        noveltea::core::TextLogEntry{.kind = noveltea::core::TextLogEntryKind::Line,
                                     .origin = noveltea::core::SystemTextLogOrigin{},
                                     .speaker = speaker.value(),
                                     .text = "[b]First <unsafe>[/b]",
                                     .markup = noveltea::core::TextMarkup::ActiveText},
        noveltea::core::TextLogEntry{.kind = noveltea::core::TextLogEntryKind::Choice,
                                     .origin = noveltea::core::SystemTextLogOrigin{},
                                     .text = "Second",
                                     .markup = noveltea::core::TextMarkup::Plain},
        noveltea::core::TextLogEntry{.kind = noveltea::core::TextLogEntryKind::Notification,
                                     .origin = noveltea::core::SystemTextLogOrigin{},
                                     .text = "Third",
                                     .markup = noveltea::core::TextMarkup::Plain}};
    REQUIRE(ui.apply_gameplay_ui_values(values));

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* document = driver->document("text-log-model");
    REQUIRE(document);
    REQUIRE(document->GetContext());
    document->GetContext()->Update();

    auto* empty = driver->element("text-log-model", "text-log-empty");
    REQUIRE(empty);
    CHECK_FALSE(empty->IsVisible());

    Rml::ElementList entries;
    document->GetElementsByClassName(entries, "text-log-entry");
    const auto find_entry = [&](std::string_view sequence) {
        const auto found = std::find_if(entries.begin(), entries.end(), [&](Rml::Element* element) {
            return element->GetAttribute<Rml::String>("data-sequence", "") == sequence;
        });
        return found == entries.end() ? nullptr : *found;
    };
    auto* first = find_entry("0");
    auto* second = find_entry("1");
    auto* third = find_entry("2");
    REQUIRE(first);
    REQUIRE(second);
    REQUIRE(third);
    CHECK(first->GetAttribute<Rml::String>("data-kind", "") == "line");
    CHECK(second->GetAttribute<Rml::String>("data-kind", "") == "choice");
    CHECK(third->GetAttribute<Rml::String>("data-kind", "") == "notification");
    CHECK(first->GetParentNode() == second->GetParentNode());
    CHECK(second->GetParentNode() == third->GetParentNode());
    CHECK(first->GetNextSibling() == second);
    CHECK(second->GetNextSibling() == third);

    Rml::ElementList speakers;
    first->GetElementsByClassName(speakers, "text-log-speaker");
    REQUIRE(speakers.size() == 1);
    CHECK(speakers.front()->IsVisible());
    CHECK(speakers.front()->GetInnerRML() == "alice");
    speakers.clear();
    second->GetElementsByClassName(speakers, "text-log-speaker");
    REQUIRE(speakers.size() == 1);
    CHECK_FALSE(speakers.front()->IsVisible());

    Rml::ElementList bodies;
    first->GetElementsByClassName(bodies, "text-log-body");
    REQUIRE(bodies.size() == 1);
    const auto first_body = bodies.front()->GetInnerRML();
    CHECK(first_body.find("nt-active-text__run--bold") != std::string::npos);
    Rml::ElementList unsafe_elements;
    bodies.front()->GetElementsByTagName(unsafe_elements, "unsafe");
    CHECK(unsafe_elements.empty());

    values.revision = 2;
    values.view.text_log.entries.clear();
    REQUIRE(ui.apply_gameplay_ui_values(values));
    document->GetContext()->Update();
    CHECK(empty->IsVisible());
    entries.clear();
    document->GetElementsByClassName(entries, "text-log-entry");
    CHECK(std::none_of(entries.begin(), entries.end(), [](Rml::Element* element) {
        return element->HasAttribute("data-sequence");
    }));
}

TEST_CASE("RuntimeUI isolates ActiveText and provisional Map updates to supported system roles")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "component-game-hud", kCustomComponentScopeDocument,
        "project://generated/layouts/component-game-hud.rml", true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "component-text-log", kCustomComponentScopeDocument,
        "project://generated/layouts/component-text-log.rml", true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "component-arbitrary", kCustomComponentScopeDocument,
        "project://generated/layouts/component-arbitrary.rml", true));
    ui.set_system_layout_documents({{.role = noveltea::core::compiled::SystemLayoutRole::GameHud,
                                     .document_id = "component-game-hud"},
                                    {.role = noveltea::core::compiled::SystemLayoutRole::TextLog,
                                     .document_id = "component-text-log"}});

    const auto map_id = noveltea::core::MapId::create("phase-six-map");
    const auto room_id = noveltea::core::RoomId::create("room");
    REQUIRE(map_id);
    REQUIRE(room_id);
    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.can_continue = true;
    values.view.maps.push_back(
        noveltea::core::MapView{.map = map_id.value(),
                                .initial_mode = noveltea::core::compiled::InitialMapMode::Minimap,
                                .current_room = room_id.value(),
                                .title = "Scoped map"});
    REQUIRE(ui.apply_gameplay_ui_values(values));

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* game_active = driver->element("component-game-hud", "active");
    auto* text_log_active = driver->element("component-text-log", "active");
    auto* arbitrary_active = driver->element("component-arbitrary", "active");
    auto* game_map = driver->element("component-game-hud", "map");
    auto* text_log_map = driver->element("component-text-log", "map");
    auto* arbitrary_map = driver->element("component-arbitrary", "map");
    REQUIRE(game_active);
    REQUIRE(text_log_active);
    REQUIRE(arbitrary_active);
    REQUIRE(game_map);
    REQUIRE(text_log_map);
    REQUIRE(arbitrary_map);

    CHECK(game_active->HasAttribute("data-awaiting-continue"));
    CHECK_FALSE(text_log_active->HasAttribute("data-awaiting-continue"));
    CHECK_FALSE(arbitrary_active->HasAttribute("data-awaiting-continue"));
    CHECK(game_map->GetInnerRML().find("Scoped map") != std::string::npos);
    CHECK(text_log_map->GetInnerRML().find("Scoped map") != std::string::npos);
    CHECK(arbitrary_map->GetInnerRML().empty());

    ui.clear_gameplay_ui_values();
    CHECK(game_map->GetInnerRML().find("Scoped map") != std::string::npos);
    CHECK(text_log_map->GetInnerRML().find("Scoped map") != std::string::npos);
}

TEST_CASE("RuntimeUI authored system Layouts opt into model state without role-specific injection")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "authored-title", kAuthoredTitleDocument,
        "project://generated/layouts/authored-title.rml", true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "authored-settings", kAuthoredSettingsDocument,
        "project://generated/layouts/authored-settings.rml", true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "authored-save", kAuthoredSaveDocument, "project://generated/layouts/authored-save.rml",
        true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "authored-load", kAuthoredLoadDocument, "project://generated/layouts/authored-load.rml",
        true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "authored-modal", kAuthoredModalDocument,
        "project://generated/layouts/authored-modal.rml", true));
    ui.set_system_layout_documents(
        {{.role = noveltea::core::compiled::SystemLayoutRole::Title,
          .document_id = "authored-title"},
         {.role = noveltea::core::compiled::SystemLayoutRole::SettingsMenu,
          .document_id = "authored-settings"},
         {.role = noveltea::core::compiled::SystemLayoutRole::SaveMenu,
          .document_id = "authored-save"},
         {.role = noveltea::core::compiled::SystemLayoutRole::LoadMenu,
          .document_id = "authored-load"},
         {.role = noveltea::core::compiled::SystemLayoutRole::Modal,
          .document_id = "authored-modal"}});

    ui.bind_title_document("Authored Project", "Authored subtitle", "Begin");
    const auto settings = noveltea::core::RuntimeUserSettings::create(1.25, 1.5);
    REQUIRE(settings);
    noveltea::core::RuntimeShellViewState view;
    view.settings = settings.value();
    view.accessibility = {
        .ui_scale = {.enabled = true, .minimum = 0.75, .maximum = 1.5},
        .text_scale = {.enabled = true, .minimum = 1.0, .maximum = 2.0},
    };
    view.checkpoint = noveltea::core::CheckpointRuntimeObservation{
        .readiness = {noveltea::core::CheckpointReadinessRevision::from_number(8), {}},
        .presentation = {noveltea::core::CheckpointStatusRevision::from_number(4),
                         {},
                         std::nullopt},
        .retained_revision = noveltea::core::SaveCheckpointRevision::from_number(3),
        .replay_distance = {2, 1, std::chrono::milliseconds{350}},
        .thumbnail_available = true,
        .thumbnail_capture_pending = false};
    const auto metadata = noveltea::core::SaveCheckpointMetadata{
        .save_format_version = 7,
        .project = noveltea::core::ProjectId::create("project").value(),
        .project_version = "9C",
        .save_contract = "sc1:0123456789abcdef0123456789abcdef",
        .play_time = std::chrono::milliseconds{3210},
        .generations = {}};
    const auto thumbnail = noveltea::core::SaveCheckpointThumbnail{
        .encoding = noveltea::core::SaveCheckpointThumbnailEncoding::Png,
        .width = 1,
        .height = 1,
        .bytes = "\x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52"
                 "\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02"
                 "\x00\x00\x00\x0b\x49\x44\x41\x54\x78\xda\x63\x64\xf8\x0f\x00\x01\x05"
                 "\x01\x01\x27\x18\xe3\x66\x00\x00\x00\x00\x49\x45\x4e\x44\xae\x42\x60"
                 "\x82"};
    view.slots.push_back({.slot = noveltea::core::TypedSaveSlotId::autosave(),
                          .occupied = true,
                          .metadata = metadata,
                          .thumbnail = thumbnail});
    view.slots.push_back({.slot = noveltea::core::TypedSaveSlotId::manual(2),
                          .occupied = true,
                          .metadata = metadata,
                          .thumbnail = thumbnail});
    view.slots.push_back({.slot = noveltea::core::TypedSaveSlotId::manual(3), .occupied = false});
    view.confirmation = noveltea::core::RuntimeShellConfirmation{
        .kind = noveltea::core::RuntimeShellConfirmationKind::Quit,
        .slot = std::nullopt,
        .prompt = "Quit the authored project?"};
    view.status = "authored-shell-ready";
    ui.apply_runtime_shell_view(view);
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{});

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    REQUIRE(driver->element("authored-title", "project-title"));
    CHECK(driver->element("authored-title", "project-title")->GetInnerRML() == "Authored Project");
    CHECK(driver->element("authored-title", "project-subtitle")->GetInnerRML() ==
          "Authored subtitle");
    CHECK(driver->element("authored-title", "project-start")->GetInnerRML() == "Begin");
    CHECK(driver->element("authored-title", "shell-status")->GetInnerRML() ==
          "authored-shell-ready");
    CHECK(driver->element("authored-settings", "nt-settings-ui-scale")->GetInnerRML().empty());
    CHECK(driver->element("authored-settings", "nt-settings-text-scale")->GetInnerRML().empty());
    CHECK(driver->element("authored-settings", "nt-shell-status")->GetInnerRML().empty());
    const auto checkpoint_summary =
        driver->element("authored-save", "nt-checkpoint-summary")->GetInnerRML();
    CHECK(checkpoint_summary == "Ready to capture · retained 3 · replay distance 2 structural / 1 "
                                "time / 350 ms · thumbnail available");
    const auto save_slots = driver->element("authored-save", "nt-save-slots")->GetInnerRML();
    CHECK(save_slots.find("Slot 2") != std::string::npos);
    CHECK(save_slots.find("Play time 3210 ms · version 9C") != std::string::npos);
    CHECK(save_slots.find("nt-save-thumbnail") != std::string::npos);
    CHECK(save_slots.find("project:/generated/shell/slot-2-thumbnail-") != std::string::npos);
    CHECK(save_slots.find("shell_save_slot(slot.number)") != std::string::npos);
    CHECK(save_slots.find("Slot 3") != std::string::npos);
    CHECK(save_slots.find("No thumbnail") != std::string::npos);
    Rml::ElementList save_slot_sections;
    driver->document("authored-save")->GetElementsByClassName(save_slot_sections, "nt-save-slot");
    const auto find_slot_section = [](const Rml::ElementList& sections, std::string_view label) {
        const auto found = std::find_if(sections.begin(), sections.end(), [&](const auto* section) {
            return section->GetInnerRML().find(label) != std::string::npos;
        });
        return found == sections.end() ? nullptr : *found;
    };
    auto* save_autosave = find_slot_section(save_slot_sections, "Autosave");
    auto* save_manual = find_slot_section(save_slot_sections, "Slot 2");
    REQUIRE(save_autosave);
    REQUIRE(save_manual);
    CHECK_FALSE(save_autosave->IsVisible());
    CHECK(save_manual->IsVisible());
    const auto load_slots = driver->element("authored-load", "nt-save-slots")->GetInnerRML();
    CHECK(load_slots.find("Autosave") != std::string::npos);
    CHECK(load_slots.find("shell_load_slot(slot.kind, slot.number)") != std::string::npos);
    const auto empty_slot = load_slots.find("Slot 3");
    REQUIRE(empty_slot != std::string::npos);
    CHECK(load_slots.find("data-if=\"slot.occupied\"", empty_slot) != std::string::npos);
    Rml::ElementList load_slot_sections;
    driver->document("authored-load")->GetElementsByClassName(load_slot_sections, "nt-save-slot");
    auto* load_empty = find_slot_section(load_slot_sections, "Slot 3");
    REQUIRE(load_empty);
    Rml::ElementList empty_load_buttons;
    load_empty->GetElementsByTagName(empty_load_buttons, "button");
    REQUIRE(empty_load_buttons.size() == 1);
    CHECK_FALSE(empty_load_buttons.front()->IsVisible());

    const auto find_slot_thumbnail = [](const Rml::ElementList& images) {
        const auto found =
            std::find_if(images.begin(), images.end(), [](const Rml::Element* image) {
                const auto source = image->GetAttribute<Rml::String>("src", "");
                return source.find("project:/generated/shell/slot-2-thumbnail-") == 0;
            });
        return found == images.end() ? nullptr : *found;
    };
    Rml::ElementList save_thumbnails;
    driver->document("authored-save")->GetElementsByClassName(save_thumbnails, "nt-save-thumbnail");
    auto* visible_thumbnail = find_slot_thumbnail(save_thumbnails);
    REQUIRE(visible_thumbnail);
    const auto first_thumbnail_url = visible_thumbnail->GetAttribute<Rml::String>("src", "");
    CHECK(first_thumbnail_url.find("project:/generated/shell/slot-2-thumbnail-") == 0);

    REQUIRE(view.slots[1].thumbnail);
    view.slots[1].thumbnail->bytes += "-refreshed";
    ui.apply_runtime_shell_view(view);
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{});
    save_thumbnails.clear();
    driver->document("authored-save")->GetElementsByClassName(save_thumbnails, "nt-save-thumbnail");
    auto* refreshed_thumbnail = find_slot_thumbnail(save_thumbnails);
    REQUIRE(refreshed_thumbnail);
    const auto refreshed_thumbnail_url = refreshed_thumbnail->GetAttribute<Rml::String>("src", "");
    CHECK(refreshed_thumbnail_url.find("project:/generated/shell/slot-2-thumbnail-") == 0);
    CHECK(refreshed_thumbnail_url != first_thumbnail_url);
    CHECK(driver->element("authored-modal", "nt-modal-prompt")->GetInnerRML().empty());
    CHECK(driver->element("authored-modal", "nt-shell-status")->GetInnerRML().empty());
}

TEST_CASE("RuntimeUI delegates ActiveText playback snapshot and completion to its presenter")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_runtime_document(ui));
    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);

    const auto room = noveltea::core::RoomId::create("room");
    REQUIRE(room);
    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "room";
    values.view.can_continue = true;
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

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    const auto click = driver->click({.document_id = "runtime_game", .selector = "#rt_body"});
    CHECK(click.status == noveltea::ui::rmlui::RuntimeUiPlaybackClickStatus::Dispatched);
    CHECK(click.dispatched);

    values.revision = 2;
    values.view = {};
    REQUIRE(ui.apply_gameplay_ui_values(values));
    ui.begin_frame(
        noveltea::core::RuntimeClockUpdate{.gameplay_delta = std::chrono::milliseconds(10),
                                           .gameplay_time = std::chrono::milliseconds(2010)});
    CHECK(ui.active_text_presentation_phase() == noveltea::core::ActiveTextPresentationPhase::Fade);
}

TEST_CASE("built-in Game HUD navigation button submits the selected Room exit")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();
    REQUIRE(RuntimeUiFacadeAccess::load_runtime_document(ui));

    RecordingRuntimeUiInputSink input_sink;
    ui.bind_input_sink(&input_sink);
    const auto room = noveltea::core::RoomId::create("start");
    const auto target = noveltea::core::RoomId::create("hall");
    const auto exit = noveltea::core::RoomExitId::create("north-exit");
    const auto northwest_exit = noveltea::core::RoomExitId::create("northwest-exit");
    const auto north_exit = noveltea::core::RoomExitId::create("north-compass-exit");
    const auto northeast_exit = noveltea::core::RoomExitId::create("northeast-exit");
    REQUIRE(room);
    REQUIRE(target);
    REQUIRE(exit);
    REQUIRE(northwest_exit);
    REQUIRE(north_exit);
    REQUIRE(northeast_exit);

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "room";
    values.view.can_continue = true;
    values.view.room = noveltea::core::RoomView{
        .room = *room.value_if(),
        .description = "Start room.",
        .exits = {
            {*northwest_exit.value_if(), *target.value_if(),
             noveltea::core::compiled::RoomExitDirection::Northwest, "Northwest", true},
            {*north_exit.value_if(), *target.value_if(),
             noveltea::core::compiled::RoomExitDirection::North, "North", true},
            {*northeast_exit.value_if(), *target.value_if(),
             noveltea::core::compiled::RoomExitDirection::Northeast, "Northeast", true},
            {*exit.value_if(), *target.value_if(),
             noveltea::core::compiled::RoomExitDirection::Southwest, "Southwest", true},
        }};
    REQUIRE(ui.apply_gameplay_ui_values(values));
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{});

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* document = driver->document("runtime_game");
    REQUIRE(document);
    const auto find_navigation_button = [&](std::string_view direction) -> Rml::Element* {
        Rml::ElementList buttons;
        document->GetElementsByClassName(buttons, "nav-slot-" + std::string(direction));
        return buttons.empty() ? nullptr : buttons.front();
    };
    auto* northwest_button = find_navigation_button("northwest");
    auto* north_button = find_navigation_button("north");
    auto* northeast_button = find_navigation_button("northeast");
    REQUIRE(northwest_button);
    REQUIRE(north_button);
    REQUIRE(northeast_button);
    const auto northwest_offset = northwest_button->GetAbsoluteOffset(Rml::BoxArea::Content);
    const auto north_offset = north_button->GetAbsoluteOffset(Rml::BoxArea::Content);
    const auto northeast_offset = northeast_button->GetAbsoluteOffset(Rml::BoxArea::Content);
    CHECK(northwest_offset.x < north_offset.x);
    CHECK(north_offset.x < northeast_offset.x);
    CHECK(northwest_offset.y == north_offset.y);
    CHECK(north_offset.y == northeast_offset.y);

    Rml::ElementList navigation_buttons;
    document->GetElementsByClassName(navigation_buttons, "nav-slot-southwest");
    REQUIRE(navigation_buttons.size() == 1);
    auto* navigation_button = navigation_buttons.front();
    const auto offset = navigation_button->GetAbsoluteOffset(Rml::BoxArea::Content);
    const auto size = navigation_button->GetBox().GetSize(Rml::BoxArea::Content);
    REQUIRE(size.x > 0.0f);
    REQUIRE(size.y > 0.0f);

    auto* text_panel = document->GetElementById("rt_text_panel");
    REQUIRE(text_panel);
    const auto text_offset = text_panel->GetAbsoluteOffset(Rml::BoxArea::Border);
    const auto text_size = text_panel->GetBox().GetSize(Rml::BoxArea::Border);
    CHECK(text_offset.x + text_size.x <= offset.x);

    auto* active_text = document->GetElementById("rt_body");
    REQUIRE(active_text);
    const auto active_text_offset = active_text->GetAbsoluteOffset(Rml::BoxArea::Border);
    const auto active_text_size = active_text->GetBox().GetSize(Rml::BoxArea::Border);
    CHECK(active_text_offset.x >= text_offset.x);
    CHECK(active_text_offset.x + active_text_size.x <= text_offset.x + text_size.x);
    CHECK(text_panel->GetComputedValues().pointer_events() == Rml::Style::PointerEvents::Auto);

    values.revision = 2;
    values.view.can_continue = false;
    REQUIRE(ui.apply_gameplay_ui_values(values));
    ui.begin_frame(noveltea::core::RuntimeClockUpdate{});
    CHECK(text_panel->GetComputedValues().pointer_events() == Rml::Style::PointerEvents::None);
    const noveltea::PresentationTransform transform{
        noveltea::make_presentation_metrics(
            noveltea::make_host_surface_metrics(1280, 720, 1280, 720),
            {.reference = {.size = {1920, 1080}}})
            .value()};
    const auto host_point =
        transform.reference_to_host_logical({offset.x + size.x * 0.5f, offset.y + size.y * 0.5f});

    SDL_Event motion{};
    motion.type = SDL_EVENT_MOUSE_MOTION;
    motion.motion.x = host_point.x;
    motion.motion.y = host_point.y;
    (void)ui.process_event(motion);
    CHECK(navigation_button->IsPseudoClassSet("hover"));

    SDL_Event press{};
    press.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
    press.button.button = SDL_BUTTON_LEFT;
    press.button.x = host_point.x;
    press.button.y = host_point.y;
    (void)ui.process_event(press);
    press.type = SDL_EVENT_MOUSE_BUTTON_UP;
    const auto released = ui.process_event(press);

    CHECK(input_sink.layout_events == 3);
    CHECK(input_sink.last_layout_owner == noveltea::core::MountedLayoutOwner::Gameplay);
    CHECK(input_sink.gameplay_inputs == 0);
    REQUIRE(released.runtime_inputs.size() == 1);
    const auto* navigation =
        std::get_if<noveltea::core::NavigateRoomInput>(&released.runtime_inputs.front());
    REQUIRE(navigation);
    CHECK(navigation->exit == *exit.value_if());
}

TEST_CASE("RuntimeUI DPR-only resize rerasterizes native text without replacing document state")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    auto test_system_assets = std::make_shared<noveltea::assets::MemoryAssetSource>();
    std::ifstream font_file(std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                                "engine/assets/system/fonts/LiberationSans.ttf",
                            std::ios::binary);
    REQUIRE(font_file);
    noveltea::assets::AssetBytes font_bytes(std::istreambuf_iterator<char>(font_file), {});
    REQUIRE_FALSE(font_bytes.empty());
    test_system_assets->add("fonts/LiberationSans.ttf", std::move(font_bytes),
                            "ActiveText scale integration font");
    auto system_sources = fixture.assets().replace_namespace("system", {});
    system_sources.insert(system_sources.begin(), std::move(test_system_assets));
    (void)fixture.assets().replace_namespace("system", std::move(system_sources));
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

TEST_CASE("RuntimeUI applies universal RmlUi baselines below path and memory document styles")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
    auto& ui = fixture.runtime_ui();

    RuntimeUiFacadeAccess::set_preview_virtual_file(ui, "project:/baseline/path.rml",
                                                    kBaselineDocument);
    REQUIRE(RuntimeUiFacadeAccess::load_document(ui, "baseline-path", "project:/baseline/path.rml",
                                                 true));
    REQUIRE(RuntimeUiFacadeAccess::load_document_from_memory(
        ui, "baseline-memory", kBaselineOverrideDocument, "preview://baseline-memory.rml", true));
    ui.begin_frame({});

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);

    auto* paragraph = driver->element("baseline-path", "baseline-paragraph");
    auto* body = driver->element("baseline-path", "baseline-body");
    auto* button = driver->element("baseline-path", "baseline-button");
    REQUIRE(paragraph);
    REQUIRE(body);
    REQUIRE(button);
    CHECK(paragraph->GetComputedValues().display() == Rml::Style::Display::Block);
    CHECK(body->GetComputedValues().color() == Rml::Colourb(248, 250, 252, 255));
    CHECK(button->GetComputedValues().background_color() == Rml::Colourb(51, 65, 85, 255));

    auto* override_paragraph = driver->element("baseline-memory", "override-paragraph");
    auto* override_body = driver->element("baseline-memory", "override-body");
    auto* override_button = driver->element("baseline-memory", "override-button");
    REQUIRE(override_paragraph);
    REQUIRE(override_body);
    REQUIRE(override_button);
    CHECK(override_paragraph->GetComputedValues().display() == Rml::Style::Display::InlineBlock);
    CHECK(override_body->GetComputedValues().color() == Rml::Colourb(1, 2, 3, 255));
    CHECK(override_button->GetComputedValues().background_color() == Rml::Colourb(4, 5, 6, 255));

    RuntimeUiFacadeAccess::clear_preview_virtual_files(ui);
}

TEST_CASE("RuntimeUI refuses document loads when required baseline assets are unavailable")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = false});
    REQUIRE(fixture.initialize());
    CHECK_FALSE(RuntimeUiFacadeAccess::load_document_from_memory(
        fixture.runtime_ui(), "missing-baseline", kBaselineDocument,
        "preview://missing-baseline.rml", true));
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
