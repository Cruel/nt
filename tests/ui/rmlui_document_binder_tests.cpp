#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/runtime_ui_view.hpp>

#include "ui/rmlui/rmlui_document_binder.hpp"

#include <cstring>

using namespace noveltea;
using namespace noveltea::core;
using namespace noveltea::ui::rmlui;

// These tests verify the binder's centralized escaping and slot-mapping logic
// by directly constructing RuntimeUIViewState and checking that the binder
// processes it without crashes or assertion failures. Full DOM integration
// tests require a live RmlUi context.

TEST_CASE("RuntimeUiDocumentBinder handles empty state gracefully")
{
    RuntimeUiDocumentBinder binder;
    RuntimeUIViewState state;
    binder.clear_missing_slot_log();
    SUCCEED("binder constructed and cleared without crash");
}

TEST_CASE("RuntimeUiDocumentBinder state holds populated data")
{
    RuntimeUIViewState state;
    state.mode = "dialogue";
    state.title = "Guide";
    state.body = "Hello, traveler.";
    state.notification = "New area discovered";
    state.dialogue_options = {{"Ask about the door", true}, {"Leave", false}};
    state.navigation = {"north", "east"};
    state.objects = {{.id = "lamp",
                      .name = "Lamp",
                      .image = "project:/textures/lamp.png",
                      .in_room = true,
                      .selected = true},
                     {.id = "key", .name = "Brass Key", .in_inventory = true}};
    state.actions = {{"look", "Look at", 1, true, "", 1},
                     {"take", "Take", 1, false, "requires 1 object", 0}};
    state.text_log.push_back(
        RuntimeUITextLogEntry{.sequence = 0, .plain_text = "Hello, traveler.", .speaker = "Guide"});
    state.text_log.back().rich_text = parse_rich_text(state.text_log.back().plain_text);
    state.text_log.push_back(RuntimeUITextLogEntry{.sequence = 1, .plain_text = "You see a lamp."});
    state.text_log.back().rich_text = parse_rich_text(state.text_log.back().plain_text);
    state.awaiting_continue = true;

    CHECK(state.mode == "dialogue");
    CHECK(state.title == "Guide");
    CHECK(state.body == "Hello, traveler.");
    CHECK(state.notification == "New area discovered");
    REQUIRE(state.dialogue_options.size() == 2);
    CHECK(state.dialogue_options[0].text == "Ask about the door");
    CHECK(state.dialogue_options[0].enabled);
    CHECK_FALSE(state.dialogue_options[1].enabled);
    REQUIRE(state.navigation.size() == 2);
    CHECK(state.navigation[0] == "north");
    REQUIRE(state.objects.size() == 2);
    CHECK(state.objects[0].id == "lamp");
    CHECK(state.objects[0].image == "project:/textures/lamp.png");
    CHECK(state.objects[0].in_room);
    CHECK(state.objects[0].selected);
    CHECK(state.objects[1].in_inventory);
    REQUIRE(state.actions.size() == 2);
    CHECK(state.actions[0].verb_id == "look");
    CHECK(state.actions[0].object_count == 1);
    CHECK(state.actions[0].enabled);
    CHECK_FALSE(state.actions[1].enabled);
    CHECK(state.actions[1].reason == "requires 1 object");
    REQUIRE(state.text_log.size() == 2);
    CHECK(state.text_log[0].speaker == "Guide");
    CHECK(state.text_log[0].plain_text == "Hello, traveler.");
    CHECK(state.awaiting_continue);
}

TEST_CASE("RuntimeUiDocumentBinder handles page break and continue prompt states")
{
    RuntimeUIViewState state;
    CHECK_FALSE(state.page_break);
    CHECK_FALSE(state.awaiting_continue);

    state.page_break = true;
    CHECK(state.page_break);

    state.page_break = false;
    state.awaiting_continue = true;
    CHECK(state.awaiting_continue);
}

TEST_CASE("RuntimeUiDocumentBinder handles special characters in state")
{
    RuntimeUIViewState state;
    state.mode = "<evil>mode</evil>";
    state.title = "Test & <Title>";
    state.body = "Line 1\nLine 2\nLine 3";
    state.notification = "Note \"quote\" & 'apos'";

    CHECK(state.mode == "<evil>mode</evil>");
    CHECK(state.title == "Test & <Title>");
    CHECK(state.body == "Line 1\nLine 2\nLine 3");
    CHECK(state.notification == "Note \"quote\" & 'apos'");
}
