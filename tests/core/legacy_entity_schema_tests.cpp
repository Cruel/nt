#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/legacy/entity_schema.hpp>

using namespace noveltea::core;
using namespace noveltea::core::legacy;

namespace {

nlohmann::json props() { return nlohmann::json::object({{"seen", true}}); }

nlohmann::json ref(EntityType type, std::string id)
{
    return nlohmann::json::array({to_integer(type), std::move(id)});
}

} // namespace

TEST_CASE("legacy entity schema parses scalar entity array records")
{
    std::vector<SchemaError> errors;

    auto object = parse_entity_record(EntityType::Object,
                                      nlohmann::json::array({"lamp", "", props(), "Lamp", false}),
                                      errors, "object/lamp");
    REQUIRE(object.has_value());
    REQUIRE(object->object.has_value());
    CHECK(object->object->header.id == "lamp");
    CHECK(object->object->name == "Lamp");
    CHECK_FALSE(object->object->case_sensitive);

    auto script = parse_entity_record(
        EntityType::Script, nlohmann::json::array({"boot", "", props(), true, "toast('hi');"}),
        errors, "script/boot");
    REQUIRE(script.has_value());
    REQUIRE(script->script.has_value());
    CHECK(script->script->autorun);
    CHECK(script->script->content == "toast('hi');");

    auto action = parse_entity_record(
        EntityType::Action,
        nlohmann::json::array({"take_lamp", "", props(), "take", "setProp('x', 1);",
                               nlohmann::json::array({"lamp"}), true}),
        errors, "action/take_lamp");
    REQUIRE(action.has_value());
    REQUIRE(action->action.has_value());
    CHECK(action->action->verb_id == "take");
    CHECK(action->action->object_ids == std::vector<std::string>{"lamp"});
    CHECK(action->action->position_dependent);

    auto verb = parse_entity_record(
        EntityType::Verb,
        nlohmann::json::array({"take", "", props(), "Take", 1, "return false;", "return true;",
                               nlohmann::json::array({"take", ""})}),
        errors, "verb/take");
    REQUIRE(verb.has_value());
    REQUIRE(verb->verb.has_value());
    CHECK(verb->verb->object_count == 1);
    CHECK(verb->verb->action_structure == std::vector<std::string>{"take", ""});

    CHECK(errors.empty());
}

TEST_CASE("legacy entity schema parses room and map nested records")
{
    std::vector<SchemaError> errors;

    auto room = parse_entity_record(
        EntityType::Room,
        nlohmann::json::array(
            {"foyer", "", props(), "text='Foyer';", "return true;", "", "return true;", "",
             nlohmann::json::array({nlohmann::json::array({"lamp", true})}),
             nlohmann::json::array({nlohmann::json::array({true, ref(EntityType::Room, "hall")})}),
             "Foyer"}),
        errors, "room/foyer");
    REQUIRE(room.has_value());
    REQUIRE(room->room.has_value());
    CHECK(room->room->objects.size() == 1);
    CHECK(room->room->objects[0].object_id == "lamp");
    CHECK(room->room->paths != nullptr);
    CHECK(room->room->name == "Foyer");

    auto map = parse_entity_record(
        EntityType::Map,
        nlohmann::json::array(
            {"main", "", props(), "return true;", "return true;",
             nlohmann::json::array({nlohmann::json::array(
                 {"Foyer", 1, 2, 10, 12, nlohmann::json::array({"foyer"}), "", 1})}),
             nlohmann::json::array({nlohmann::json::array({0, 0, 1, 2, 3, 4, "", 0})})}),
        errors, "map/main");
    REQUIRE(map.has_value());
    REQUIRE(map->map.has_value());
    REQUIRE(map->map->rooms.size() == 1);
    CHECK(map->map->rooms[0].room_ids == std::vector<std::string>{"foyer"});
    REQUIRE(map->map->connections.size() == 1);
    CHECK(map->map->connections[0].port_end_y == 4);

    CHECK(errors.empty());
}

TEST_CASE("legacy entity schema parses dialogue and cutscene records")
{
    std::vector<SchemaError> errors;

    auto dialogue_segment =
        nlohmann::json::array({1, -1, true, false, true, false, true, true, "return true;",
                               "toast('x');", "[Guide] Hello", nlohmann::json::array({1, 2})});
    auto dialogue =
        parse_entity_record(EntityType::Dialogue,
                            nlohmann::json::array({"intro_dialogue", "", props(), "Guide",
                                                   ref(EntityType::Room, "foyer"), 0, false, true,
                                                   1, nlohmann::json::array({dialogue_segment})}),
                            errors, "dialogue/intro_dialogue");
    REQUIRE(dialogue.has_value());
    REQUIRE(dialogue->dialogue.has_value());
    CHECK(dialogue->dialogue->default_name == "Guide");
    REQUIRE(dialogue->dialogue->next_entity.has_value());
    CHECK(dialogue->dialogue->next_entity->type == EntityType::Room);
    REQUIRE(dialogue->dialogue->segments.size() == 1);
    CHECK(dialogue->dialogue->segments[0].children_ids == std::vector<int>{1, 2});

    auto cutscene = parse_entity_record(
        EntityType::Cutscene,
        nlohmann::json::array(
            {"intro", "", props(), true, true, 1.25, ref(EntityType::Dialogue, "intro_dialogue"),
             nlohmann::json::array({
                 nlohmann::json::array({0, false, "", 0, 1000, 200, 0, 0, true, true, "Hello"}),
                 nlohmann::json::array({1, false, "", 1, 2000, 300, false}),
                 nlohmann::json::array({2, true, "A\nB", "\n", "\n\n", 0, 1, 1000, 200, 2000, 300,
                                        true, true, 0, 0, "", true}),
                 nlohmann::json::array({3, false, true, "comment", "script();", ""}),
             })}),
        errors, "cutscene/intro");
    REQUIRE(cutscene.has_value());
    REQUIRE(cutscene->cutscene.has_value());
    CHECK(cutscene->cutscene->speed_factor == 1.25);
    REQUIRE(cutscene->cutscene->segments.size() == 4);
    CHECK(cutscene->cutscene->segments[3].type == 3);

    CHECK(errors.empty());
}

TEST_CASE("legacy entity schema parses keyed project entity collections and reports mismatched ids")
{
    std::vector<SchemaError> errors;
    const auto collection = nlohmann::json::object({
        {"lamp", nlohmann::json::array({"lamp", "", props(), "Lamp", false})},
        {"bad_key", nlohmann::json::array({"other", "", props(), "Other", false})},
    });

    auto entities = parse_project_entities(EntityType::Object, collection, errors, "object");

    REQUIRE(entities.size() == 1);
    REQUIRE(entities[0].object.has_value());
    CHECK(entities[0].object->header.id == "lamp");
    REQUIRE(errors.size() == 1);
    CHECK(errors[0].path == "object/bad_key");
    CHECK(errors[0].message == "record id does not match collection key");
}

TEST_CASE("legacy entity schema reports malformed nested records with field paths")
{
    std::vector<SchemaError> errors;

    const auto parsed = parse_entity_record(
        EntityType::Map,
        nlohmann::json::array({"main", "", props(), "", "",
                               nlohmann::json::array({
                                   nlohmann::json::array({"bad room", 0, 0, 10, "wide",
                                                          nlohmann::json::array(), "", 1}),
                               }),
                               nlohmann::json::array()}),
        errors, "map/main");

    CHECK_FALSE(parsed.has_value());
    REQUIRE_FALSE(errors.empty());
    CHECK(errors[0].path == "map/main[5][0][4]");
    CHECK(errors[0].message == "expected integer");
}
