#include <noveltea/core/runtime_ui_view.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace noveltea::core;

namespace {
ControllerCommand cmd(ControllerCommandType type, std::string text = {}, nlohmann::json data = nlohmann::json::object())
{
    return ControllerCommand{type, std::nullopt, std::move(text), std::move(data)};
}
}

TEST_CASE("RuntimeUIViewAdapter consumes room description and navigation")
{
    RuntimeUIViewAdapter adapter;
    adapter.apply({
        cmd(ControllerCommandType::RoomEntry, "atrium", {{"name", "Atrium"}}),
        cmd(ControllerCommandType::RoomDescription, "A quiet room.", {{"text", "A quiet room."}}),
        cmd(ControllerCommandType::NavigationUpdate, {}, {{"north", true}, {"east", false}, {"paths", nlohmann::json::array({{{"label", "Downstairs"}, {"enabled", true}}})}}),
    });

    const auto& state = adapter.state();
    CHECK(state.mode == "room");
    CHECK(state.title == "Atrium");
    CHECK(state.body == "A quiet room.");
    REQUIRE(state.navigation.size() == 2);
    CHECK(state.navigation[0] == "north");
    CHECK(state.navigation[1] == "Downstairs");
}

TEST_CASE("RuntimeUIViewAdapter consumes dialogue text, options, and log lines")
{
    RuntimeUIViewAdapter adapter;
    adapter.apply(cmd(ControllerCommandType::DialogueText, "Hello.", {{"name", "Guide"}, {"text", "Hello."}, {"wait_for_click", true}}));
    adapter.apply(cmd(ControllerCommandType::DialogueOptions, {}, {{"options", nlohmann::json::array({
        {{"text", "Ask about the door"}, {"enabled", true}},
        {{"text", "Leave"}, {"enabled", false}},
    })}}));
    adapter.apply(cmd(ControllerCommandType::TextLogged, "Hello.", {{"name", "Guide"}}));

    const auto& state = adapter.state();
    CHECK(state.mode == "dialogue");
    CHECK(state.title == "Guide");
    CHECK(state.body == "Hello.");
    CHECK_FALSE(state.awaiting_continue);
    REQUIRE(state.dialogue_options.size() == 2);
    CHECK(state.dialogue_options[0].text == "Ask about the door");
    CHECK(state.dialogue_options[0].enabled);
    CHECK_FALSE(state.dialogue_options[1].enabled);
    REQUIRE(state.text_log.size() == 1);
    CHECK(state.text_log[0] == "Guide: Hello.");
}

TEST_CASE("RuntimeUIViewAdapter consumes cutscene page break")
{
    RuntimeUIViewAdapter adapter;
    adapter.apply(cmd(ControllerCommandType::CutsceneText, "Opening crawl", {{"text", "Opening crawl"}, {"wait_for_click", false}}));
    adapter.apply(cmd(ControllerCommandType::CutscenePageBreak));

    const auto& state = adapter.state();
    CHECK(state.mode == "cutscene");
    CHECK(state.body == "Opening crawl");
    CHECK(state.page_break);
    CHECK(state.awaiting_continue);
}

TEST_CASE("RuntimeUIViewAdapter stores room interaction controls")
{
    RuntimeUIViewAdapter adapter;
    adapter.apply(cmd(ControllerCommandType::RoomEntry, "atrium", {{"name", "Atrium"}}));
    adapter.set_room_interactions(
        {RuntimeUIObject{.id = "lamp", .name = "Lamp", .in_room = true},
         RuntimeUIObject{.id = "coin", .name = "Coin", .in_inventory = true}},
        {RuntimeUIAction{.verb_id = "look", .label = "Look", .object_count = 1}});

    const auto& state = adapter.state();
    REQUIRE(state.objects.size() == 2);
    CHECK(state.objects[0].id == "lamp");
    CHECK(state.objects[0].in_room);
    CHECK(state.objects[1].in_inventory);
    REQUIRE(state.actions.size() == 1);
    CHECK(state.actions[0].verb_id == "look");
    CHECK(state.actions[0].object_count == 1);

    adapter.apply(cmd(ControllerCommandType::DialogueText, "Hello.", {{"text", "Hello."}}));
    CHECK(state.objects.empty());
    CHECK(state.actions.empty());
}

TEST_CASE("RuntimeUIViewAdapter bounds text log")
{
    RuntimeUIViewAdapter adapter;
    for (int i = 0; i < 70; ++i) {
        adapter.apply(cmd(ControllerCommandType::TextLogged, "line " + std::to_string(i)));
    }

    const auto& log = adapter.state().text_log;
    REQUIRE(log.size() == 64);
    CHECK(log.front() == "line 6");
    CHECK(log.back() == "line 69");
}
