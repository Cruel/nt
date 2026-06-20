#include <noveltea/core/runtime_ui_view.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using namespace noveltea::core;

namespace {
ControllerCommand cmd(ControllerCommandType type, std::string text = {},
                      nlohmann::json data = nlohmann::json::object())
{
    return ControllerCommand{type, std::nullopt, std::move(text), std::move(data)};
}
} // namespace

TEST_CASE("RuntimeUIViewAdapter consumes room description and navigation")
{
    RuntimeUIViewAdapter adapter;
    adapter.apply({
        cmd(ControllerCommandType::RoomEntry, "atrium", {{"name", "Atrium"}}),
        cmd(ControllerCommandType::RoomDescription, "[b]A quiet room.[/b]",
            {{"text", "[b]A quiet room.[/b]"}}),
        cmd(ControllerCommandType::NavigationUpdate, {},
            {{"north", true},
             {"east", false},
             {"paths", nlohmann::json::array({{{"label", "Downstairs"}, {"enabled", true}}})}}),
    });

    const auto& state = adapter.state();
    CHECK(state.mode == "room");
    CHECK(state.title == "Atrium");
    CHECK(state.body == "[b]A quiet room.[/b]");
    CHECK(state.active_text.plain_text == "A quiet room.");
    REQUIRE_FALSE(state.active_text.runs.empty());
    CHECK((state.active_text.runs.front().style.font_style & FontBold) != 0);
    REQUIRE(state.navigation.size() == 2);
    CHECK(state.navigation[0] == "north");
    CHECK(state.navigation[1] == "Downstairs");
}

TEST_CASE("RuntimeUIViewAdapter consumes dialogue text, options, and log lines")
{
    RuntimeUIViewAdapter adapter;
    const auto rich = to_json(parse_rich_text("[[key|object-key]]"));
    adapter.apply(cmd(ControllerCommandType::DialogueText, "[[key|object-key]]",
                      {{"name", "Guide"},
                       {"text", "[[key|object-key]]"},
                       {"rich_text", rich},
                       {"wait_for_click", true}}));
    adapter.apply(cmd(ControllerCommandType::DialogueOptions, {},
                      {{"options", nlohmann::json::array({
                                       {{"text", "Ask about the door"}, {"enabled", true}},
                                       {{"text", "Leave"}, {"enabled", false}},
                                   })}}));
    adapter.apply(cmd(ControllerCommandType::TextLogged, "Hello.", {{"name", "Guide"}}));

    const auto& state = adapter.state();
    CHECK(state.mode == "dialogue");
    CHECK(state.title == "Guide");
    CHECK(state.body == "[[key|object-key]]");
    CHECK(state.active_text.plain_text == "key");
    REQUIRE_FALSE(state.active_text.runs.empty());
    CHECK(state.active_text.runs.front().style.object_id == "object-key");
    CHECK_FALSE(state.awaiting_continue);
    REQUIRE(state.dialogue_options.size() == 2);
    CHECK(state.dialogue_options[0].text == "Ask about the door");
    CHECK(state.dialogue_options[0].enabled);
    CHECK_FALSE(state.dialogue_options[1].enabled);
    REQUIRE(state.text_log.size() == 1);
    CHECK(state.text_log[0].sequence == 0);
    CHECK(state.text_log[0].speaker == "Guide");
    CHECK(state.text_log[0].source_name == "Guide");
    CHECK(state.text_log[0].plain_text == "Hello.");
    CHECK(state.text_log[0].rich_text.plain_text == "Hello.");
}

TEST_CASE("RuntimeUIViewAdapter consumes cutscene page break")
{
    RuntimeUIViewAdapter adapter;
    adapter.apply(cmd(ControllerCommandType::CutsceneText, "[a1 e=p t=1]Opening crawl[/a1]",
                      {{"text", "[a1 e=p t=1]Opening crawl[/a1]"},
                       {"rich_text", to_json(parse_rich_text("[a1 e=p t=1]Opening crawl[/a1]"))},
                       {"wait_for_click", false}}));
    adapter.apply(cmd(ControllerCommandType::CutscenePageBreak));

    const auto& state = adapter.state();
    CHECK(state.mode == "cutscene");
    CHECK(state.body == "[a1 e=p t=1]Opening crawl[/a1]");
    CHECK(state.active_text.plain_text == "Opening crawl");
    REQUIRE_FALSE(state.active_text.runs.empty());
    CHECK(state.active_text.runs.front().animation.type == TextEffect::Pop);
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
    CHECK(log.front().sequence == 6);
    CHECK(log.front().plain_text == "line 6");
    CHECK(log.back().sequence == 69);
    CHECK(log.back().plain_text == "line 69");
}

TEST_CASE("RuntimeUIViewAdapter preserves structured text log metadata")
{
    RuntimeUIViewAdapter adapter;
    adapter.apply(cmd(ControllerCommandType::TextLogged, "[b]Hello[/b]",
                      {{"speaker", "Guide"},
                       {"source_name", "Guide NPC"},
                       {"source", EntityRef{EntityType::Dialogue, "intro"}.to_json()},
                       {"category", "dialogue"},
                       {"rich_text", to_json(parse_rich_text("[b]Hello[/b]"))}}));

    const auto& log = adapter.state().text_log;
    REQUIRE(log.size() == 1);
    CHECK(log[0].plain_text == "[b]Hello[/b]");
    CHECK(log[0].rich_text.plain_text == "Hello");
    CHECK(log[0].speaker == "Guide");
    CHECK(log[0].source_name == "Guide NPC");
    REQUIRE(log[0].source.has_value());
    CHECK(log[0].source->type == EntityType::Dialogue);
    CHECK(log[0].source->id == "intro");
    CHECK(log[0].category == "dialogue");
}

TEST_CASE("RuntimeUIViewAdapter restores saved string log entries")
{
    RuntimeUIViewAdapter adapter;
    adapter.set_saved_text_log(nlohmann::json::array({"loaded", "[i]rich[/i]", 7}));

    const auto& log = adapter.state().text_log;
    REQUIRE(log.size() == 2);
    CHECK(log[0].sequence == 0);
    CHECK(log[0].plain_text == "loaded");
    CHECK(log[0].rich_text.plain_text == "loaded");
    CHECK(log[1].sequence == 1);
    CHECK(log[1].plain_text == "[i]rich[/i]");
    CHECK(log[1].rich_text.plain_text == "rich");
}
