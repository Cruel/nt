#include "noveltea/presentation/runtime_layout_manager.hpp"
#include "noveltea/core/player_bootstrap.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"
#include "ui/rmlui/runtime_license_catalog.hpp"
#include "ui/runtime_ui_lifecycle_fixture.hpp"

#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/Event.h>
#include <RmlUi/Core/Types.h>
#include <catch2/catch_test_macros.hpp>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

#include <algorithm>
#include <span>
#include <string_view>
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

TEST_CASE("Licenses model renders literal notice text and selects entries through shared callbacks")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    // Read notices from a real ZIP-backed project namespace, as with a loaded .ntpkg,
    // through the production AssetManager, DataModel and RmlUi rendering boundary.
    mz_zip_archive archive{};
    REQUIRE(mz_zip_writer_init_heap(&archive, 0, 0));
    const auto add_project = [&](std::string_view path, std::string_view value) {
        REQUIRE(mz_zip_writer_add_mem(&archive, std::string(path).c_str(), value.data(),
                                      value.size(), MZ_DEFAULT_COMPRESSION));
    };
    const auto digest = [](std::string_view value) {
        return noveltea::core::sha256_hex(std::as_bytes(std::span(value.data(), value.size())));
    };
    constexpr std::string_view alpha = "Alpha <b>not markup</b> & characters\nSecond line";
    constexpr std::string_view beta = "Beta license body";
    add_project("licenses/alpha.txt", alpha);
    add_project("licenses/beta.txt", beta);
    add_project("licenses/index.json",
                "{\"schema\":\"noveltea.project-notices\",\"notices\":["
                "{\"path\":\"licenses/alpha.txt\",\"source\":\"alpha.txt\","
                "\"displayName\":\"Alpha\",\"contentHash\":\"sha256:" +
                    digest(alpha) +
                    "\"},{\"path\":\"licenses/beta.txt\",\"source\":\"beta.txt\","
                    "\"displayName\":\"Beta\",\"contentHash\":\"sha256:" +
                    digest(beta) + "\"}]}");
    void* archive_data = nullptr;
    size_t archive_size = 0;
    REQUIRE(mz_zip_writer_finalize_heap_archive(&archive, &archive_data, &archive_size));
    REQUIRE(archive_data != nullptr);
    const auto* archive_start = static_cast<const std::uint8_t*>(archive_data);
    noveltea::assets::AssetBytes archive_bytes(archive_start, archive_start + archive_size);
    mz_free(archive_data);
    REQUIRE(mz_zip_writer_end(&archive));
    (void)fixture.assets().replace_namespace(
        "project", {std::make_shared<noveltea::assets::ZipAssetSource>(std::move(archive_bytes))});
    const auto catalog = noveltea::ui::rmlui::RuntimeLicenseCatalog::load(fixture.assets());
    REQUIRE_FALSE(catalog.invalid_inventory);
    REQUIRE(catalog.notices.size() == 2);
    auto& ui = fixture.runtime_ui();
    noveltea::core::RuntimeShellViewState shell;
    shell.screen = noveltea::core::RuntimeShellScreen::Licenses;
    REQUIRE(fixture.initialize());
    ui.apply_runtime_shell_view(shell);
    constexpr const char* document = R"RML(
    <rml><head></head><body data-model="noveltea">
      <p id="notice-title">{{ shell.licenses.selected_title }}</p>
      <p id="notice-text">{{ shell.licenses.selected_text }}</p>
      <p id="missing-engine">{{ shell.licenses.engine_missing }}</p>
      <button data-for="entry : shell.licenses.project" data-event-click="shell_select_license(entry.index)">{{ entry.label }}</button>
    </body></rml>)RML";
    REQUIRE(ui.load_document_from_memory_for_layout(
        "licenses-test", document, "preview://licenses.rml", true,
        policy(noveltea::core::PresentationPlane::MenuOverlay,
               noveltea::core::LayoutClockDomain::UnscaledPresentation,
               noveltea::core::LayoutInputMode::Modal),
        3, noveltea::core::MountedLayoutOwner::Shell));
    auto* driver = noveltea::ui::rmlui::RuntimeUiPlaybackDriver::from(ui);
    REQUIRE(driver);
    auto* view = driver->document("licenses-test");
    REQUIRE(view);
    view->GetContext()->Update();
    CHECK(driver->element("licenses-test", "notice-title")->GetInnerRML() == "Alpha");
    const auto markup = driver->element("licenses-test", "notice-text")->GetInnerRML();
    CHECK(markup.find("&lt;b&gt;not markup&lt;/b&gt;") != std::string::npos);
    Rml::ElementList children;
    view->GetElementsByTagName(children, "b");
    CHECK(children.empty());

    Rml::ElementList buttons;
    view->GetElementsByTagName(buttons, "button");
    auto found_beta = std::find_if(buttons.begin(), buttons.end(), [](const Rml::Element* button) {
        return button && button->GetInnerRML() == "Beta";
    });
    REQUIRE(found_beta != buttons.end());
    REQUIRE((*found_beta)->DispatchEvent("click", Rml::Dictionary{}));
    view->GetContext()->Update();
    CHECK(driver->element("licenses-test", "notice-title")->GetInnerRML() == "Beta");
    CHECK(driver->element("licenses-test", "notice-text")->GetInnerRML() == beta);

    REQUIRE(ui.load_builtin_for_layout(
        noveltea::presentation::RuntimeLayoutBuiltinDocument::Licenses, true,
        policy(noveltea::core::PresentationPlane::MenuOverlay,
               noveltea::core::LayoutClockDomain::UnscaledPresentation,
               noveltea::core::LayoutInputMode::Modal),
        4, noveltea::core::MountedLayoutOwner::Shell));
    auto* builtin = driver->document("runtime_licenses");
    REQUIRE(builtin);
    builtin->GetContext()->Update();
    auto* builtin_text = builtin->GetElementById("nt-license-text");
    REQUIRE(builtin_text);
    CHECK(builtin_text->GetInnerRML() == beta);
    CHECK(builtin->GetElementById("nt-license-list") != nullptr);
    CHECK(builtin->GetElementById("nt-license-text-scroll") != nullptr);
}

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
