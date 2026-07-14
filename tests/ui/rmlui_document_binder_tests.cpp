#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/feature_view.hpp>

#include "ui/rmlui/rmlui_document_binder.hpp"

using namespace noveltea::core;
using namespace noveltea::ui::rmlui;

TEST_CASE("RuntimeUiDocumentBinder handles empty typed state gracefully")
{
    RuntimeUiDocumentBinder binder;
    TypedRuntimeUIViewState state;
    binder.clear_missing_slot_log();
    CHECK(state.mode.empty());
    CHECK_FALSE(state.can_continue);
}

TEST_CASE("RuntimeUiDocumentBinder typed state preserves stable runtime IDs")
{
    const auto dialogue = DialogueId::create("intro");
    const auto edge = DialogueEdgeId::create("ask-door");
    const auto block = DialogueBlockId::create("opening");
    REQUIRE(dialogue);
    REQUIRE(edge);
    REQUIRE(block);

    TypedRuntimeUIViewState state;
    state.mode = "dialogue";
    state.dialogue = DialogueView{.dialogue = dialogue.value()};
    state.dialogue->choice = DialogueChoiceState{
        .dialogue = dialogue.value(),
        .block = block.value(),
        .options = {{.edge = edge.value(), .label = "Ask about the door", .enabled = true}}};
    state.can_continue = true;

    CHECK(state.dialogue->dialogue == dialogue.value());
    REQUIRE(state.dialogue->choice);
    REQUIRE(state.dialogue->choice->options.size() == 1);
    CHECK(state.dialogue->choice->options.front().edge == edge.value());
    CHECK(state.can_continue);
}
