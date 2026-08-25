#include "noveltea/presentation/runtime_layout_manager.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"
#include "ui/runtime_ui_lifecycle_fixture.hpp"

#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/Event.h>
#include <RmlUi/Core/Types.h>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <utility>

namespace {

constexpr const char* kDataModelDocument = R"RML(
<rml>
  <head></head>
  <body>
    <span id="outside">{{ 10 }}</span>
    <section data-model="noveltea">
      <span id="inside">{{ 10 }}</span>
      <span id="project-title">{{ project.title }}</span>
      <span id="gameplay-mode">{{ gameplay.mode }}</span>
      <span id="shell-status">{{ shell.status }}</span>
      <div id="gameplay-probe" data-if="gameplay.available"
           data-class-available="gameplay.available"
           data-attr-data-mode="gameplay.mode"></div>
      <span class="choice" data-for="choice : gameplay.scene.choices">{{ choice.label }}</span>
      <button id="assign" data-event-click="project.title = 'Mutated'">Assign</button>
    </section>
  </body>
</rml>
)RML";

noveltea::core::MountedLayoutPolicy policy(noveltea::core::PresentationPlane plane,
                                           noveltea::core::LayoutClockDomain clock,
                                           noveltea::core::LayoutInputMode input)
{
    return {.plane = plane,
            .clock = clock,
            .input = input,
            .gameplay_pause = noveltea::core::GameplayPausePolicy::Continue,
            .visibility = noveltea::core::LayoutVisibility::Visible,
            .escape_dismissal = noveltea::core::EscapeDismissalPolicy::Ignore};
}

} // namespace

TEST_CASE("noveltea data model is opt-in, read-only, current, and context-local")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    auto& ui = fixture.runtime_ui();

    const auto scene = noveltea::core::SceneId::create("scene");
    const auto step = noveltea::core::SceneStepId::create("step");
    const auto choice = noveltea::core::SceneChoiceOptionId::create("choice");
    REQUIRE(scene);
    REQUIRE(step);
    REQUIRE(choice);

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "scene";
    values.view.scene = noveltea::core::SceneView{
        .scene = scene.value(),
        .choice = noveltea::core::SceneChoiceState{
            .scene = scene.value(),
            .step = step.value(),
            .options = {{.option = choice.value(), .label = "Choice", .enabled = true}}}};
    auto prepared = ui.prepare_gameplay_ui_values(values);
    REQUIRE(prepared);
    ui.commit_gameplay_ui_values(std::move(*prepared.value_if()));
    ui.bind_title_document("Project", "Subtitle", "Start");
    noveltea::core::RuntimeShellViewState shell;
    shell.status = "Ready";
    ui.apply_runtime_shell_view(shell);
    REQUIRE(fixture.initialize());

    REQUIRE(ui.load_document_from_memory_for_layout(
        "model-game", kDataModelDocument, "preview://model-game.rml", true,
        policy(noveltea::core::PresentationPlane::GameUi,
               noveltea::core::LayoutClockDomain::Gameplay,
               noveltea::core::LayoutInputMode::Normal),
        1, noveltea::core::MountedLayoutOwner::Gameplay));
    REQUIRE(ui.load_document_from_memory_for_layout(
        "model-menu", kDataModelDocument, "preview://model-menu.rml", true,
        policy(noveltea::core::PresentationPlane::MenuOverlay,
               noveltea::core::LayoutClockDomain::UnscaledPresentation,
               noveltea::core::LayoutInputMode::BlockGameplay),
        2, noveltea::core::MountedLayoutOwner::Gameplay));

    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* game_document = driver->document("model-game");
    auto* menu_document = driver->document("model-menu");
    REQUIRE(game_document);
    REQUIRE(menu_document);
    REQUIRE(game_document->GetContext());
    REQUIRE(menu_document->GetContext());
    CHECK(game_document->GetContext() != menu_document->GetContext());
    game_document->GetContext()->Update();
    menu_document->GetContext()->Update();

    for (const char* document_id : {"model-game", "model-menu"}) {
        CHECK(driver->element(document_id, "outside")->GetInnerRML().find("{{ 10 }}") !=
              std::string::npos);
        CHECK(driver->element(document_id, "inside")->GetInnerRML() == "10");
        CHECK(driver->element(document_id, "project-title")->GetInnerRML() == "Project");
        CHECK(driver->element(document_id, "gameplay-mode")->GetInnerRML() == "scene");
        CHECK(driver->element(document_id, "shell-status")->GetInnerRML() == "Ready");
        CHECK(driver->element(document_id, "gameplay-probe")->IsClassSet("available"));

        Rml::ElementList choices;
        driver->document(document_id)->GetElementsByClassName(choices, "choice");
        CHECK(std::count_if(choices.begin(), choices.end(), [](const Rml::Element* element) {
                  return element && element->GetInnerRML() == "Choice";
              }) == 1);
    }

    auto* assign = driver->element("model-game", "assign");
    REQUIRE(assign);
    REQUIRE(assign->DispatchEvent("click", Rml::Dictionary{}));
    game_document->GetContext()->Update();
    CHECK(driver->element("model-game", "project-title")->GetInnerRML() == "Project");

    ui.bind_title_document("Updated", "Subtitle", "Start");
    game_document->GetContext()->Update();
    menu_document->GetContext()->Update();
    CHECK(driver->element("model-game", "project-title")->GetInnerRML() == "Updated");
    CHECK(driver->element("model-menu", "project-title")->GetInnerRML() == "Updated");

    ui.clear_gameplay_ui_values();
    game_document->GetContext()->Update();
    menu_document->GetContext()->Update();
    CHECK_FALSE(driver->element("model-game", "gameplay-probe")->IsVisible());
    CHECK_FALSE(driver->element("model-menu", "gameplay-probe")->IsVisible());
}
