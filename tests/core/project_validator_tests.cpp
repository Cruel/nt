#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/project_validator.hpp>

using namespace noveltea::core;

namespace {

nlohmann::json props() { return nlohmann::json::object(); }

nlohmann::json ref(EntityType type, std::string id)
{
    return nlohmann::json::array({to_integer(type), std::move(id)});
}

ProjectDocument make_valid_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();

    root[project_ids::object] = nlohmann::json::object({
        {"lamp", nlohmann::json::array({"lamp", "", props(), "Lamp", false})},
    });
    root[project_ids::verb] = nlohmann::json::object({
        {"take", nlohmann::json::array({"take", "", props(), "Take", 1, "", "",
                                        nlohmann::json::array({"take", ""})})},
    });
    root[project_ids::action] = nlohmann::json::object({
        {"take_lamp", nlohmann::json::array({"take_lamp", "", props(), "take", "",
                                             nlohmann::json::array({"lamp"}), true})},
    });
    root[project_ids::room] = nlohmann::json::object({
        {"foyer", nlohmann::json::array(
                      {"foyer", "", props(), "text='Foyer';", "", "", "", "",
                       nlohmann::json::array({nlohmann::json::array({"lamp", true})}),
                       nlohmann::json::array(
                           {nlohmann::json::array({true, ref(EntityType::Room, "foyer")})}),
                       "Foyer"})},
    });
    root[project_ids::map] = nlohmann::json::object({
        {"main", nlohmann::json::array(
                     {"main", "", props(), "", "",
                      nlohmann::json::array({nlohmann::json::array(
                          {"Foyer", 0, 0, 10, 10, nlohmann::json::array({"foyer"}), "", 1})}),
                      nlohmann::json::array({nlohmann::json::array({0, 0, 0, 0, 1, 1, "", 0})})})},
    });
    root[project_ids::dialogue] = nlohmann::json::object({
        {"intro_dialogue",
         nlohmann::json::array(
             {"intro_dialogue", "", props(), "Guide", ref(EntityType::Room, "foyer"), 0, false,
              true, 1,
              nlohmann::json::array(
                  {nlohmann::json::array({0, -1, false, false, false, false, false, true, "", "",
                                          "", nlohmann::json::array({1})}),
                   nlohmann::json::array({1, -1, false, false, false, false, false, true, "", "",
                                          "Hello", nlohmann::json::array()})})})},
    });
    root[project_ids::cutscene] = nlohmann::json::object({
        {"intro",
         nlohmann::json::array({"intro", "", props(), true, true, 1.0,
                                ref(EntityType::Dialogue, "intro_dialogue"),
                                nlohmann::json::array({nlohmann::json::array(
                                    {0, false, "", 0, 1000, 100, 0, 0, true, true, "Hello"})})})},
    });
    root[project_ids::script] = nlohmann::json::object({
        {"boot", nlohmann::json::array({"boot", "", props(), false, ""})},
    });
    root[project_ids::entrypoint_entity] = ref(EntityType::Cutscene, "intro");
    root[project_ids::starting_inventory] = nlohmann::json::array({"lamp"});

    return project;
}

bool has_issue(const std::vector<ValidationIssue>& issues, std::string_view path,
               std::string_view text)
{
    for (const auto& issue : issues) {
        if (issue.path == path && issue.message.find(text) != std::string::npos) {
            return true;
        }
    }
    return false;
}

} // namespace

TEST_CASE("ProjectValidator accepts representative connected legacy project graph")
{
    const auto project = make_valid_project();
    const auto issues = ProjectValidator::validate(project);

    CHECK(issues.empty());
}

TEST_CASE("ProjectValidator reports missing entrypoint inventory action and room refs")
{
    auto project = make_valid_project();
    auto& root = project.root();

    root[project_ids::entrypoint_entity] = ref(EntityType::Cutscene, "missing_intro");
    root[project_ids::starting_inventory] = nlohmann::json::array({"missing_object"});
    root[project_ids::action]["take_lamp"][3] = "missing_verb";
    root[project_ids::action]["take_lamp"][5][0] = "missing_action_object";
    root[project_ids::room]["foyer"][8][0][0] = "missing_room_object";
    root[project_ids::room]["foyer"][9][0][1] = ref(EntityType::Room, "missing_room");

    const auto issues = ProjectValidator::validate(project);

    CHECK(has_issue(issues, "/entrypoint", "missing cutscene entity 'missing_intro'"));
    CHECK(has_issue(issues, "/startInv/0", "missing object entity 'missing_object'"));
    CHECK(has_issue(issues, "/action/take_lamp[3]", "missing verb entity 'missing_verb'"));
    CHECK(has_issue(issues, "/action/take_lamp[5][0]",
                    "missing object entity 'missing_action_object'"));
    CHECK(has_issue(issues, "/room/foyer[8][0][0]", "missing object entity 'missing_room_object'"));
    CHECK(has_issue(issues, "/room/foyer[9][0][1]", "missing room entity 'missing_room'"));
}

TEST_CASE("ProjectValidator reports map and dialogue graph index errors")
{
    auto project = make_valid_project();
    auto& root = project.root();

    root[project_ids::map]["main"][5][0][5][0] = "missing_room";
    root[project_ids::map]["main"][6][0][1] = 4;
    root[project_ids::dialogue]["intro_dialogue"][5] = 8;
    root[project_ids::dialogue]["intro_dialogue"][9][0][11][0] = 8;
    root[project_ids::dialogue]["intro_dialogue"][9][1][1] = 9;
    root[project_ids::cutscene]["intro"][6] = ref(EntityType::Dialogue, "missing_dialogue");

    const auto issues = ProjectValidator::validate(project);

    CHECK(has_issue(issues, "/map/main[5][0][5][0]", "missing room entity 'missing_room'"));
    CHECK(has_issue(issues, "/map/main[6][0][1]", "map connection end room index is out of range"));
    CHECK(has_issue(issues, "/dialogue/intro_dialogue[5]", "dialogue root index is out of range"));
    CHECK(has_issue(issues, "/dialogue/intro_dialogue[9][0][11][0]",
                    "dialogue child id is out of range"));
    CHECK(
        has_issue(issues, "/dialogue/intro_dialogue[9][1][1]", "dialogue link id is out of range"));
    CHECK(has_issue(issues, "/cutscene/intro[6]", "missing dialogue entity 'missing_dialogue'"));
}

TEST_CASE("ProjectValidator reports schema diagnostics without rejecting import")
{
    auto project = make_valid_project();
    project.root()[project_ids::object]["lamp"][4] = "not bool";

    const auto issues = ProjectValidator::validate(project);

    CHECK(has_issue(issues, "/object/lamp[4]", "expected boolean"));
}
