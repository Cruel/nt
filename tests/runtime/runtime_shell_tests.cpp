#include <noveltea/runtime_shell.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <noveltea/core/project_ids.hpp>

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
