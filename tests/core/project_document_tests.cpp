#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/legacy/project_importer.hpp>
#include <noveltea/core/project_document.hpp>
#include <noveltea/core/project_ids.hpp>

using namespace noveltea::core;
using noveltea::core::legacy::ImportError;
using noveltea::core::legacy::ProjectImporter;

TEST_CASE("ProjectDocument new_project creates old-compatible default project keys")
{
    auto project = ProjectDocument::new_project();
    const auto& root = project.root();

    CHECK(project.has_required_project_keys());
    CHECK(root.contains(project_ids::engine_version));
    CHECK(root.contains(project_ids::project_name));
    CHECK(root.contains(project_ids::project_version));
    CHECK(root.contains(project_ids::project_author));
    CHECK(root.contains(project_ids::project_font_default));
    CHECK(root.contains(project_ids::project_fonts));
    CHECK(root.contains(project_ids::starting_inventory));
    CHECK(root.contains(project_ids::script_before_save));
    CHECK(root.contains(project_ids::script_after_load));
    CHECK(root.contains(project_ids::script_before_action));
    CHECK(root.contains(project_ids::script_undefined_action));
    CHECK(root.contains(project_ids::textures));
    CHECK(root.contains(project_ids::shaders));
    CHECK(root.contains(project_ids::system_shaders));
    CHECK(root.contains(project_ids::engine_fonts));

    for (auto key : project.entity_collection_keys()) {
        INFO("collection key: " << key);
        CHECK(root.contains(key));
        REQUIRE(root[key].is_object());
    }

    CHECK(root[project_ids::project_name] == "Project Name");
    CHECK(root[project_ids::project_version] == "1.0");
    CHECK(root[project_ids::project_author] == "Author Name");
    CHECK(root[project_ids::project_font_default] == "sys");
    REQUIRE(root[project_ids::engine_fonts].is_object());
    REQUIRE(root[project_ids::project_fonts].is_object());
    REQUIRE(root[project_ids::starting_inventory].is_array());
    REQUIRE(root[project_ids::textures].is_object());
    REQUIRE(root[project_ids::shaders].is_object());
    REQUIRE(root[project_ids::system_shaders].is_array());
    CHECK(root[project_ids::script_before_action] == "return true;");
    CHECK(root[project_ids::script_undefined_action] == "return false;");
    CHECK(root[project_ids::script_before_leave] == "return true;");
    CHECK(root[project_ids::script_before_enter] == "return true;");
}

TEST_CASE("ProjectDocument new_project is normalized rather than exact legacy wire format")
{
    const auto root = ProjectDocument::new_project().root();

    CHECK(root[project_ids::project_fonts].is_object());
    CHECK(root[project_ids::textures].is_object());
}

TEST_CASE("ProjectDocument validates old entrypoint requirement")
{
    auto project = ProjectDocument::new_project();
    std::string error;

    CHECK_FALSE(project.validate_entrypoint(&error));
    CHECK(error == "No valid entry point defined in project settings.");

    project.root()[project_ids::entrypoint_entity] = EntityRef {EntityType::Cutscene, ""}.to_json();
    CHECK_FALSE(project.validate_entrypoint(&error));

    project.root()[project_ids::entrypoint_entity] = EntityRef {EntityType::Cutscene, "intro"}.to_json();
    CHECK(project.validate_entrypoint(&error));
    CHECK(error.empty());
}

TEST_CASE("ProjectDocument round-trips through its JSON representation")
{
    auto project = ProjectDocument::new_project();
    project.root()[project_ids::entrypoint_entity] = EntityRef {EntityType::Room, "start_room"}.to_json();

    ProjectDocument copy(project.root());

    CHECK(copy.root() == project.root());
    CHECK(copy.dump() == project.dump());
    CHECK(copy.has_required_project_keys());
    CHECK(copy.has_valid_entrypoint());
}

TEST_CASE("legacy ProjectImporter imports representative old game JSON")
{
    auto legacy = nlohmann::json::object({
        {project_ids::engine_version, 1.0},
        {project_ids::project_name, "Legacy Game"},
        {project_ids::project_version, "0.9"},
        {project_ids::project_author, "Author"},
        {project_ids::project_website, "https://example.invalid"},
        {project_ids::project_font_default, "sys"},
        {project_ids::project_fonts, nlohmann::json::array()},
        {project_ids::starting_inventory, nlohmann::json::array()},
        {project_ids::script_before_save, ""},
        {project_ids::script_after_load, ""},
        {project_ids::script_after_action, ""},
        {project_ids::script_before_action, "return true;"},
        {project_ids::script_undefined_action, "return false;"},
        {project_ids::script_after_leave, ""},
        {project_ids::script_before_leave, "return true;"},
        {project_ids::script_after_enter, ""},
        {project_ids::script_before_enter, "return true;"},
        {project_ids::open_tabs, nlohmann::json::array()},
        {project_ids::open_tab_index, -1},
        {project_ids::textures, nlohmann::json::array()},
        {project_ids::shaders, nlohmann::json::object({
            {"defaultFrag", "legacy fragment source"},
            {"defaultVert", "legacy vertex source"},
        })},
        {project_ids::system_shaders, nlohmann::json::array({"defaultFrag", "defaultFrag"})},
        {project_ids::engine_fonts, nlohmann::json::object({
            {"sys", "LiberationSans.ttf"},
            {"sysIcon", "fontawesome.ttf"},
        })},
    });
    for (auto key : project_ids::entity_collection_keys) {
        legacy[key] = nlohmann::json::object();
    }
    legacy[project_ids::entrypoint_entity] = EntityRef {EntityType::Cutscene, "intro"}.to_json();

    std::vector<ImportError> errors;
    const auto result = ProjectImporter::import_game_json_text(legacy.dump(), errors);

    REQUIRE(result.has_value());
    CHECK(errors.empty());
    CHECK(result->document.root() == legacy);
    CHECK(result->document.has_valid_entrypoint());
}

TEST_CASE("legacy ProjectImporter reports malformed JSON diagnostics")
{
    std::vector<ImportError> errors;
    const auto result = ProjectImporter::import_game_json_text("{\"name\":", errors);

    CHECK_FALSE(result.has_value());
    REQUIRE_FALSE(errors.empty());
    CHECK(errors.front().message.find("Malformed legacy project JSON") != std::string::npos);
}

TEST_CASE("legacy ProjectImporter reports legacy shape diagnostics")
{
    auto legacy = ProjectDocument::new_project().root();
    legacy[project_ids::project_fonts] = nlohmann::json::array();
    legacy[project_ids::textures] = nlohmann::json::array();
    legacy.erase(project_ids::project_name);
    legacy[project_ids::object] = nlohmann::json::array();
    legacy[project_ids::entrypoint_entity] = nlohmann::json::object();

    std::vector<ImportError> errors;
    const auto result = ProjectImporter::import_game_json(legacy, errors);

    CHECK_FALSE(result.has_value());
    REQUIRE(errors.size() >= 3);
    CHECK(errors[0].message.find("missing required key 'name'") != std::string::npos);
    CHECK(errors[1].message.find("entity collection 'object' must be an object") != std::string::npos);
    CHECK(errors[2].message.find("entrypoint must use selected-entity array shape") != std::string::npos);
}
