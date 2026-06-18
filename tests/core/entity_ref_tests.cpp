#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/project_ids.hpp>

using namespace noveltea::core;

TEST_CASE("old EntityType integer values are preserved")
{
    CHECK(to_integer(EntityType::Invalid) == -1);
    CHECK(to_integer(EntityType::CustomScript) == 0);
    CHECK(to_integer(EntityType::Cutscene) == 1);
    CHECK(to_integer(EntityType::Action) == 2);
    CHECK(to_integer(EntityType::Room) == 3);
    CHECK(to_integer(EntityType::Object) == 4);
    CHECK(to_integer(EntityType::Dialogue) == 5);
    CHECK(to_integer(EntityType::Script) == 6);
    CHECK(to_integer(EntityType::Verb) == 7);
    CHECK(to_integer(EntityType::Map) == 8);
}

TEST_CASE("old project and entity key strings are preserved")
{
    CHECK(project_ids::engine_version == "engine");
    CHECK(project_ids::engine_fonts == "sysfonts");
    CHECK(project_ids::project_name == "name");
    CHECK(project_ids::project_version == "version");
    CHECK(project_ids::project_author == "author");
    CHECK(project_ids::project_website == "website");
    CHECK(project_ids::project_fonts == "fonts");
    CHECK(project_ids::project_font_default == "fontDefault");
    CHECK(project_ids::starting_inventory == "startInv");
    CHECK(project_ids::entrypoint_entity == "entrypoint");
    CHECK(project_ids::entrypoint_metadata == "entrydata");
    CHECK(project_ids::quick_verb == "quickVerb");
    CHECK(project_ids::script_before_save == "sbs");
    CHECK(project_ids::script_after_load == "sas");
    CHECK(project_ids::script_after_action == "saa");
    CHECK(project_ids::script_before_action == "sba");
    CHECK(project_ids::script_undefined_action == "sua");
    CHECK(project_ids::script_after_enter == "sae");
    CHECK(project_ids::script_before_enter == "sbe");
    CHECK(project_ids::script_after_leave == "sal");
    CHECK(project_ids::script_before_leave == "sbl");
    CHECK(project_ids::shaders == "shaders");
    CHECK(project_ids::system_shaders == "systemShaders");
    CHECK(project_ids::textures == "textures");

    CHECK(project_ids::action == "action");
    CHECK(project_ids::cutscene == "cutscene");
    CHECK(project_ids::dialogue == "dialogue");
    CHECK(project_ids::map == "map");
    CHECK(project_ids::object == "object");
    CHECK(project_ids::room == "room");
    CHECK(project_ids::script == "script");
    CHECK(project_ids::verb == "verb");

    CHECK(project_ids::tests == "tests");
    CHECK(project_ids::open_tabs == "tabs");
    CHECK(project_ids::open_tab_index == "tabIndex");
    CHECK(project_ids::entity_queue == "entityQueue");
    CHECK(project_ids::log == "log");
    CHECK(project_ids::save_map == "map");
    CHECK(project_ids::map_enabled == "mapEnabled");
    CHECK(project_ids::navigation_enabled == "navEnabled");
    CHECK(project_ids::object_locations == "objectLocations");
    CHECK(project_ids::play_time == "playTime");
    CHECK(project_ids::properties == "properties");
    CHECK(project_ids::room_descriptions == "roomDescriptions");
    CHECK(project_ids::visited_rooms == "visitedRooms");
}

TEST_CASE("EntityRef serializes to the old selected-entity array convention")
{
    const EntityRef ref {EntityType::Cutscene, "intro"};
    const auto json = ref.to_json();

    REQUIRE(json.is_array());
    REQUIRE(json.size() == 2);
    CHECK(json[project_ids::select_entity_type] == 1);
    CHECK(json[project_ids::select_entity_id] == "intro");
}

TEST_CASE("EntityRef parses valid selected-entity arrays")
{
    const nlohmann::json json = nlohmann::json::array({5, "dialogue_a"});
    const auto ref = EntityRef::from_json(json);

    REQUIRE(ref.has_value());
    CHECK(ref->type == EntityType::Dialogue);
    CHECK(ref->id == "dialogue_a");
}

TEST_CASE("EntityRef rejects invalid selected-entity arrays")
{
    CHECK_FALSE(EntityRef::from_json(nlohmann::json()).has_value());
    CHECK_FALSE(EntityRef::from_json(nlohmann::json::array({5})).has_value());
    CHECK_FALSE(EntityRef::from_json(nlohmann::json::array({99, "bad"})).has_value());
    CHECK_FALSE(EntityRef::from_json(nlohmann::json::array({5, 42})).has_value());
}
