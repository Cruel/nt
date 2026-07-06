#include <noveltea/runtime_shell.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <noveltea/core/project_ids.hpp>

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

} // namespace

TEST_CASE("RuntimeShell starts in boot mode")
{
    RuntimeShell shell;

    CHECK(shell.mode() == RuntimeShellMode::Boot);
    CHECK_FALSE(shell.loaded());
    CHECK_FALSE(shell.paused());
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

TEST_CASE("RuntimeCommandDispatcher reports stubbed entity start command diagnostics")
{
    RuntimeShell shell;
    REQUIRE(shell.load_project(make_room_project()).success);

    auto room = shell.dispatcher().dispatch(command("runtime.start-room", {{"room_id", "foyer"}}));
    CHECK(room.handled);
    CHECK(has_diagnostic_containing(room.diagnostics, "runtime.start-room is not implemented yet"));

    auto dialogue =
        shell.dispatcher().dispatch(command("runtime.start-dialogue", {{"dialogue_id", "intro"}}));
    CHECK(dialogue.handled);
    CHECK(has_diagnostic_containing(dialogue.diagnostics,
                                    "runtime.start-dialogue is not implemented yet"));

    auto scene =
        shell.dispatcher().dispatch(command("runtime.start-scene", {{"scene_id", "opening"}}));
    CHECK(scene.handled);
    CHECK(
        has_diagnostic_containing(scene.diagnostics, "runtime.start-scene is not implemented yet"));

    auto script =
        shell.dispatcher().dispatch(command("runtime.run-script", {{"script_id", "bootstrap"}}));
    CHECK(script.handled);
    CHECK(
        has_diagnostic_containing(script.diagnostics, "runtime.run-script is not implemented yet"));
}
