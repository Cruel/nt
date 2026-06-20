#include <noveltea/core/editor_api.hpp>

#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/project_ids.hpp>

#include <chrono>
#include <filesystem>

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

std::filesystem::path unique_temp_dir(std::string_view name)
{
    auto path = std::filesystem::temp_directory_path() /
                ("noveltea-editor-" + std::string(name) + "-" +
                 std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(path);
    return path;
}

bool has_command(const std::vector<ControllerCommand>& commands, ControllerCommandType type)
{
    for (const auto& command : commands) {
        if (command.type == type)
            return true;
    }
    return false;
}

bool has_runtime_output(const std::vector<RuntimeOutput>& outputs, RuntimeOutputType type)
{
    for (const auto& output : outputs) {
        if (output.type == type)
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

TEST_CASE("ProjectTooling exports runtime project packages for editor workflows")
{
    const auto temp = unique_temp_dir("package-export");
    PackageExportOptions options;
    options.project_name = "Editor Export";
    options.project_version = "1.0";

    const auto output = temp / "editor.ntpkg";
    const auto result =
        ProjectTooling::export_project_package(make_preview_project(), output, options);

    REQUIRE(result.success);
    CHECK(result.diagnostics.empty());
    CHECK(result.manifest["format"] == "noveltea.runtime-package");
    CHECK(result.manifest["project"]["name"] == "Editor Export");
    CHECK(result.byte_count > 0);
    CHECK(std::filesystem::exists(output));

    std::filesystem::remove_all(temp);
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

TEST_CASE("RuntimePlaybackSession runs headless steps and exports report JSON")
{
    RuntimePlaybackSpec spec;
    spec.id = "navigate";
    spec.fixed_delta_seconds = 0.0;

    RuntimePlaybackStep navigate;
    navigate.input = RuntimePlaybackInputType::Navigate;
    navigate.direction = 0;
    navigate.assertions.push_back(
        RuntimePlaybackAssertion{.type = RuntimePlaybackAssertionType::Mode, .value = "room"});
    navigate.assertions.push_back(RuntimePlaybackAssertion{
        .type = RuntimePlaybackAssertionType::CurrentRoom, .value = "kitchen"});
    navigate.assertions.push_back(
        RuntimePlaybackAssertion{.type = RuntimePlaybackAssertionType::Title, .value = "Kitchen"});
    navigate.assertions.push_back(RuntimePlaybackAssertion{
        .type = RuntimePlaybackAssertionType::OutputType, .value = "mode_changed"});
    spec.steps.push_back(std::move(navigate));

    RuntimePlaybackSession playback;
    auto report = playback.run(make_preview_project(), spec);

    CHECK(report.passed);
    REQUIRE(report.observations.size() == 1);
    CHECK(report.observations.front().handled);
    CHECK(report.final_state.view.title == "Kitchen");
    auto exported = report.to_json();
    CHECK(exported["id"] == "navigate");
    CHECK(exported["passed"] == true);
    CHECK(exported["final_state"]["current_room"] == "kitchen");
}

TEST_CASE("RuntimePlaybackSession parses project tests and supports hook assertions")
{
    auto project = make_preview_project();
    project.root()[project_ids::tests] = nlohmann::json::object({
        {"smoke",
         nlohmann::json::object({
             {project_ids::test_script_init, "set flag"},
             {project_ids::test_script_check, "check flag"},
             {project_ids::test_steps, nlohmann::json::array({
                                           nlohmann::json::object({
                                               {"input", "tick"},
                                               {"assertions", nlohmann::json::array({
                                                                  nlohmann::json::object({
                                                                      {"type", "property_equals"},
                                                                      {"key", "phase12"},
                                                                      {"expected", "ok"},
                                                                  }),
                                                              })},
                                           }),
                                       })},
         })},
    });

    std::vector<ToolDiagnostic> diagnostics;
    auto specs = RuntimePlaybackSession::specs_from_project(project, diagnostics);
    REQUIRE(diagnostics.empty());
    REQUIRE(specs.size() == 1);
    CHECK(specs.front().id == "smoke");
    CHECK(specs.front().init_script == "set flag");
    CHECK(specs.front().check_script == "check flag");

    RuntimePlaybackSession playback;
    playback.set_hook_executor([](std::string_view source, std::string_view context,
                                  std::optional<std::uint64_t> step_index,
                                  RuntimeSessionHost& host) {
        RuntimePlaybackHookResult result;
        if (source == "set flag") {
            host.session().set_property("phase12", "ok");
        }
        if (source == "check flag" && host.session().property("phase12") != "ok") {
            result.passed = false;
            RuntimeDiagnostic diagnostic;
            diagnostic.severity = RuntimeDiagnosticSeverity::Error;
            diagnostic.category = "hook";
            diagnostic.message = "phase12 property was not set";
            diagnostic.playback_step_index = step_index;
            result.diagnostics.push_back(std::move(diagnostic));
        }
        (void)context;
        return result;
    });

    auto report = playback.run(project, specs.front());
    CHECK(report.passed);
    CHECK(report.final_state.save_snapshot[project_ids::properties]["phase12"] == "ok");
    CHECK(has_runtime_output(report.outputs, RuntimeOutputType::ScriptRequest));
}

TEST_CASE("RuntimePlaybackSession reports failed assertions and invalid inputs")
{
    RuntimePlaybackSpec spec;
    spec.id = "failure";

    RuntimePlaybackStep invalid_dialogue;
    invalid_dialogue.input = RuntimePlaybackInputType::DialogueOption;
    invalid_dialogue.option_index = 0;
    invalid_dialogue.assertions.push_back(RuntimePlaybackAssertion{
        .type = RuntimePlaybackAssertionType::DiagnosticCategory, .value = "runtime-input"});
    spec.steps.push_back(std::move(invalid_dialogue));

    RuntimePlaybackStep bad_assertion;
    bad_assertion.input = RuntimePlaybackInputType::Tick;
    bad_assertion.assertions.push_back(
        RuntimePlaybackAssertion{.type = RuntimePlaybackAssertionType::Title, .value = "Nowhere"});
    spec.steps.push_back(std::move(bad_assertion));

    RuntimePlaybackSession playback;
    auto report = playback.run(make_preview_project(), spec);

    CHECK_FALSE(report.passed);
    REQUIRE(report.observations.size() == 2);
    CHECK_FALSE(report.observations[0].handled);
    CHECK_FALSE(report.observations[1].passed);
    CHECK_FALSE(report.failures.empty());
    CHECK(report.to_json()["passed"] == false);
}
