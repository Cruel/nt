#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/project_document.hpp>
#include <noveltea/core/project_ids.hpp>

using namespace noveltea::core;

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

TEST_CASE("ProjectDocument imports valid legacy project JSON")
{
    auto legacy = ProjectDocument::new_project().root();
    legacy[project_ids::entrypoint_entity] = EntityRef {EntityType::Cutscene, "intro"}.to_json();

    const auto result = ProjectDocument::import_legacy_json_text(legacy.dump());

    REQUIRE(result.success());
    REQUIRE(result.document.has_value());
    CHECK(result.document->root() == legacy);
    CHECK(result.document->has_valid_entrypoint());
}

TEST_CASE("ProjectDocument import reports malformed JSON diagnostics")
{
    const auto result = ProjectDocument::import_legacy_json_text("{\"name\":");

    CHECK_FALSE(result.success());
    CHECK_FALSE(result.document.has_value());
    REQUIRE_FALSE(result.diagnostics.empty());
    CHECK(result.diagnostics.front().find("Malformed legacy project JSON") != std::string::npos);
}

TEST_CASE("ProjectDocument import reports legacy shape diagnostics")
{
    auto legacy = ProjectDocument::new_project().root();
    legacy.erase(project_ids::project_name);
    legacy[project_ids::object] = nlohmann::json::array();
    legacy[project_ids::entrypoint_entity] = nlohmann::json::object();

    const auto result = ProjectDocument::import_legacy_json(legacy);

    CHECK_FALSE(result.success());
    CHECK_FALSE(result.document.has_value());
    REQUIRE(result.diagnostics.size() >= 3);
    CHECK(result.diagnostics[0].find("missing required key 'name'") != std::string::npos);
    CHECK(result.diagnostics[1].find("entity collection 'object' must be an object") != std::string::npos);
    CHECK(result.diagnostics[2].find("entrypoint must use selected-entity array shape") != std::string::npos);
}
