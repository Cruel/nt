#include <noveltea/core/editor_api.hpp>

#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/project_ids.hpp>

using namespace noveltea::core;
using namespace noveltea::core::editor;

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

ProjectDocument make_preview_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object({
        {"lamp", nlohmann::json::array({"lamp", "", props(), "Lamp", false})},
    });
    root[project_ids::verb] = nlohmann::json::object({
        {"look",
         nlohmann::json::array({"look", "", props(), "Look", 1, "", "", nlohmann::json::array()})},
    });
    root[project_ids::action] = nlohmann::json::object({
        {"look_lamp", nlohmann::json::array({"look_lamp", "", props(), "look", "look_lamp();",
                                             nlohmann::json::array({"lamp"}), false})},
    });
    root[project_ids::room] = nlohmann::json::object({
        {"foyer",
         nlohmann::json::array(
             {"foyer", "", props(), "A quiet foyer.", "", "", "", "",
              nlohmann::json::array({nlohmann::json::array({"lamp", true})}),
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

bool has_command(const std::vector<ControllerCommand>& commands, ControllerCommandType type)
{
    for (const auto& command : commands) {
        if (command.type == type)
            return true;
    }
    return false;
}

} // namespace

TEST_CASE("ProjectTooling loads validates and saves normalized project JSON")
{
    const auto source = make_preview_project().dump();

    auto loaded = ProjectTooling::load_project_json(source);
    REQUIRE(loaded.project.has_value());
    CHECK(loaded.success());
    CHECK_FALSE(loaded.imported_legacy);
    CHECK(loaded.diagnostics.empty());

    const auto saved = ProjectTooling::save_project_json(*loaded.project);
    auto round_trip = ProjectTooling::load_project_json(saved);
    REQUIRE(round_trip.project.has_value());
    CHECK(round_trip.success());
    CHECK(round_trip.project->root() == loaded.project->root());
}

TEST_CASE("ProjectTooling imports legacy game JSON with editor diagnostics")
{
    const auto source = make_preview_project().dump();

    auto imported = ProjectTooling::import_legacy_game_json(source);
    REQUIRE(imported.project.has_value());
    CHECK(imported.success());
    CHECK(imported.imported_legacy);

    auto malformed = ProjectTooling::import_legacy_game_json("{\"name\":");
    CHECK_FALSE(malformed.success());
    REQUIRE_FALSE(malformed.diagnostics.empty());
    CHECK(malformed.diagnostics.front().severity == DiagnosticSeverity::Error);
    CHECK(malformed.diagnostics.front().message.find("Malformed legacy project JSON") !=
          std::string::npos);
}

TEST_CASE("ProjectTooling edits entity records without old editor models")
{
    auto project = make_preview_project();

    auto set = ProjectTooling::set_entity_record(
        project, project_ids::object, "coin",
        nlohmann::json::array({"wrong_id", "", props(), "Coin", false}));
    CHECK(set.success());
    REQUIRE(set.diagnostics.size() == 1);
    CHECK(set.diagnostics.front().severity == DiagnosticSeverity::Warning);
    CHECK(project.root()[project_ids::object]["coin"][0] == "coin");
    CHECK(project.root()[project_ids::object]["coin"][3] == "Coin");

    auto validation = ProjectTooling::validate_project(project);
    CHECK(validation.empty());

    auto erased = ProjectTooling::erase_entity_record(project, project_ids::object, "coin");
    CHECK(erased.success());
    CHECK_FALSE(project.root()[project_ids::object].contains("coin"));

    auto invalid =
        ProjectTooling::set_entity_record(project, "widgets", "bad", nlohmann::json::array());
    CHECK_FALSE(invalid.success());
    REQUIRE_FALSE(invalid.diagnostics.empty());
    CHECK(invalid.diagnostics.front().message.find("Unknown entity collection") !=
          std::string::npos);
}

TEST_CASE("RuntimePreviewSession controls runtime and captures emitted commands")
{
    RuntimePreviewSession preview;
    auto load = preview.load(make_preview_project());
    REQUIRE(load.success);
    CHECK(preview.loaded());
    CHECK_FALSE(preview.running());

    preview.start();
    auto state = preview.inspect_state();
    CHECK(state.loaded);
    CHECK(state.running);
    CHECK(state.mode == "room");
    CHECK(state.view.title == "Foyer");
    CHECK(state.view.map_view.available);
    CHECK(state.view.map_view.current_room_id == "foyer");
    REQUIRE(state.view.map_view.rooms.size() == 2);
    CHECK(state.view.map_view.rooms[0].current);
    CHECK(state.view.map_view.rooms[1].navigation_index == 0);
    CHECK(has_command(preview.captured_commands(), ControllerCommandType::RoomDescription));

    auto commands = preview.take_captured_commands();
    CHECK_FALSE(commands.empty());
    CHECK(preview.captured_commands().empty());

    CHECK(preview.inject_navigation_choice(0));
    preview.step(0.0);
    state = preview.inspect_state();
    CHECK(state.view.title == "Kitchen");
    CHECK(state.view.map_view.current_room_id == "kitchen");
    REQUIRE(state.view.map_view.rooms.size() == 2);
    CHECK(state.view.map_view.rooms[1].current);

    preview.stop();
    preview.step(1.0);
    CHECK_FALSE(preview.running());

    auto reset = preview.reset();
    REQUIRE(reset.success);
    CHECK_FALSE(preview.running());

    preview.start();
    CHECK(preview.running());
    CHECK(preview.inspect_state().view.title == "Foyer");
    REQUIRE(preview.inspect_state().view.objects.size() == 1);
    CHECK_FALSE(preview.inspect_state().view.objects[0].selected);
    CHECK(preview.inject_object_selection("lamp"));
    CHECK(preview.inspect_state().view.objects[0].selected);
    CHECK(preview.clear_object_selection());
    CHECK_FALSE(preview.inspect_state().view.objects[0].selected);
    CHECK(preview.inject_object_selection("lamp"));
    CHECK(preview.inject_action("look", {}));
    CHECK_FALSE(preview.inspect_state().view.objects[0].selected);
    CHECK(has_command(preview.captured_commands(), ControllerCommandType::ActionResolved));

    auto entrypoint = preview.set_entrypoint(EntityRef{EntityType::Room, "kitchen"});
    REQUIRE(entrypoint.success);
    CHECK(preview.inspect_state().view.title == "Kitchen");
}
