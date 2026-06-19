#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/project_model.hpp>

using namespace noveltea::core;

namespace {

nlohmann::json ref(EntityType type, std::string id)
{
    return nlohmann::json::array({to_integer(type), std::move(id)});
}

nlohmann::json props(std::initializer_list<std::pair<const char*, nlohmann::json>> values = {})
{
    auto out = nlohmann::json::object();
    for (const auto& [name, value] : values) {
        out[name] = value;
    }
    return out;
}

ProjectDocument make_model_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();

    root[project_ids::object] = nlohmann::json::object({
        {"thing", nlohmann::json::array({"thing", "", props({{"weight", 2}, {"name", "base"}}), "Thing", false})},
        {"lamp", nlohmann::json::array({"lamp", "thing", props({{"name", "lamp"}}), "Lamp", true})},
    });
    root[project_ids::verb] = nlohmann::json::object({
        {"take", nlohmann::json::array({"take", "", props(), "Take", 1, "return false;", "return true;",
                                         nlohmann::json::array({"take", ""})})},
    });
    root[project_ids::action] = nlohmann::json::object({
        {"take_lamp", nlohmann::json::array({"take_lamp", "", props(), "take", "setProp('taken', true);",
                                             nlohmann::json::array({"lamp"}), true})},
    });
    root[project_ids::room] = nlohmann::json::object({
        {"foyer", nlohmann::json::array({"foyer", "", props({{"lit", false}}), "text='Foyer';", "beforeEnter();",
                                         "afterEnter();", "beforeLeave();", "afterLeave();",
                                         nlohmann::json::array({nlohmann::json::array({"lamp", true})}),
                                         nlohmann::json::array({nlohmann::json::array({true, ref(EntityType::Room, "foyer")})}),
                                         "Foyer"})},
    });
    root[project_ids::map] = nlohmann::json::object({
        {"main", nlohmann::json::array({"main", "", props(), "roomDefault();", "pathDefault();",
                                        nlohmann::json::array({nlohmann::json::array(
                                            {"Foyer", 0, 0, 10, 10, nlohmann::json::array({"foyer"}), "visible();", 1})}),
                                        nlohmann::json::array({nlohmann::json::array({0, 0, 0, 0, 1, 1, "path();", 0})})})},
    });
    root[project_ids::dialogue] = nlohmann::json::object({
        {"intro_dialogue", nlohmann::json::array({"intro_dialogue", "", props(), "Guide", ref(EntityType::Room, "foyer"),
                                                  0, false, true, 1,
                                                  nlohmann::json::array({nlohmann::json::array(
                                                      {0, -1, false, false, false, false, false, true, "", "", "",
                                                       nlohmann::json::array({1})}),
                                                                         nlohmann::json::array(
                                                                             {1, -1, true, false, true, true, false,
                                                                              true, "return true;", "script();", "Hello",
                                                                              nlohmann::json::array()})})})},
    });
    root[project_ids::cutscene] = nlohmann::json::object({
        {"intro", nlohmann::json::array({"intro", "", props(), true, false, 1.5, ref(EntityType::Dialogue, "intro_dialogue"),
                                         nlohmann::json::array({nlohmann::json::array(
                                             {0, false, "", 0, 1000, 100, 0, 0, true, true, "Hello"})})})},
    });
    root[project_ids::script] = nlohmann::json::object({
        {"boot", nlohmann::json::array({"boot", "", props(), true, "boot();"})},
    });
    root[project_ids::entrypoint_entity] = ref(EntityType::Cutscene, "intro");
    root[project_ids::starting_inventory] = nlohmann::json::array({"lamp"});
    return project;
}

} // namespace

TEST_CASE("ProjectModel materializes typed entity stores from validated document")
{
    std::vector<ValidationIssue> issues;
    const auto model = ProjectModel::from_document(make_model_project(), issues);

    REQUIRE(model.has_value());
    CHECK(issues.empty());
    CHECK(model->objects().size() == 2);
    CHECK(model->verbs().size() == 1);
    CHECK(model->actions().size() == 1);
    CHECK(model->rooms().size() == 1);
    CHECK(model->maps().size() == 1);
    CHECK(model->dialogues().size() == 1);
    CHECK(model->cutscenes().size() == 1);
    CHECK(model->scripts().size() == 1);

    const auto& lamp = model->objects().at("lamp");
    CHECK(lamp.metadata.entity.type == EntityType::Object);
    CHECK(lamp.metadata.entity.id == "lamp");
    CHECK(lamp.metadata.parent_id == "thing");
    CHECK(lamp.name == "Lamp");
    CHECK(lamp.case_sensitive);

    const auto& action = model->actions().at("take_lamp");
    CHECK(action.verb_id == "take");
    CHECK(action.object_ids == std::vector<std::string> {"lamp"});
    CHECK(action.position_dependent);
}

TEST_CASE("ProjectModel owns nested room map dialogue and cutscene values")
{
    std::vector<ValidationIssue> issues;
    const auto model = ProjectModel::from_document(make_model_project(), issues);
    REQUIRE(model.has_value());

    const auto& room = model->rooms().at("foyer");
    REQUIRE(room.objects.size() == 1);
    CHECK(room.objects[0].object_id == "lamp");
    REQUIRE(room.paths.size() == 1);
    CHECK(room.paths[0].enabled);
    REQUIRE(room.paths[0].target.has_value());
    CHECK(room.paths[0].target->type == EntityType::Room);

    const auto& map = model->maps().at("main");
    REQUIRE(map.rooms.size() == 1);
    CHECK(map.rooms[0].room_ids == std::vector<std::string> {"foyer"});
    REQUIRE(map.connections.size() == 1);
    CHECK(map.connections[0].script == "path();");

    const auto& dialogue = model->dialogues().at("intro_dialogue");
    CHECK(dialogue.default_name == "Guide");
    REQUIRE(dialogue.segments.size() == 2);
    CHECK(dialogue.segments[1].autosave);
    CHECK(dialogue.segments[1].text_raw == "Hello");

    const auto& cutscene = model->cutscenes().at("intro");
    CHECK_FALSE(cutscene.can_fast_forward);
    CHECK(cutscene.speed_factor == 1.5);
    REQUIRE(cutscene.segments.size() == 1);
    CHECK(cutscene.segments[0].record[10] == "Hello");
}

TEST_CASE("ProjectModel exposes parent metadata and merged project properties")
{
    std::vector<ValidationIssue> issues;
    const auto model = ProjectModel::from_document(make_model_project(), issues);
    REQUIRE(model.has_value());

    const auto parent = model->parent_metadata(EntityType::Object, "lamp");
    REQUIRE(parent.has_value());
    CHECK(parent->entity.id == "thing");

    const auto merged = model->merged_properties(EntityType::Object, "lamp");
    CHECK(merged["weight"] == 2);
    CHECK(merged["name"] == "lamp");

    CHECK_FALSE(model->parent_metadata(EntityType::Object, "thing").has_value());
    CHECK(model->merged_properties(EntityType::Object, "missing").empty());
}

TEST_CASE("ProjectModel refuses invalid project and returns validation issues")
{
    auto project = make_model_project();
    project.root()[project_ids::entrypoint_entity] = ref(EntityType::Cutscene, "missing");

    std::vector<ValidationIssue> issues;
    const auto model = ProjectModel::from_document(project, issues);

    CHECK_FALSE(model.has_value());
    REQUIRE_FALSE(issues.empty());
    CHECK(issues[0].path == "/entrypoint");
}
