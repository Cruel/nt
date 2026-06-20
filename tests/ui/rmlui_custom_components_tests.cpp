#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/runtime_ui_view.hpp>

#include "ui/rmlui/rmlui_custom_components.hpp"

#include <string>

using namespace noveltea;
using namespace noveltea::core;
using namespace noveltea::ui::rmlui;

TEST_CASE("RmlUi custom component helpers escape fallback RML")
{
    RuntimeUIViewState state;
    state.title = "Room <One>";
    state.body = "Look & listen\nUse \"quotes\"";
    state.text_log = {"A < B", "quote \" and apostrophe '"};

    const auto active = make_active_text_snapshot(state);
    CHECK(active.title == "Room <One>");
    CHECK(active.body == "Look & listen\nUse \"quotes\"");
    CHECK(active_text_rml(active) ==
          "<div class=\"nt-active-text__body\" data-reveal-progress=\"1.000\"><p>Look "
          "&amp; listen</p><p>Use "
          "&quot;quotes&quot;</p></div>");

    const auto log = make_text_log_snapshot(state);
    CHECK(text_log_rml(log) == "<p>A &lt; B</p><p>quote &quot; and apostrophe &#39;</p>");
}

TEST_CASE("RmlUi custom component snapshots tolerate empty runtime state")
{
    RuntimeUIViewState state;

    const auto active = make_active_text_snapshot(state);
    CHECK(active.title.empty());
    CHECK(active.body.empty());
    CHECK_FALSE(active.awaiting_continue);
    CHECK_FALSE(active.page_break);
    CHECK(active_text_rml(active) ==
          "<div class=\"nt-active-text__body\" data-reveal-progress=\"1.000\">&nbsp;</div>");

    const auto map = make_map_view_snapshot(state);
    CHECK(map.label == "Map unavailable");
    CHECK(map_view_rml(map) == "<p class=\"nt-map-view__placeholder\">Map unavailable</p>");

    const auto log = make_text_log_snapshot(state);
    CHECK(log.entries_rml.empty());
    CHECK(text_log_rml(log) == "<p class=\"nt-text-log__empty\">No log entries</p>");
}

TEST_CASE("RmlUi custom component snapshots are deterministic")
{
    RuntimeUIViewState state;
    state.body = "First\nSecond";
    state.awaiting_continue = true;
    state.navigation = {"north", "east"};
    state.text_log = {"one", "two"};

    const auto active_a = active_text_rml(make_active_text_snapshot(state));
    const auto active_b = active_text_rml(make_active_text_snapshot(state));
    CHECK(active_a == active_b);
    CHECK(active_a.find("Awaiting continue") != std::string::npos);

    const auto map_a = map_view_rml(make_map_view_snapshot(state));
    const auto map_b = map_view_rml(make_map_view_snapshot(state));
    CHECK(map_a == map_b);
    CHECK(map_a.find("north, east") != std::string::npos);

    const auto log_a = text_log_rml(make_text_log_snapshot(state));
    const auto log_b = text_log_rml(make_text_log_snapshot(state));
    CHECK(log_a == log_b);
    CHECK(log_a == "<p>one</p><p>two</p>");
}

TEST_CASE("RmlUi active text fallback exposes clamped reveal progress")
{
    ActiveTextComponentSnapshot snapshot;
    snapshot.body = "Body";
    snapshot.reveal_progress = 0.5f;
    CHECK(active_text_rml(snapshot) ==
          "<div class=\"nt-active-text__body\" data-reveal-progress=\"0.500\"><p>Body</p></div>");

    snapshot.reveal_progress = -1.0f;
    CHECK(active_text_rml(snapshot).find("data-reveal-progress=\"0.000\"") != std::string::npos);

    snapshot.reveal_progress = 2.0f;
    CHECK(active_text_rml(snapshot).find("data-reveal-progress=\"1.000\"") != std::string::npos);
}
