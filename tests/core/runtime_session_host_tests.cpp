#include <noveltea/core/runtime_session_host.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <noveltea/core/project_ids.hpp>

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

ProjectDocument make_dialogue_project()
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::entrypoint_entity] = ref(EntityType::Dialogue, "talk");

    auto root_segment = nlohmann::json::array(
        {0, -1, false, false, false, false, false, false, "", "", "", nlohmann::json::array({1})});
    auto text_segment = nlohmann::json::array({1, -1, false, false, false, false, false, false, "",
                                               "", "[Guide]Hello.", nlohmann::json::array({2})});
    auto option_segment = nlohmann::json::array({2, -1, false, false, false, false, false, false,
                                                 "", "", "Go on", nlohmann::json::array()});

    root[project_ids::dialogue] = nlohmann::json::object({
        {"talk",
         nlohmann::json::array(
             {"talk", "", props(), "Guide", ref(EntityType::Room, "kitchen"), 0, false, false, 1,
              nlohmann::json::array({root_segment, text_segment, option_segment})})},
    });
    return project;
}

ProjectDocument make_cutscene_project()
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::entrypoint_entity] = ref(EntityType::Cutscene, "intro");

    auto page = nlohmann::json::array();
    page.push_back(2);
    page.push_back(true);
    page.push_back("One.\n\nTwo.");
    page.push_back("\n");
    page.push_back("\n\n");
    page.push_back(0);
    page.push_back(1);
    page.push_back(1000);
    page.push_back(2000);
    page.push_back(2000);
    page.push_back(3000);
    page.push_back(true);
    page.push_back(true);
    page.push_back(0);
    page.push_back(0);
    page.push_back("");
    page.push_back(true);

    root[project_ids::cutscene] = nlohmann::json::object({
        {"intro",
         nlohmann::json::array({"intro", "", props(), true, true, 1.0,
                                ref(EntityType::Room, "foyer"), nlohmann::json::array({page})})},
    });
    return project;
}

ProjectDocument make_action_project()
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object({
        {"lamp", nlohmann::json::array({"lamp", "", props(), "Lamp", false})},
        {"coin", nlohmann::json::array({"coin", "", props(), "Coin", false})},
    });
    root[project_ids::verb] = nlohmann::json::object({
        {"look", nlohmann::json::array({"look", "", props(), "Look", 1, "default_look();", "",
                                        nlohmann::json::array()})},
    });
    root[project_ids::action] = nlohmann::json::object({
        {"look_lamp", nlohmann::json::array({"look_lamp", "", props(), "look", "look_lamp();",
                                             nlohmann::json::array({"lamp"}), false})},
    });
    root[project_ids::room]["foyer"][8] = nlohmann::json::array({
        nlohmann::json::array({"lamp", true}),
    });
    root[project_ids::starting_inventory] = nlohmann::json::array({"coin"});
    return project;
}

bool has_command(const std::vector<ControllerCommand>& commands, ControllerCommandType type)
{
    for (const auto& command : commands) {
        if (command.type == type)
            return true;
    }
    return false;
}

bool has_output(const std::vector<RuntimeOutput>& outputs, RuntimeOutputType type)
{
    for (const auto& output : outputs) {
        if (output.type == type)
            return true;
    }
    return false;
}

ProjectDocument make_script_project()
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::entrypoint_entity] = ref(EntityType::Script, "bootstrap");
    root[project_ids::script] = nlohmann::json::object({
        {"bootstrap", nlohmann::json::array({"bootstrap", "", props(), false, "notify('hello')"})},
    });
    return project;
}

} // namespace

TEST_CASE("RuntimeSessionHost apply_input ticks headless and emits runtime outputs")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_room_project()).success);

    auto result = host.apply_input(RuntimeInput{.type = RuntimeInputType::Tick});

    CHECK(result.handled);
    CHECK(host.current_mode_name() == std::string_view("room"));
    CHECK(result.view.mode == "room");
    CHECK(result.view.title == "Foyer");
    CHECK(has_output(result.outputs, RuntimeOutputType::ModeChanged));
    CHECK(has_output(result.outputs, RuntimeOutputType::ViewUpdated));
    CHECK(has_command(host.last_commands(), ControllerCommandType::RoomDescription));
}

TEST_CASE("RuntimeSessionHost loads project and drives room UI state")
{
    RuntimeSessionHost host;
    auto result = host.load(make_room_project());
    REQUIRE(result.success);

    host.tick(0.0);

    CHECK(host.loaded());
    CHECK(host.current_mode_name() == std::string_view("room"));
    CHECK(has_command(host.last_commands(), ControllerCommandType::RoomDescription));
    const auto& view = host.view_state();
    CHECK(view.mode == "room");
    CHECK(view.title == "Foyer");
    CHECK(view.body == "A quiet foyer.");
    REQUIRE(view.navigation.size() == 1);
    CHECK(view.navigation[0] == "kitchen");
}

TEST_CASE("RuntimeSessionHost routes navigation and updates room state")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_room_project()).success);
    host.tick(0.0);

    auto result =
        host.apply_input(RuntimeInput{.type = RuntimeInputType::Navigate, .direction = 0});

    CHECK(result.handled);
    host.tick(0.0);
    CHECK(host.current_mode_name() == std::string_view("room"));
    CHECK(host.view_state().title == "Kitchen");
    CHECK(host.view_state().body == "A bright kitchen.");
}

TEST_CASE("RuntimeSessionHost routes dialogue option selection")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_dialogue_project()).success);
    host.tick(0.0);

    CHECK(host.current_mode_name() == std::string_view("dialogue"));
    CHECK(host.view_state().title == "Guide");
    REQUIRE(host.view_state().dialogue_options.size() == 1);

    auto result =
        host.apply_input(RuntimeInput{.type = RuntimeInputType::SelectDialogueOption, .index = 0});
    CHECK(result.handled);
    CHECK(has_command(host.last_commands(), ControllerCommandType::DialogueComplete));
}

TEST_CASE("RuntimeSessionHost routes active continue for cutscenes")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_cutscene_project()).success);
    host.tick(0.0);

    CHECK(host.current_mode_name() == std::string_view("cutscene"));
    CHECK(host.view_state().body == "One.");

    CHECK(host.apply_input(RuntimeInput{.type = RuntimeInputType::Continue}).handled);
    CHECK(host.current_mode_name() == std::string_view("cutscene"));
    CHECK(host.view_state().body == "Two.");

    CHECK(host.apply_input(RuntimeInput{.type = RuntimeInputType::Continue}).handled);
    CHECK(host.current_mode_name() == std::string_view("room"));
    CHECK(host.view_state().title == "Foyer");
    CHECK(host.view_state().body == "A quiet foyer.");
}

TEST_CASE("RuntimeSessionHost exposes room objects, inventory, and actions")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_action_project()).success);
    host.tick(0.0);

    const auto& view = host.view_state();
    REQUIRE(view.objects.size() == 2);
    CHECK(view.objects[0].id == "lamp");
    CHECK(view.objects[0].name == "Lamp");
    CHECK(view.objects[0].in_room);
    CHECK(view.objects[1].id == "coin");
    CHECK(view.objects[1].in_inventory);
    REQUIRE(view.actions.size() == 1);
    CHECK(view.actions[0].verb_id == "look");
    CHECK(view.actions[0].label == "Look");
    CHECK(view.actions[0].object_count == 1);

    CHECK(host.apply_input(
                  RuntimeInput{.type = RuntimeInputType::SelectObject, .object_ids = {"lamp"}})
              .handled);
    auto result =
        host.apply_input(RuntimeInput{.type = RuntimeInputType::RunAction, .verb_id = "look"});
    CHECK(result.handled);
    CHECK(has_command(host.last_commands(), ControllerCommandType::ActionResolved));
}

TEST_CASE("RuntimeSessionHost invalid input returns structured diagnostics")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_room_project()).success);
    host.tick(0.0);

    auto result = host.apply_input(
        RuntimeInput{.type = RuntimeInputType::SelectDialogueOption, .index = 0, .step_index = 7});

    CHECK_FALSE(result.handled);
    REQUIRE(result.diagnostics.size() == 1);
    CHECK(result.diagnostics.front().severity == RuntimeDiagnosticSeverity::Warning);
    CHECK(result.diagnostics.front().category == "runtime-input");
    CHECK(result.diagnostics.front().playback_step_index == 7);
    CHECK(has_output(result.outputs, RuntimeOutputType::Diagnostic));
}

TEST_CASE("RuntimeSessionHost surfaces deferred scripts as runtime script requests")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_script_project()).success);

    auto result = host.apply_input(RuntimeInput{.type = RuntimeInputType::Tick, .step_index = 3});

    CHECK(result.handled);
    CHECK(has_command(host.last_commands(), ControllerCommandType::ScriptDeferred));
    CHECK(has_output(result.outputs, RuntimeOutputType::ScriptRequest));
    for (const auto& output : result.outputs) {
        if (output.type == RuntimeOutputType::ScriptRequest) {
            REQUIRE(output.command.has_value());
            CHECK(output.command->type == ControllerCommandType::ScriptDeferred);
            CHECK(output.step_index == 3);
        }
    }
}
