#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/dialogue_controller.hpp>
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

ProjectDocument make_test_dialogue_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object();
    root[project_ids::verb] = nlohmann::json::object();
    root[project_ids::action] = nlohmann::json::object();

    auto roomStart = nlohmann::json::array();
    roomStart.push_back("start"); roomStart.push_back("");
    roomStart.push_back(props());
    roomStart.push_back("text='A starting room.';");
    roomStart.push_back(""); roomStart.push_back(""); roomStart.push_back("");
    roomStart.push_back("");
    roomStart.push_back(nlohmann::json::array());
    roomStart.push_back(nlohmann::json::array());
    roomStart.push_back("Start");
    root[project_ids::room] = nlohmann::json::object({{"start", roomStart}});

    root[project_ids::map] = nlohmann::json::object();
    root[project_ids::script] = nlohmann::json::object();
    root[project_ids::cutscene] = nlohmann::json::object();
    root[project_ids::entrypoint_entity] = ref(EntityType::Room, "start");
    root[project_ids::starting_inventory] = nlohmann::json::array();

    // Dialogue: root -> text -> option -> text
    // segments: index 0=Root, 1=Text(Greeting), 2=Option(Ask name), 3=Text(Reply)

    auto seg0 = nlohmann::json::array();
    seg0.push_back(0); seg0.push_back(-1); seg0.push_back(false);
    seg0.push_back(false); seg0.push_back(false); seg0.push_back(false);
    seg0.push_back(false); seg0.push_back(false);
    seg0.push_back(""); seg0.push_back(""); seg0.push_back("");
    auto ch1 = nlohmann::json::array(); ch1.push_back(1);
    seg0.push_back(ch1);

    auto seg1 = nlohmann::json::array();
    seg1.push_back(1); seg1.push_back(-1); seg1.push_back(false);
    seg1.push_back(false); seg1.push_back(false); seg1.push_back(false);
    seg1.push_back(false); seg1.push_back(false);
    seg1.push_back(""); seg1.push_back(""); seg1.push_back("[Greeter]Hello, traveler!");
    auto ch2 = nlohmann::json::array(); ch2.push_back(2);
    seg1.push_back(ch2);

    auto seg2 = nlohmann::json::array();
    seg2.push_back(2); seg2.push_back(-1); seg2.push_back(false);
    seg2.push_back(false); seg2.push_back(false); seg2.push_back(false);
    seg2.push_back(false); seg2.push_back(false);
    seg2.push_back(""); seg2.push_back(""); seg2.push_back("Who are you?\nNice to meet you!");
    auto ch3 = nlohmann::json::array(); ch3.push_back(3);
    seg2.push_back(ch3);

    auto seg3 = nlohmann::json::array();
    seg3.push_back(1); seg3.push_back(-1); seg3.push_back(false);
    seg3.push_back(false); seg3.push_back(false); seg3.push_back(false);
    seg3.push_back(false); seg3.push_back(false);
    seg3.push_back(""); seg3.push_back(""); seg3.push_back("[Greeter]I am the guardian of this place.");
    seg3.push_back(nlohmann::json::array());

    auto segments = nlohmann::json::array();
    segments.push_back(seg0);
    segments.push_back(seg1);
    segments.push_back(seg2);
    segments.push_back(seg3);

    // Flat array format: [id, parent_id, properties, default_name, next_entity, root_index, enable_disabled, show_disabled, log_mode, segments]
    auto dialogueEntry = nlohmann::json::array();
    dialogueEntry.push_back("conversation");
    dialogueEntry.push_back("");
    dialogueEntry.push_back(props());
    dialogueEntry.push_back("Stranger");
    dialogueEntry.push_back(ref(EntityType::Room, "start"));
    dialogueEntry.push_back(0);
    dialogueEntry.push_back(false);
    dialogueEntry.push_back(false);
    dialogueEntry.push_back(1);
    dialogueEntry.push_back(segments);

    auto dialogueRoot = nlohmann::json::object();
    dialogueRoot["conversation"] = dialogueEntry;
    root[project_ids::dialogue] = dialogueRoot;

    return project;
}

ProjectDocument make_show_once_dialogue_project()
{
    auto project = make_test_dialogue_project();
    auto& segments = project.root()[project_ids::dialogue]["conversation"][9];
    segments[2][6] = true;
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

TEST_CASE("DialogueController starts dialogue and emits text")
{
    GameSession session;
    REQUIRE(session.load(make_test_dialogue_project()).success);

    DialogueController controller(session);
    controller.start("conversation");

    CHECK_FALSE(controller.is_complete());
    CHECK(controller.is_waiting_for_text());
    CHECK(controller.current_dialogue_id() == "conversation");

    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::DialogueText));

    const auto* text_cmd = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::DialogueText)
                return &c;
        }
        return nullptr;
    }();
    REQUIRE(text_cmd != nullptr);
    CHECK(text_cmd->data.value("name", "") == "Greeter");
    CHECK(text_cmd->data.value("text", "") == "Hello, traveler!");
}

TEST_CASE("DialogueController start shows text and options")
{
    GameSession session;
    REQUIRE(session.load(make_test_dialogue_project()).success);

    DialogueController controller(session);
    controller.start("conversation");

    CHECK(controller.is_waiting_for_text());
    CHECK(controller.is_waiting_for_choice());

    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::DialogueText));

    const auto* text_cmd = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::DialogueText)
                return &c;
        }
        return nullptr;
    }();
    REQUIRE(text_cmd != nullptr);
    CHECK(text_cmd->data.value("name", "") == "Greeter");
    CHECK(text_cmd->data.value("text", "") == "Hello, traveler!");

    // After greeting text, we should see options
    if (text_cmd->data.contains("options")) {
        const auto& opts = text_cmd->data["options"];
        REQUIRE(opts.is_array());
        REQUIRE(opts.size() == 2);
        CHECK(opts[0]["text"] == "Who are you?");
        CHECK(opts[1]["text"] == "Nice to meet you!");
    }
}

TEST_CASE("DialogueController emits explicit options and text log commands")
{
    auto project = make_test_dialogue_project();
    project.root()[project_ids::dialogue]["conversation"][9][1][7] = true;

    GameSession session;
    REQUIRE(session.load(std::move(project)).success);

    DialogueController controller(session);
    controller.start("conversation");

    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::DialogueText));
    CHECK(has_command(commands, ControllerCommandType::DialogueOptions));
    CHECK(has_command(commands, ControllerCommandType::TextLogged));

    const auto* options_cmd = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::DialogueOptions)
                return &c;
        }
        return nullptr;
    }();
    REQUIRE(options_cmd != nullptr);
    REQUIRE(options_cmd->data.contains("options"));
    REQUIRE(options_cmd->data["options"].is_array());
    CHECK(options_cmd->data["options"].size() == 2);
}

TEST_CASE("DialogueController select_option advances to next segment")
{
    GameSession session;
    REQUIRE(session.load(make_test_dialogue_project()).success);

    DialogueController controller(session);
    controller.start("conversation");
    (void)controller.take_commands();

    controller.continue_to_next();
    (void)controller.take_commands();

    CHECK(controller.select_option(0));
    auto commands = controller.take_commands();

    // Should show the response text
    CHECK(has_command(commands, ControllerCommandType::DialogueText));
}

TEST_CASE("DialogueController complete chains next entity")
{
    GameSession session;
    REQUIRE(session.load(make_test_dialogue_project()).success);

    DialogueController controller(session);
    controller.start("conversation");
    (void)controller.take_commands();

    controller.continue_to_next();
    (void)controller.take_commands();
    controller.select_option(0);
    (void)controller.take_commands();

    controller.continue_to_next();

    CHECK(controller.is_complete());
    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::DialogueComplete));

    const auto* complete_cmd = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::DialogueComplete)
                return &c;
        }
        return nullptr;
    }();
    REQUIRE(complete_cmd != nullptr);
    CHECK(complete_cmd->data.value("next_entity_id", "") == "start");
    CHECK(complete_cmd->data.value("next_entity_type", -1) == to_integer(EntityType::Room));
}

TEST_CASE("DialogueController show_once prevents re-displaying option")
{
    GameSession session;
    REQUIRE(session.load(make_show_once_dialogue_project()).success);

    DialogueController controller(session);
    controller.start("conversation");
    (void)controller.take_commands();
    controller.continue_to_next();
    (void)controller.take_commands();
    controller.select_option(0);
    (void)controller.take_commands();
    controller.continue_to_next();
    (void)controller.take_commands();

    // The show_once option should not appear again
    const auto& options = controller.options();
    bool has_shown_option = false;
    for (const auto& opt : options) {
        if (opt.text == "Who are you?" || opt.text == "Nice to meet you!")
            has_shown_option = true;
    }
    CHECK_FALSE(has_shown_option);
}

TEST_CASE("DialogueController reset clears state")
{
    GameSession session;
    REQUIRE(session.load(make_test_dialogue_project()).success);

    DialogueController controller(session);
    controller.start("conversation");
    CHECK_FALSE(controller.is_complete());

    controller.reset();
    CHECK(controller.is_complete());
    CHECK(controller.current_dialogue_id().empty());
}

TEST_CASE("DialogueController save_state and restore_state round-trip")
{
    GameSession session;
    REQUIRE(session.load(make_test_dialogue_project()).success);

    DialogueController controller(session);
    controller.start("conversation");
    (void)controller.take_commands();

    auto saved = controller.save_state();

    DialogueController restored(session);
    restored.restore_state(saved);

    CHECK(restored.current_dialogue_id() == "conversation");
    CHECK(restored.is_waiting_for_text());

    auto text_cmd = [&]() -> std::string {
        auto cmds = restored.take_commands();
        for (const auto& c : cmds) {
            if (c.type == ControllerCommandType::DialogueText)
                return c.data.value("text", "");
        }
        return "";
    }();
    CHECK(text_cmd == "Hello, traveler!");
}

TEST_CASE("DialogueController get_line_pair extracts name from brackets")
{
    auto pair = DialogueController::get_line_pair("[Narrator]Once upon a time...", "Default");
    CHECK(pair.first == "Narrator");
    CHECK(pair.second == "Once upon a time...");

    auto pair2 = DialogueController::get_line_pair("Just some text", "Default");
    CHECK(pair2.first == "Default");
    CHECK(pair2.second == "Just some text");

    auto pair3 = DialogueController::get_line_pair("[Nobody]Text", "Default");
    CHECK(pair3.first == "Nobody");
    CHECK(pair3.second == "Text");
}
