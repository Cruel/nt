#include <noveltea/runtime_shell.hpp>
#include <noveltea/runtime_transition_manager.hpp>
#include <noveltea/runtime_ui_playback.hpp>
#include <noveltea/ui_runtime.hpp>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/assets/asset_source.hpp>
#include <noveltea/core/project_ids.hpp>
#include <noveltea/script/script_runtime.hpp>

#include <memory>
#include <string_view>
#include <utility>

using namespace noveltea;
using namespace noveltea::core;

namespace {

nlohmann::json props() { return nlohmann::json::object(); }

nlohmann::json ref(EntityType type, std::string id)
{
    return nlohmann::json::array({to_integer(type), std::move(id)});
}

nlohmann::json path_entry(bool enabled, EntityType type, const std::string& id)
{
    return nlohmann::json::array({enabled, ref(type, id)});
}

ProjectDocument make_room_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object();
    root[project_ids::verb] = nlohmann::json::object();
    root[project_ids::action] = nlohmann::json::object();
    root[project_ids::room] = nlohmann::json::object({
        {"foyer",
         nlohmann::json::array(
             {"foyer", "", props(), "A quiet foyer.", "", "", "", "", nlohmann::json::array(),
              nlohmann::json::array({path_entry(true, EntityType::Room, "kitchen")}), "Foyer"})},
        {"kitchen",
         nlohmann::json::array({"kitchen", "", props(), "A bright kitchen.", "", "", "", "",
                                nlohmann::json::array(), nlohmann::json::array(), "Kitchen"})},
    });
    root[project_ids::map] = nlohmann::json::object();
    root[project_ids::dialogue] = nlohmann::json::object();
    root[project_ids::cutscene] = nlohmann::json::object();
    root[project_ids::script] = nlohmann::json::object();
    root[project_ids::entrypoint_entity] = ref(EntityType::Room, "foyer");
    root[project_ids::starting_inventory] = nlohmann::json::array();
    return project;
}

ProjectDocument make_script_flow_project()
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::entrypoint_entity] = ref(EntityType::Script, "bootstrap");
    root[project_ids::script] = nlohmann::json::object({
        {"bootstrap",
         nlohmann::json::array({"bootstrap", "", props(), false, "Game.start_room('kitchen')"})},
    });
    return project;
}

ProjectDocument make_dialogue_flow_project()
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::entrypoint_entity] = ref(EntityType::Dialogue, "intro");

    auto root_segment = nlohmann::json::array(
        {0, -1, false, false, false, false, false, false, "", "", "", nlohmann::json::array({1})});
    auto text_segment =
        nlohmann::json::array({1, -1, false, false, false, false, false, true, "", "",
                               "[Guide]Welcome.\n[Guide]Ready?", nlohmann::json::array({2})});
    auto option_segment = nlohmann::json::array({2, -1, false, false, false, false, false, true, "",
                                                 "", "Go on", nlohmann::json::array({3})});
    auto reply_segment =
        nlohmann::json::array({1, -1, false, false, false, false, false, true, "", "",
                               "[Guide]The kitchen is open.", nlohmann::json::array()});

    root[project_ids::dialogue] = nlohmann::json::object({
        {"intro",
         nlohmann::json::array(
             {"intro", "", props(), "Guide", ref(EntityType::Room, "kitchen"), 0, false, true, 1,
              nlohmann::json::array({root_segment, text_segment, option_segment, reply_segment})})},
    });
    return project;
}

ProjectDocument make_scene_flow_project()
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::entrypoint_entity] = ref(EntityType::Cutscene, "opening");

    auto text1 =
        nlohmann::json::array({0, "The lights come up.", true, true, 0, 1000, 0, 0, 0, true, ""});
    auto text2 =
        nlohmann::json::array({0, "The kettle sings.", true, true, 0, 1000, 0, 0, 0, true, ""});

    root[project_ids::cutscene] = nlohmann::json::object({
        {"opening", nlohmann::json::array({"opening", "", props(), true, true, 1.0,
                                           ref(EntityType::Room, "kitchen"),
                                           nlohmann::json::array({text1, text2})})},
    });
    return project;
}

bool has_output(const std::vector<RuntimeOutput>& outputs, RuntimeOutputType type)
{
    for (const auto& output : outputs) {
        if (output.type == type) {
            return true;
        }
    }
    return false;
}

RuntimeCommand command(std::string name, nlohmann::json payload = nlohmann::json::object())
{
    RuntimeCommand command;
    command.source = RuntimeCommandSource::RmlUiEvent;
    command.domain = domain_from_command_name(name);
    command.name = std::move(name);
    command.payload = std::move(payload);
    return command;
}

bool has_diagnostic_containing(const std::vector<RuntimeDiagnostic>& diagnostics,
                               std::string_view text)
{
    for (const auto& diagnostic : diagnostics) {
        if (diagnostic.message.find(text) != std::string::npos) {
            return true;
        }
    }
    return false;
}

std::shared_ptr<assets::MemoryAssetSource> make_ui_memory_source(std::string rcss)
{
    auto source = std::make_shared<assets::MemoryAssetSource>();
    rcss = "body { font-family: Liberation Sans; } " + std::move(rcss);
    assets::AssetBytes bytes(rcss.begin(), rcss.end());
    source->add("project:/test.rcss", std::move(bytes));
    return source;
}

struct HeadlessUiFixture {
    explicit HeadlessUiFixture(std::string rcss)
    {
#ifdef NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT
        assets.mount_directory("project", NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT);
#endif
        assets.mount("project", make_ui_memory_source(std::move(rcss)));
#ifdef NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT
        assets.mount_directory("system", NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT);
#endif
        REQUIRE(script_runtime.initialize(script::ScriptRuntimeConfig{.assets = &assets}));
        REQUIRE(ui.initialize(&assets, nullptr, false, &script_runtime, nullptr, true));
    }

    assets::AssetManager assets;
    script::ScriptRuntime script_runtime;
    RuntimeUI ui;
};

std::string rml_with_body(std::string body)
{
    return "<rml><head><title>test</title><link type=\"text/rcss\" "
           "href=\"project:/test.rcss\"/></head><body>" +
           std::move(body) + "</body></rml>";
}

} // namespace

TEST_CASE("RuntimeShell starts in boot mode")
{
    RuntimeShell shell;

    CHECK(shell.mode() == RuntimeShellMode::Boot);
    CHECK_FALSE(shell.loaded());
    CHECK_FALSE(shell.paused());
}

TEST_CASE("RuntimeTransitionManager cut completes immediately")
{
    RuntimeTransitionManager transitions;
    int midpoint_count = 0;

    transitions.start(RuntimeTransitionRequest{
        .kind = RuntimeTransitionKind::Cut,
        .duration_seconds = 1.0,
        .label = "test-cut",
        .on_midpoint = [&] { ++midpoint_count; },
    });

    CHECK_FALSE(transitions.active());
    CHECK(transitions.opacity() == Catch::Approx(0.0f));
    CHECK(transitions.state().midpoint_reached);
    CHECK(midpoint_count == 1);
}

TEST_CASE("RuntimeTransitionManager black fade progresses deterministically")
{
    RuntimeTransitionManager transitions;
    transitions.set_timed_transitions_enabled(true);
    int midpoint_count = 0;

    transitions.start(RuntimeTransitionRequest{
        .kind = RuntimeTransitionKind::BlackFade,
        .duration_seconds = 1.0,
        .label = "test-fade",
        .on_midpoint = [&] { ++midpoint_count; },
    });

    REQUIRE(transitions.active());
    transitions.update(0.25);
    CHECK(transitions.active());
    CHECK(transitions.opacity() == Catch::Approx(0.5f));
    CHECK(midpoint_count == 0);

    transitions.update(0.25);
    CHECK(transitions.active());
    CHECK(transitions.opacity() == Catch::Approx(1.0f));
    CHECK(transitions.state().phase == RuntimeTransitionPhase::FadeIn);
    CHECK(midpoint_count == 1);

    transitions.update(0.25);
    CHECK(transitions.active());
    CHECK(transitions.opacity() == Catch::Approx(0.5f));

    transitions.update(0.25);
    CHECK_FALSE(transitions.active());
    CHECK(transitions.opacity() == Catch::Approx(0.0f));
    CHECK(midpoint_count == 1);
}

TEST_CASE("RuntimeShell loads project into title without ticking gameplay")
{
    RuntimeShell shell;

    auto load = shell.load_project(make_room_project());
    REQUIRE(load.success);

    CHECK(shell.mode() == RuntimeShellMode::Title);
    CHECK(shell.loaded());
    CHECK(shell.host().current_mode_name() == std::string_view("none"));

    auto update = shell.update(1.0 / 60.0);

    CHECK_FALSE(update.handled);
    CHECK(shell.mode() == RuntimeShellMode::Title);
    CHECK(shell.host().current_mode_name() == std::string_view("none"));
}

TEST_CASE("RuntimeShell start_game drains the loaded room entrypoint")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);

    auto result = shell.start_game();

    CHECK(result.handled);
    CHECK(shell.mode() == RuntimeShellMode::Game);
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(result.view.mode == "room");
    CHECK(result.view.title == "Foyer");
    CHECK(shell.host().view_state().body == "A quiet foyer.");
    CHECK(has_output(result.outputs, RuntimeOutputType::ModeChanged));
    CHECK(has_output(result.outputs, RuntimeOutputType::ViewUpdated));
    CHECK_FALSE(shell.transitions().active());
    CHECK(shell.transitions().state().label == "title-to-game");
}

TEST_CASE("RuntimeShell timed title-to-game transition does not restart gameplay")
{
    RuntimeShell shell;
    shell.transitions().set_timed_transitions_enabled(true);
    REQUIRE(shell.load_project(make_room_project()).success);

    auto result = shell.start_game();

    REQUIRE(result.handled);
    CHECK(shell.mode() == RuntimeShellMode::Game);
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(shell.host().view_state().title == "Foyer");
    REQUIRE(shell.transitions().active());
    CHECK(shell.transitions().state().label == "title-to-game");

    const auto body = shell.host().view_state().body;
    auto update = shell.update(0.25);

    CHECK(update.handled);
    CHECK(shell.transitions().active());
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(shell.host().view_state().title == "Foyer");
    CHECK(shell.host().view_state().body == body);

    (void)shell.update(0.25);
    CHECK(shell.transitions().state().midpoint_reached);
    (void)shell.update(0.5);
    CHECK_FALSE(shell.transitions().active());
    CHECK(shell.host().view_state().title == "Foyer");
    CHECK(shell.host().view_state().body == body);
}

TEST_CASE("RuntimeShell start_game launches a script entrypoint request")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_script_flow_project()).success);

    auto result = shell.start_game();

    CHECK(result.handled);
    CHECK(shell.mode() == RuntimeShellMode::Game);
    CHECK(has_output(result.outputs, RuntimeOutputType::ScriptRequest));
    CHECK(shell.host().current_mode_name() == std::string_view("none"));
}

TEST_CASE("RuntimeCommandDispatcher emits script requests for Script flow commands")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_script_flow_project()).success);

    auto result =
        shell.dispatcher().dispatch(command("runtime.run-script", {{"script_id", "bootstrap"}}));

    CHECK(result.handled);
    CHECK(has_output(result.outputs, RuntimeOutputType::ScriptRequest));
    CHECK(has_diagnostic_containing(result.diagnostics, "name=runtime.run-script"));
}

TEST_CASE("RuntimeShell start_game supports a dialogue entrypoint")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_dialogue_flow_project()).success);

    auto result = shell.start_game();

    CHECK(result.handled);
    CHECK(shell.mode() == RuntimeShellMode::Game);
    CHECK(shell.host().current_mode_name() == std::string_view("dialogue"));
    CHECK(result.view.mode == "dialogue");
    CHECK(result.view.title == "Guide");
    CHECK(result.view.body == "Welcome.");
}

TEST_CASE("RuntimeShell start_game supports a scene entrypoint")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_scene_flow_project()).success);

    auto result = shell.start_game();

    CHECK(result.handled);
    CHECK(shell.mode() == RuntimeShellMode::Game);
    CHECK(shell.host().current_mode_name() == std::string_view("cutscene"));
    CHECK(result.view.mode == "cutscene");
    CHECK(result.view.body == "The lights come up.");
    CHECK(result.view.awaiting_continue);
}

TEST_CASE("RuntimeShell pause suppresses updates and resume keeps loaded gameplay")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);
    REQUIRE(shell.start_game().handled);

    shell.pause();
    CHECK(shell.mode() == RuntimeShellMode::Paused);
    CHECK(shell.paused());

    auto paused_update = shell.update(1.0 / 60.0);

    CHECK_FALSE(paused_update.handled);
    CHECK(shell.loaded());
    CHECK(shell.host().current_mode_name() == std::string_view("room"));

    shell.resume();
    CHECK(shell.mode() == RuntimeShellMode::Game);

    auto resumed_update = shell.update(1.0 / 60.0);
    CHECK(resumed_update.handled);
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
}

TEST_CASE("RuntimeShell pause and resume are idempotent and keep gameplay state")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);
    REQUIRE(shell.start_game().handled);
    const auto body = shell.host().view_state().body;

    shell.pause();
    shell.pause();
    CHECK(shell.mode() == RuntimeShellMode::Paused);
    CHECK(shell.paused());
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(shell.host().view_state().body == body);

    shell.resume();
    shell.resume();
    CHECK(shell.mode() == RuntimeShellMode::Game);
    CHECK_FALSE(shell.paused());
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(shell.host().view_state().body == body);
}

TEST_CASE("RuntimeShell enters error mode when project load fails")
{
    RuntimeShell shell;

    auto invalid = ProjectDocument::new_project();
    auto result = shell.load_project(std::move(invalid));

    CHECK_FALSE(result.success);
    CHECK(shell.mode() == RuntimeShellMode::Error);
    CHECK_FALSE(shell.loaded());
    CHECK_FALSE(shell.last_diagnostics().empty());
}

TEST_CASE("RuntimeCommandDispatcher game.start starts gameplay and traces command")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);

    auto result = shell.dispatcher().dispatch(command("game.start"));

    CHECK(result.handled);
    CHECK(result.input_result.handled);
    CHECK(shell.mode() == RuntimeShellMode::Game);
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(has_output(result.outputs, RuntimeOutputType::Diagnostic));
    CHECK(has_diagnostic_containing(result.diagnostics, "name=game.start"));
    CHECK(has_output(result.input_result.outputs, RuntimeOutputType::ViewUpdated));
}

TEST_CASE("RuntimeCommandDispatcher controls pause resume and menu close")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);
    REQUIRE(shell.dispatcher().dispatch(command("game.start")).handled);

    auto pause = shell.dispatcher().dispatch(command("game.pause"));
    CHECK(pause.handled);
    CHECK(shell.mode() == RuntimeShellMode::Paused);

    auto resume = shell.dispatcher().dispatch(command("game.resume"));
    CHECK(resume.handled);
    CHECK(shell.mode() == RuntimeShellMode::Game);

    REQUIRE(shell.dispatcher().dispatch(command("game.pause")).handled);
    auto close = shell.dispatcher().dispatch(command("menu.close"));
    CHECK(close.handled);
    CHECK(shell.mode() == RuntimeShellMode::Game);
    CHECK_FALSE(shell.paused());
}

TEST_CASE("RuntimeCommandDispatcher reports unknown command diagnostics")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);

    auto result = shell.dispatcher().dispatch(command("menu.nope"));

    CHECK_FALSE(result.handled);
    CHECK(has_output(result.outputs, RuntimeOutputType::Diagnostic));
    CHECK(has_diagnostic_containing(result.diagnostics, "unknown runtime command: menu.nope"));
}

TEST_CASE("RuntimeCommandDispatcher handles title placeholder menu commands")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);

    auto load = shell.dispatcher().dispatch(command("menu.load"));
    CHECK(load.handled);
    CHECK(has_output(load.outputs, RuntimeOutputType::Diagnostic));
    CHECK(has_diagnostic_containing(load.diagnostics, "Load menu is not implemented yet"));
    CHECK(shell.mode() == RuntimeShellMode::Title);

    auto settings = shell.dispatcher().dispatch(command("menu.settings"));
    CHECK(settings.handled);
    CHECK(has_output(settings.outputs, RuntimeOutputType::Diagnostic));
    CHECK(has_diagnostic_containing(settings.diagnostics, "Settings menu is not implemented yet"));
    CHECK(shell.mode() == RuntimeShellMode::Title);
}

TEST_CASE("RuntimeCommandDispatcher handles pause menu placeholder commands")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);
    REQUIRE(shell.dispatcher().dispatch(command("game.start")).handled);
    REQUIRE(shell.dispatcher().dispatch(command("game.pause")).handled);

    auto save = shell.dispatcher().dispatch(command("menu.save"));
    CHECK(save.handled);
    CHECK(has_output(save.outputs, RuntimeOutputType::Diagnostic));
    CHECK(has_diagnostic_containing(save.diagnostics, "Save menu is not implemented yet"));
    CHECK(shell.mode() == RuntimeShellMode::Paused);

    auto title = shell.dispatcher().dispatch(command("game.return-to-title"));
    CHECK(title.handled);
    CHECK(has_diagnostic_containing(title.diagnostics, "Return to title is not implemented yet"));
    CHECK(shell.mode() == RuntimeShellMode::Paused);

    auto quit = shell.dispatcher().dispatch(command("game.quit"));
    CHECK(quit.handled);
    CHECK(has_diagnostic_containing(quit.diagnostics, "Quit command is not implemented yet"));
    CHECK(shell.mode() == RuntimeShellMode::Paused);
}

TEST_CASE("RuntimeCommandDispatcher routes gameplay commands through session host")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);
    REQUIRE(shell.dispatcher().dispatch(command("game.start")).handled);

    auto result = shell.dispatcher().dispatch(command("runtime.navigate", {{"direction", 0}}));

    CHECK(result.handled);
    CHECK(has_diagnostic_containing(result.diagnostics, "name=runtime.navigate"));

    auto tick = shell.update(0.0);
    CHECK(tick.handled);
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(shell.host().view_state().title == "Kitchen");
}

TEST_CASE("RuntimeCommandDispatcher starts room through shell transition path")
{
    RuntimeShell shell;
    shell.transitions().set_timed_transitions_enabled(true);
    REQUIRE(shell.load_project(make_room_project()).success);
    REQUIRE(shell.dispatcher().dispatch(command("game.start")).handled);
    shell.transitions().complete_immediately();

    auto result =
        shell.dispatcher().dispatch(command("runtime.start-room", {{"room_id", "kitchen"}}));

    CHECK(result.handled);
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(shell.host().view_state().title == "Kitchen");
    REQUIRE(shell.transitions().active());
    CHECK(shell.transitions().state().label == "room-to-room");
}

TEST_CASE("RuntimeShell updates transitions while gameplay is paused")
{
    RuntimeShell shell;
    shell.transitions().set_timed_transitions_enabled(true);
    REQUIRE(shell.load_project(make_room_project()).success);
    REQUIRE(shell.start_game().handled);
    shell.transitions().complete_immediately();
    REQUIRE(shell.start_room("kitchen").handled);

    shell.pause();
    CHECK(shell.mode() == RuntimeShellMode::Paused);
    REQUIRE(shell.transitions().active());

    auto result = shell.update(0.25);

    CHECK_FALSE(result.handled);
    CHECK(shell.transitions().active());
    CHECK(shell.transitions().opacity() == Catch::Approx(0.5f));
    CHECK(shell.host().view_state().title == "Kitchen");
}

TEST_CASE("RuntimeCommandDispatcher starts rooms and reports entity flow diagnostics")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);
    REQUIRE(shell.dispatcher().dispatch(command("game.start")).handled);

    auto room = shell.dispatcher().dispatch(command("runtime.start-room", {{"room_id", "foyer"}}));
    CHECK(room.handled);
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(shell.host().view_state().title == "Foyer");

    auto missing_room =
        shell.dispatcher().dispatch(command("runtime.start-room", {{"room_id", "nowhere"}}));
    CHECK_FALSE(missing_room.handled);
    CHECK(has_diagnostic_containing(missing_room.diagnostics, "room 'nowhere' does not exist"));

    auto script =
        shell.dispatcher().dispatch(command("runtime.run-script", {{"script_id", "bootstrap"}}));
    CHECK_FALSE(script.handled);
    CHECK(has_diagnostic_containing(script.diagnostics, "script 'bootstrap' does not exist"));
}

TEST_CASE("RuntimeCommandDispatcher starts and progresses scenes")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_scene_flow_project()).success);
    REQUIRE(shell.dispatcher().dispatch(command("game.start")).handled);

    auto restart =
        shell.dispatcher().dispatch(command("runtime.start-scene", {{"scene_id", "opening"}}));
    CHECK(restart.handled);
    CHECK(shell.host().current_mode_name() == std::string_view("cutscene"));
    CHECK(shell.host().view_state().body == "The lights come up.");
    CHECK(shell.host().view_state().awaiting_continue);

    auto continued = shell.dispatcher().dispatch(command("runtime.continue"));
    CHECK(continued.handled);
    CHECK(shell.host().view_state().body == "The kettle sings.");

    auto completed = shell.dispatcher().dispatch(command("runtime.continue"));
    CHECK(completed.handled);
    CHECK(shell.host().current_mode_name() == std::string_view("room"));
    CHECK(shell.host().view_state().title == "Kitchen");

    auto missing =
        shell.dispatcher().dispatch(command("runtime.start-scene", {{"scene_id", "missing"}}));
    CHECK_FALSE(missing.handled);
    CHECK(has_diagnostic_containing(missing.diagnostics, "scene 'missing' does not exist"));
}

TEST_CASE("RuntimeCommandDispatcher starts and progresses dialogue")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_dialogue_flow_project()).success);
    REQUIRE(shell.dispatcher().dispatch(command("game.start")).handled);

    auto restart =
        shell.dispatcher().dispatch(command("runtime.start-dialogue", {{"dialogue_id", "intro"}}));
    CHECK(restart.handled);
    CHECK(shell.host().current_mode_name() == std::string_view("dialogue"));
    CHECK(shell.host().view_state().body == "Welcome.");
    CHECK(shell.host().view_state().awaiting_continue);

    auto continued = shell.dispatcher().dispatch(command("runtime.continue"));
    CHECK(continued.handled);
    CHECK(shell.host().view_state().body == "Ready?");
    REQUIRE(shell.host().view_state().dialogue_options.size() == 1);
    CHECK(shell.host().view_state().dialogue_options.front().text == "Go on");

    auto selected = shell.dispatcher().dispatch(command("runtime.dialogue-option", {{"index", 0}}));
    CHECK(selected.handled);
    CHECK(shell.host().view_state().body == "The kitchen is open.");
}

TEST_CASE("RuntimeCommandDispatcher accepts gameplay layout layer commands")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);

    auto missing_ui = shell.dispatcher().dispatch(
        command("layout.add-layer", {{"layout_id", "corner_button"}, {"z_index", 20}}));

    CHECK_FALSE(missing_ui.handled);
    CHECK(has_diagnostic_containing(missing_ui.diagnostics,
                                    "failed to mount gameplay layout: corner_button"));

    auto invalid = shell.dispatcher().dispatch(command("layout.add-layer"));
    CHECK_FALSE(invalid.handled);
    CHECK(has_diagnostic_containing(invalid.diagnostics,
                                    "layout.add-layer requires a non-empty layout_id"));
}

TEST_CASE("RuntimeUI playback click rejects hidden documents")
{
    HeadlessUiFixture fixture("#target { position: absolute; left: 10px; top: 10px; width: "
                              "100px; height: 40px; }");
    REQUIRE(fixture.ui.load_document_from_memory(
        "doc", rml_with_body("<button id=\"target\" onclick=\"Game.start()\">Go</button>"),
        "memory://test.rml", false));

    auto result = fixture.ui.playback_click({.document_id = "doc", .selector = "#target"});
    CHECK(result.status == RuntimeUiPlaybackClickStatus::DocumentHidden);
    CHECK_FALSE(result.dispatched);
}

TEST_CASE("RuntimeUI playback click rejects disabled targets")
{
    HeadlessUiFixture fixture("#target { position: absolute; left: 10px; top: 10px; width: "
                              "100px; height: 40px; }");
    REQUIRE(fixture.ui.load_document_from_memory(
        "doc", rml_with_body("<button id=\"target\" disabled onclick=\"Game.start()\">Go</button>"),
        "memory://test.rml", true));
    fixture.ui.begin_frame(0.0f);

    auto result = fixture.ui.playback_click({.document_id = "doc", .selector = "#target"});
    CHECK(result.status == RuntimeUiPlaybackClickStatus::TargetDisabled);
    CHECK_FALSE(result.dispatched);
}

TEST_CASE("RuntimeUI playback click rejects blocked targets")
{
    HeadlessUiFixture fixture(
        "#target, #blocker { position: absolute; left: 10px; top: 10px; width: 100px; "
        "height: 40px; } #target { z-index: 1; } #blocker { z-index: 2; }");
    REQUIRE(fixture.ui.load_document_from_memory(
        "doc",
        rml_with_body("<button id=\"target\" onclick=\"Game.start()\">Go</button><button "
                      "id=\"blocker\" onclick=\"Game.start()\">Block</button>"),
        "memory://test.rml", true));
    fixture.ui.begin_frame(0.0f);

    auto result = fixture.ui.playback_click({.document_id = "doc", .selector = "#target"});
    CHECK(result.status == RuntimeUiPlaybackClickStatus::TargetBlocked);
    CHECK_FALSE(result.dispatched);
}

TEST_CASE("RuntimeUiPlaybackSession clicks title Start through RmlUi Lua")
{
    RuntimeUiPlaybackSpec spec;
    spec.id = "title-start";
    spec.steps.push_back(RuntimeUiPlaybackStep{
        .input = RuntimeUiPlaybackInputType::UiClick,
        .document_id = "runtime_title",
        .target = "#nt-title-start",
    });

    RuntimeUiPlaybackSession playback;
    auto report = playback.run(make_room_project(), spec);

    if (!report.diagnostics.empty()) {
        INFO(report.diagnostics.front().message);
    }
    CHECK(report.passed);
    CHECK(report.shell_mode == RuntimeShellMode::Game);
    CHECK(report.final_view.mode == "room");
    REQUIRE(report.final_current_room_id.has_value());
    CHECK(*report.final_current_room_id == "foyer");

    bool saw_click = false;
    bool saw_lua_game_call = false;
    bool saw_command = false;
    bool saw_output = false;
    for (const auto& trace : report.trace) {
        saw_click = saw_click || trace.type == "ui-click";
        saw_lua_game_call = saw_lua_game_call || trace.type == "lua-game-call";
        saw_command = saw_command || trace.type == "runtime-command";
        saw_output = saw_output || trace.type == "runtime-output";
    }
    CHECK(saw_click);
    CHECK(saw_lua_game_call);
    CHECK(saw_command);
    CHECK(saw_output);
}

TEST_CASE("RuntimeUiPlaybackSession reports missing ui-click target")
{
    RuntimeUiPlaybackSpec spec;
    spec.id = "missing-target";
    spec.steps.push_back(RuntimeUiPlaybackStep{
        .input = RuntimeUiPlaybackInputType::UiClick,
        .document_id = "runtime_title",
        .target = "#does-not-exist",
    });

    RuntimeUiPlaybackSession playback;
    auto report = playback.run(make_room_project(), spec);

    CHECK_FALSE(report.passed);
    REQUIRE_FALSE(report.diagnostics.empty());
    CHECK(report.diagnostics.front().category == "ui-playback");
    CHECK(report.diagnostics.front().message.find("target not found") != std::string::npos);
}
