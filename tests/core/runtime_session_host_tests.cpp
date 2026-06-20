#include <noveltea/core/runtime_session_host.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <noveltea/core/project_ids.hpp>

#include <algorithm>
#include <utility>

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
    root[project_ids::map] = nlohmann::json::object({
        {"main",
         nlohmann::json::array(
             {"main", "", props(), "return true;", "return true;",
              nlohmann::json::array({
                  nlohmann::json::array(
                      {"Foyer", 0, 0, 120, 80, nlohmann::json::array({"foyer"}), "", 1}),
                  nlohmann::json::array({"Kitchen", 160, 0, 120, 80,
                                         nlohmann::json::array({"kitchen"}), "visible()", 2}),
              }),
              nlohmann::json::array(
                  {nlohmann::json::array({0, 1, 120, 40, 160, 40, "pathVisible()", 3})})})},
    });
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

ProjectDocument make_multi_action_project(bool position_dependent)
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object({
        {"lamp", nlohmann::json::array({"lamp", "", props(), "Lamp", false})},
        {"coin", nlohmann::json::array({"coin", "", props(), "Coin", false})},
    });
    root[project_ids::verb] = nlohmann::json::object({
        {"combine", nlohmann::json::array(
                        {"combine", "", props(), "Combine", 2, "", "", nlohmann::json::array()})},
    });
    root[project_ids::action] = nlohmann::json::object({
        {"combine_lamp_coin",
         nlohmann::json::array({"combine_lamp_coin", "", props(), "combine", "combine();",
                                nlohmann::json::array({"lamp", "coin"}), position_dependent})},
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

const RuntimeUIObject* find_object(const RuntimeUIViewState& view, const std::string& id)
{
    const auto it = std::find_if(view.objects.begin(), view.objects.end(),
                                 [&](const RuntimeUIObject& object) { return object.id == id; });
    return it == view.objects.end() ? nullptr : &*it;
}

const RuntimeUIAction* find_action(const RuntimeUIViewState& view, const std::string& id)
{
    const auto it =
        std::find_if(view.actions.begin(), view.actions.end(),
                     [&](const RuntimeUIAction& action) { return action.verb_id == id; });
    return it == view.actions.end() ? nullptr : &*it;
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

TEST_CASE("RuntimeSessionHost derives map presentation from current room")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_room_project()).success);
    host.tick(0.0);

    const auto& map = host.view_state().map_view;
    CHECK(map.available);
    CHECK(map.enabled);
    CHECK(map.map_id == "main");
    CHECK(map.current_room_id == "foyer");
    CHECK(map.default_room_script == "return true;");
    CHECK(map.default_path_script == "return true;");
    CHECK(map.min_x == 0);
    CHECK(map.min_y == 0);
    CHECK(map.max_x == 280);
    CHECK(map.max_y == 80);
    REQUIRE(map.rooms.size() == 2);
    CHECK(map.rooms[0].name == "Foyer");
    CHECK(map.rooms[0].current);
    CHECK(map.rooms[0].visible);
    CHECK_FALSE(map.rooms[0].enabled);
    CHECK(map.rooms[1].name == "Kitchen");
    CHECK_FALSE(map.rooms[1].current);
    CHECK(map.rooms[1].visible);
    CHECK(map.rooms[1].enabled);
    CHECK(map.rooms[1].navigation_index == 0);
    CHECK(map.rooms[1].visibility_script == "visible()");
    REQUIRE(map.connections.size() == 1);
    CHECK(map.connections[0].visible);
    CHECK(map.connections[0].visibility_script == "pathVisible()");
}

TEST_CASE("RuntimeSessionHost map presentation tolerates missing maps")
{
    auto project = make_room_project();
    project.root()[project_ids::map] = nlohmann::json::object();

    RuntimeSessionHost host;
    REQUIRE(host.load(std::move(project)).success);
    host.tick(0.0);

    CHECK_FALSE(host.view_state().map_view.available);
    CHECK_FALSE(host.view_state().map_view.enabled);
}

TEST_CASE("RuntimeSessionHost disables map hit targets when map is disabled")
{
    auto save = SaveDocument::new_save();
    save.root()[project_ids::map_enabled] = false;

    RuntimeSessionHost host;
    REQUIRE(host.load(make_room_project(), save).success);
    host.tick(0.0);

    const auto& map = host.view_state().map_view;
    CHECK(map.available);
    CHECK_FALSE(map.enabled);
    REQUIRE(map.rooms.size() == 2);
    CHECK_FALSE(map.rooms[0].visible);
    CHECK_FALSE(map.rooms[0].enabled);
    CHECK_FALSE(map.rooms[1].visible);
    CHECK_FALSE(map.rooms[1].enabled);
    REQUIRE(map.connections.size() == 1);
    CHECK_FALSE(map.connections[0].visible);
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
    const auto& map = host.view_state().map_view;
    REQUIRE(map.rooms.size() == 2);
    CHECK_FALSE(map.rooms[0].current);
    CHECK(map.rooms[1].current);
    CHECK(map.current_room_id == "kitchen");
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
    CHECK_FALSE(view.actions[0].enabled);
    CHECK(view.actions[0].selected_count == 0);

    CHECK(host.apply_input(
                  RuntimeInput{.type = RuntimeInputType::SelectObject, .object_ids = {"lamp"}})
              .handled);
    const auto* selected_lamp = find_object(host.view_state(), "lamp");
    REQUIRE(selected_lamp != nullptr);
    CHECK(selected_lamp->selected);
    const auto* look = find_action(host.view_state(), "look");
    REQUIRE(look != nullptr);
    CHECK(look->enabled);
    CHECK(look->selected_count == 1);
    auto result =
        host.apply_input(RuntimeInput{.type = RuntimeInputType::RunAction, .verb_id = "look"});
    CHECK(result.handled);
    CHECK(has_command(host.last_commands(), ControllerCommandType::ActionResolved));
    selected_lamp = find_object(host.view_state(), "lamp");
    REQUIRE(selected_lamp != nullptr);
    CHECK_FALSE(selected_lamp->selected);
}

TEST_CASE("RuntimeSessionHost uses save-backed object locations for room and inventory")
{
    RuntimeSessionHost host;
    auto project = make_action_project();
    auto save = SaveDocument::new_save();
    save.root()[project_ids::object_locations] = nlohmann::json::object({
        {"lamp", ref(EntityType::Room, "kitchen")},
        {"coin", ref(EntityType::CustomScript, std::string(project_ids::player))},
    });

    REQUIRE(host.load(std::move(project), save).success);
    host.tick(0.0);

    const auto& view = host.view_state();
    REQUIRE(view.objects.size() == 1);
    CHECK(view.objects[0].id == "coin");
    CHECK(view.objects[0].in_inventory);

    auto unavailable = host.apply_input(RuntimeInput{
        .type = RuntimeInputType::RunAction, .verb_id = "look", .object_ids = {"lamp"}});
    CHECK_FALSE(unavailable.handled);
    REQUIRE_FALSE(unavailable.diagnostics.empty());
    CHECK(unavailable.diagnostics.front().category == "action");

    auto available = host.apply_input(RuntimeInput{
        .type = RuntimeInputType::RunAction, .verb_id = "look", .object_ids = {"coin"}});
    CHECK(available.handled);
}

TEST_CASE("RuntimeSessionHost validates object selection and clears selection")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_action_project()).success);
    host.tick(0.0);

    auto missing = host.apply_input(
        RuntimeInput{.type = RuntimeInputType::SelectObject, .object_ids = {"missing"}});
    CHECK_FALSE(missing.handled);
    REQUIRE_FALSE(missing.diagnostics.empty());
    CHECK(missing.diagnostics.front().category == "object-selection");

    CHECK(host.apply_input(
                  RuntimeInput{.type = RuntimeInputType::SelectObject, .object_ids = {"coin"}})
              .handled);
    const auto* coin = find_object(host.view_state(), "coin");
    REQUIRE(coin != nullptr);
    CHECK(coin->selected);
    REQUIRE(has_output(host.last_outputs(), RuntimeOutputType::TestObservation));

    auto clear = host.apply_input(RuntimeInput{.type = RuntimeInputType::ClearObjectSelection});
    CHECK(clear.handled);
    coin = find_object(host.view_state(), "coin");
    REQUIRE(coin != nullptr);
    CHECK_FALSE(coin->selected);
    REQUIRE(has_output(clear.outputs, RuntimeOutputType::TestObservation));
}

TEST_CASE("RuntimeSessionHost keeps selection after failed action")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_action_project()).success);
    host.tick(0.0);

    REQUIRE(host.apply_input(
                    RuntimeInput{.type = RuntimeInputType::SelectObject, .object_ids = {"lamp"}})
                .handled);
    auto failed =
        host.apply_input(RuntimeInput{.type = RuntimeInputType::RunAction, .verb_id = "missing"});
    CHECK_FALSE(failed.handled);
    REQUIRE_FALSE(failed.diagnostics.empty());
    CHECK(failed.diagnostics.front().category == "action");
    const auto* lamp = find_object(host.view_state(), "lamp");
    REQUIRE(lamp != nullptr);
    CHECK(lamp->selected);
}

TEST_CASE("RuntimeSessionHost supports multi-object action selection semantics")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_multi_action_project(false)).success);
    host.tick(0.0);

    auto* combine = find_action(host.view_state(), "combine");
    REQUIRE(combine != nullptr);
    CHECK_FALSE(combine->enabled);
    CHECK(combine->reason == "requires 2 objects");

    REQUIRE(host.apply_input(
                    RuntimeInput{.type = RuntimeInputType::SelectObject, .object_ids = {"coin"}})
                .handled);
    REQUIRE(host.apply_input(
                    RuntimeInput{.type = RuntimeInputType::SelectObject, .object_ids = {"lamp"}})
                .handled);
    combine = find_action(host.view_state(), "combine");
    REQUIRE(combine != nullptr);
    CHECK(combine->enabled);
    CHECK(combine->selected_count == 2);

    auto result =
        host.apply_input(RuntimeInput{.type = RuntimeInputType::RunAction, .verb_id = "combine"});
    CHECK(result.handled);
    CHECK(has_command(host.last_commands(), ControllerCommandType::ActionResolved));
}

TEST_CASE("RuntimeSessionHost preserves position-dependent action order")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_multi_action_project(true)).success);
    host.tick(0.0);

    auto reversed = host.apply_input(RuntimeInput{
        .type = RuntimeInputType::RunAction, .verb_id = "combine", .object_ids = {"coin", "lamp"}});
    CHECK(reversed.handled);
    REQUIRE(has_command(host.last_commands(), ControllerCommandType::ActionResolved));
    CHECK(host.last_commands().back().data.value("used_default", false));

    auto ordered = host.apply_input(RuntimeInput{
        .type = RuntimeInputType::RunAction, .verb_id = "combine", .object_ids = {"lamp", "coin"}});
    CHECK(ordered.handled);
    REQUIRE(has_command(host.last_commands(), ControllerCommandType::ActionResolved));
    CHECK_FALSE(host.last_commands().back().data.value("used_default", true));
}

TEST_CASE("RuntimeSessionHost accepts reversed order for order-insensitive actions")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_multi_action_project(false)).success);
    host.tick(0.0);

    auto result = host.apply_input(RuntimeInput{
        .type = RuntimeInputType::RunAction, .verb_id = "combine", .object_ids = {"coin", "lamp"}});
    CHECK(result.handled);
    REQUIRE(has_command(host.last_commands(), ControllerCommandType::ActionResolved));
    CHECK_FALSE(host.last_commands().back().data.value("used_default", true));
}

TEST_CASE("RuntimeSessionHost restores saved log strings into structured view state")
{
    auto save = SaveDocument::new_save();
    save.root()[project_ids::log] = nlohmann::json::array({"loaded", "[b]rich[/b]"});

    RuntimeSessionHost host;
    REQUIRE(host.load(make_room_project(), save).success);

    const auto& log = host.view_state().text_log;
    REQUIRE(log.size() == 2);
    CHECK(log[0].sequence == 0);
    CHECK(log[0].plain_text == "loaded");
    CHECK(log[0].rich_text.plain_text == "loaded");
    CHECK(log[1].sequence == 1);
    CHECK(log[1].plain_text == "[b]rich[/b]");
    CHECK(log[1].rich_text.plain_text == "rich");
}

TEST_CASE("RuntimeSessionHost emits structured text log output payloads")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_room_project()).success);

    RuntimeEvent event;
    event.type = RuntimeEventType::TextLogged;
    event.text = "[i]Hello[/i]";
    event.data = {{"speaker", "Guide"},
                  {"source", EntityRef{EntityType::Dialogue, "intro"}.to_json()},
                  {"category", "dialogue"}};
    host.session().events().push(std::move(event));

    auto result = host.flush_pending_outputs(12);

    CHECK(result.handled);
    REQUIRE(result.view.text_log.size() == 1);
    REQUIRE(has_output(result.outputs, RuntimeOutputType::TextLogEntry));
    for (const auto& output : result.outputs) {
        if (output.type != RuntimeOutputType::TextLogEntry) {
            continue;
        }
        CHECK(output.step_index == 12);
        CHECK(output.payload["sequence"] == 0);
        CHECK(output.payload["plain_text"] == "[i]Hello[/i]");
        CHECK(output.payload["rich_text"]["plain_text"] == "Hello");
        CHECK(output.payload["speaker"] == "Guide");
        CHECK(output.payload["source"] == ref(EntityType::Dialogue, "intro"));
        CHECK(output.payload["category"] == "dialogue");
    }
}

TEST_CASE("RuntimeSessionHost saves, loads, and autosaves through slot store")
{
    MemorySaveSlotStore slots;
    RuntimeSessionHost host;
    host.set_save_slot_store(&slots);
    REQUIRE(host.load(make_action_project()).success);
    host.tick(0.0);

    host.session().set_property("saved_value", "before");
    host.session().set_object_location(
        "lamp", EntityRef{EntityType::CustomScript, std::string(project_ids::player)});
    auto saved = host.save(SaveSlotId{2});
    CHECK(saved.handled);
    CHECK(slots.has_slot(SaveSlotId{2}));
    CHECK(has_output(saved.outputs, RuntimeOutputType::SaveMutationRequest));

    host.session().set_property("saved_value", "after");
    host.session().set_object_location("lamp", EntityRef{EntityType::Room, "kitchen"});
    auto loaded = host.load_save(SaveSlotId{2});
    CHECK(loaded.handled);
    CHECK(host.session().property("saved_value") == "before");
    auto location = host.session().effective_object_location("lamp");
    REQUIRE(location.has_value());
    CHECK(location->type == EntityType::CustomScript);
    CHECK(location->id == project_ids::player);

    auto autosaved = host.autosave();
    CHECK(autosaved.handled);
    CHECK(slots.has_slot(SaveSlotId::autosave()));
}

TEST_CASE("RuntimeSessionHost handles LoadSave input payload")
{
    RuntimeSessionHost host;
    REQUIRE(host.load(make_room_project()).success);
    host.tick(0.0);

    auto save = host.snapshot_save();
    save.root()[project_ids::entrypoint_entity] = ref(EntityType::Room, "kitchen");
    save.root().erase("_novelteaRuntime");

    RuntimeInput input;
    input.type = RuntimeInputType::LoadSave;
    input.payload["save"] = save.root();
    auto result = host.apply_input(input);

    CHECK(result.handled);
    host.tick(0.0);
    CHECK(host.view_state().title == "Kitchen");
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
