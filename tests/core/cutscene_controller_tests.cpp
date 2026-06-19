#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/cutscene_controller.hpp>
#include <noveltea/core/game_session.hpp>
#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/runtime_controller.hpp>

using namespace noveltea::core;

namespace {

nlohmann::json props()
{
    return nlohmann::json::object();
}

nlohmann::json ref(EntityType type, std::string id)
{
    return nlohmann::json::array({to_integer(type), std::move(id)});
}

ProjectDocument make_test_cutscene_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object();
    root[project_ids::verb] = nlohmann::json::object();
    root[project_ids::action] = nlohmann::json::object();
    root[project_ids::room] = nlohmann::json::object({
        {"start", nlohmann::json::array({"start", "", props(),
                                         "text='A starting room.';",
                                         "", "", "", "",
                                         nlohmann::json::array(),
                                         nlohmann::json::array(),
                                         "Start"})},
    });
    root[project_ids::map] = nlohmann::json::object();
    root[project_ids::script] = nlohmann::json::object();
    root[project_ids::dialogue] = nlohmann::json::object();
    root[project_ids::entrypoint_entity] = ref(EntityType::Room, "start");
    root[project_ids::starting_inventory] = nlohmann::json::array();

    auto pageSeg = nlohmann::json::array();
    pageSeg.push_back(2); pageSeg.push_back(true);
    pageSeg.push_back("Welcome to the game.\n\nLet's begin!");
    pageSeg.push_back("\n"); pageSeg.push_back("\n\n");
    pageSeg.push_back(0); pageSeg.push_back(1);
    pageSeg.push_back(1000); pageSeg.push_back(2000);
    pageSeg.push_back(2000); pageSeg.push_back(3000);
    pageSeg.push_back(true); pageSeg.push_back(true);
    pageSeg.push_back(0); pageSeg.push_back(0);
    pageSeg.push_back(""); pageSeg.push_back(true);

    auto segments = nlohmann::json::array();
    segments.push_back(pageSeg);

    auto cutsceneEntry = nlohmann::json::array();
    cutsceneEntry.push_back("intro");
    cutsceneEntry.push_back("");
    cutsceneEntry.push_back(props());
    cutsceneEntry.push_back(true);
    cutsceneEntry.push_back(true);
    cutsceneEntry.push_back(1.0);
    cutsceneEntry.push_back(ref(EntityType::Room, "start"));
    cutsceneEntry.push_back(segments);

    auto cutsceneRoot = nlohmann::json::object();
    cutsceneRoot["intro"] = cutsceneEntry;
    root[project_ids::cutscene] = cutsceneRoot;

    return project;
}

ProjectDocument make_multi_segment_cutscene_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object();
    root[project_ids::verb] = nlohmann::json::object();
    root[project_ids::action] = nlohmann::json::object();
    auto roomStart = nlohmann::json::array();
    roomStart.push_back("start"); roomStart.push_back(""); roomStart.push_back(props());
    roomStart.push_back("text='Room.';"); roomStart.push_back(""); roomStart.push_back("");
    roomStart.push_back(""); roomStart.push_back("");
    roomStart.push_back(nlohmann::json::array());
    roomStart.push_back(nlohmann::json::array());
    roomStart.push_back("Start");
    root[project_ids::room] = nlohmann::json::object({{"start", roomStart}});

    root[project_ids::map] = nlohmann::json::object();
    root[project_ids::script] = nlohmann::json::object();
    root[project_ids::dialogue] = nlohmann::json::object();
    root[project_ids::entrypoint_entity] = ref(EntityType::Room, "start");
    root[project_ids::starting_inventory] = nlohmann::json::array();

    nlohmann::json segments = nlohmann::json::array();

    auto text1 = nlohmann::json::array();
    text1.push_back(0); text1.push_back("Hello world!"); text1.push_back(true);
    text1.push_back(true); text1.push_back(0); text1.push_back(1000);
    text1.push_back(2000); text1.push_back(0); text1.push_back(0);
    text1.push_back(true); text1.push_back("");
    segments.push_back(text1);

    auto pb = nlohmann::json::array();
    pb.push_back(1); pb.push_back(1); pb.push_back(2000);
    pb.push_back(3000); pb.push_back(true); pb.push_back(false); pb.push_back("");
    segments.push_back(pb);

    auto text2 = nlohmann::json::array();
    text2.push_back(0); text2.push_back("Chapter 2"); text2.push_back(true);
    text2.push_back(true); text2.push_back(0); text2.push_back(1000);
    text2.push_back(2000); text2.push_back(0); text2.push_back(0);
    text2.push_back(true); text2.push_back("");
    segments.push_back(text2);

    auto cutsceneEntry = nlohmann::json::array();
    cutsceneEntry.push_back("intro");
    cutsceneEntry.push_back("");
    cutsceneEntry.push_back(props());
    cutsceneEntry.push_back(true);
    cutsceneEntry.push_back(true);
    cutsceneEntry.push_back(1.0);
    cutsceneEntry.push_back(ref(EntityType::Room, "start"));
    cutsceneEntry.push_back(segments);

    auto cutsceneRoot = nlohmann::json::object();
    cutsceneRoot["intro"] = cutsceneEntry;
    root[project_ids::cutscene] = cutsceneRoot;
    return project;
}

ProjectDocument make_script_cutscene_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object();
    root[project_ids::verb] = nlohmann::json::object();
    root[project_ids::action] = nlohmann::json::object();
    auto roomStart = nlohmann::json::array();
    roomStart.push_back("start"); roomStart.push_back(""); roomStart.push_back(props());
    roomStart.push_back("text='Room.';"); roomStart.push_back(""); roomStart.push_back("");
    roomStart.push_back(""); roomStart.push_back("");
    roomStart.push_back(nlohmann::json::array());
    roomStart.push_back(nlohmann::json::array());
    roomStart.push_back("Start");
    root[project_ids::room] = nlohmann::json::object({{"start", roomStart}});

    root[project_ids::map] = nlohmann::json::object();
    root[project_ids::script] = nlohmann::json::object();
    root[project_ids::dialogue] = nlohmann::json::object();
    root[project_ids::entrypoint_entity] = ref(EntityType::Room, "start");
    root[project_ids::starting_inventory] = nlohmann::json::array();

    nlohmann::json segments = nlohmann::json::array();

    auto scriptSeg = nlohmann::json::array();
    scriptSeg.push_back(3); scriptSeg.push_back("log('intro started');");
    scriptSeg.push_back(false); scriptSeg.push_back(true);
    scriptSeg.push_back(false); scriptSeg.push_back("");
    segments.push_back(scriptSeg);

    auto textSeg = nlohmann::json::array();
    textSeg.push_back(0); textSeg.push_back("After script"); textSeg.push_back(true);
    textSeg.push_back(true); textSeg.push_back(0); textSeg.push_back(1000);
    textSeg.push_back(2000); textSeg.push_back(0); textSeg.push_back(0);
    textSeg.push_back(true); textSeg.push_back("");
    segments.push_back(textSeg);

    auto cutsceneEntry = nlohmann::json::array();
    cutsceneEntry.push_back("intro");
    cutsceneEntry.push_back("");
    cutsceneEntry.push_back(props());
    cutsceneEntry.push_back(true);
    cutsceneEntry.push_back(true);
    cutsceneEntry.push_back(1.0);
    cutsceneEntry.push_back(ref(EntityType::Room, "start"));
    cutsceneEntry.push_back(segments);

    auto cutsceneRoot = nlohmann::json::object();
    cutsceneRoot["intro"] = cutsceneEntry;
    root[project_ids::cutscene] = cutsceneRoot;
    return project;
}

bool has_command(const std::vector<ControllerCommand>& commands, ControllerCommandType type)
{
    for (const auto& cmd : commands) {
        if (cmd.type == type)
            return true;
    }
    return false;
}

} // namespace

TEST_CASE("CutsceneController starts and emits text from page expansion")
{
    GameSession session;
    REQUIRE(session.load(make_test_cutscene_project()).success);

    CutsceneController controller(session);
    controller.start("intro");

    CHECK_FALSE(controller.is_complete());
    CHECK(controller.current_cutscene_id() == "intro");

    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::CutsceneText));

    const auto* text_cmd = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::CutsceneText)
                return &c;
        }
        return nullptr;
    }();
    REQUIRE(text_cmd != nullptr);
    CHECK(text_cmd->text == "Welcome to the game.");
}

TEST_CASE("CutsceneController click advances through text segments")
{
    GameSession session;
    REQUIRE(session.load(make_multi_segment_cutscene_project()).success);

    CutsceneController controller(session);
    controller.start("intro");
    (void)controller.take_commands();

    CHECK(controller.is_waiting_for_click());

    controller.click();
    // PageBreak auto-advances to next Text segment which waits for click
    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::CutscenePageBreak));
}

TEST_CASE("CutsceneController click through all segments completes")
{
    GameSession session;
    REQUIRE(session.load(make_multi_segment_cutscene_project()).success);

    CutsceneController controller(session);
    controller.start("intro");
    (void)controller.take_commands();

    // Click through text 1 -> page break -> text 2 -> complete
    controller.click();
    (void)controller.take_commands();
    controller.click();
    auto commands = controller.take_commands();

    CHECK(controller.is_complete());
    CHECK(has_command(commands, ControllerCommandType::CutsceneComplete));

    const auto* complete_cmd = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::CutsceneComplete)
                return &c;
        }
        return nullptr;
    }();
    REQUIRE(complete_cmd != nullptr);
    CHECK(complete_cmd->data.value("next_entity_id", "") == "start");
    CHECK(complete_cmd->data.value("next_entity_type", -1) == to_integer(EntityType::Room));
}

TEST_CASE("CutsceneController script segment emits ScriptDeferred")
{
    GameSession session;
    REQUIRE(session.load(make_script_cutscene_project()).success);

    CutsceneController controller(session);
    controller.start("intro");
    auto commands = controller.take_commands();

    // Script segment emits ScriptDeferred, then auto-advances to Text which emits CutsceneText
    CHECK(has_command(commands, ControllerCommandType::ScriptDeferred));
    CHECK(has_command(commands, ControllerCommandType::CutsceneText));

    // Click to complete
    controller.click();
    commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::CutsceneComplete));
}

TEST_CASE("CutsceneController reset clears state")
{
    GameSession session;
    REQUIRE(session.load(make_test_cutscene_project()).success);

    CutsceneController controller(session);
    controller.start("intro");
    CHECK_FALSE(controller.is_complete());

    controller.reset();
    CHECK(controller.is_complete());
    CHECK(controller.current_cutscene_id().empty());
}

TEST_CASE("CutsceneController save_state and restore_state round-trip")
{
    GameSession session;
    REQUIRE(session.load(make_test_cutscene_project()).success);

    CutsceneController controller(session);
    controller.start("intro");
    (void)controller.take_commands();

    auto saved = controller.save_state();

    CutsceneController restored(session);
    restored.restore_state(saved);

    CHECK(restored.current_cutscene_id() == "intro");
    CHECK(restored.is_waiting_for_click());
}
