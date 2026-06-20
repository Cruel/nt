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
    const auto active_rml = active_text_rml(active);
    CHECK(active_rml.find("<p>Look &amp; listen</p>") != std::string::npos);
    CHECK(active_rml.find("<p>Use &quot;quotes&quot;</p>") != std::string::npos);

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
    CHECK_FALSE(map.map.available);
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
    state.map_view.available = true;
    state.map_view.enabled = true;
    state.map_view.map_id = "main";
    state.map_view.current_room_id = "foyer";
    state.map_view.rooms.push_back(RuntimeUIMapRoom{.name = "Foyer",
                                                    .room_ids = {"foyer"},
                                                    .width = 10,
                                                    .height = 10,
                                                    .visible = true,
                                                    .current = true});

    const auto active_a = active_text_rml(make_active_text_snapshot(state));
    const auto active_b = active_text_rml(make_active_text_snapshot(state));
    CHECK(active_a == active_b);
    CHECK(active_a.find("Awaiting continue") != std::string::npos);

    const auto map_a = map_view_rml(make_map_view_snapshot(state));
    const auto map_b = map_view_rml(make_map_view_snapshot(state));
    CHECK(map_a == map_b);
    CHECK(map_a.find("data-map-id=\"main\"") != std::string::npos);
    CHECK(map_a.find("nt-map-view__room--current") != std::string::npos);

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

TEST_CASE("RmlUi active text fallback renders rich semantic spans")
{
    RuntimeUIViewState state;
    state.body = "[[Key|key-object]] [b][i]bold[/i][/b] [c=#bed]color[/c] "
                 "[d]diff[/d] [a1 e=s t=2]shake[/a1]";
    state.active_text = parse_rich_text(state.body);

    const auto rml = active_text_rml(make_active_text_snapshot(state));

    CHECK(rml.find("data-object-id=\"key-object\"") != std::string::npos);
    CHECK(rml.find("nt-active-text__run--object") != std::string::npos);
    CHECK(rml.find("nt-active-text__run--bold") != std::string::npos);
    CHECK(rml.find("nt-active-text__run--italic") != std::string::npos);
    CHECK(rml.find("data-color=\"#bbeeddff\"") != std::string::npos);
    CHECK(rml.find("data-diff=\"true\"") != std::string::npos);
    CHECK(rml.find("data-effect=\"shake\"") != std::string::npos);
    CHECK(rml.find("data-effect-fallback=\"semantic\"") != std::string::npos);
    CHECK(rml.find("data-effect-duration-ms=\"2000\"") != std::string::npos);
}

TEST_CASE("RmlUi map view fallback exposes rooms connections and click targets")
{
    RuntimeUIViewState state;
    state.map_view.available = true;
    state.map_view.enabled = true;
    state.map_view.map_id = "main<map>";
    state.map_view.current_room_id = "foyer";
    state.map_view.default_room_script = "return true;";
    state.map_view.default_path_script = "path < ok";
    state.map_view.max_x = 280;
    state.map_view.max_y = 80;
    state.map_view.rooms.push_back(RuntimeUIMapRoom{.name = "Foyer",
                                                    .room_ids = {"foyer"},
                                                    .visibility_script = "",
                                                    .left = 0,
                                                    .top = 0,
                                                    .width = 120,
                                                    .height = 80,
                                                    .style = 1,
                                                    .visible = true,
                                                    .current = true});
    state.map_view.rooms.push_back(RuntimeUIMapRoom{.name = "Kitchen & Pantry",
                                                    .room_ids = {"kitchen"},
                                                    .visibility_script = "visible < true",
                                                    .left = 160,
                                                    .top = 0,
                                                    .width = 120,
                                                    .height = 80,
                                                    .style = 2,
                                                    .navigation_index = 0,
                                                    .visible = true,
                                                    .current = false,
                                                    .enabled = true});
    state.map_view.connections.push_back(RuntimeUIMapConnection{.room_start = 0,
                                                                .room_end = 1,
                                                                .port_start_x = 120,
                                                                .port_start_y = 40,
                                                                .port_end_x = 160,
                                                                .port_end_y = 40,
                                                                .visibility_script = "path < true",
                                                                .style = 3,
                                                                .visible = true});

    const auto rml = map_view_rml(make_map_view_snapshot(state));

    CHECK(rml.find("data-map-id=\"main&lt;map&gt;\"") != std::string::npos);
    CHECK(rml.find("data-current-room-id=\"foyer\"") != std::string::npos);
    CHECK(rml.find("data-default-path-script=\"path &lt; ok\"") != std::string::npos);
    CHECK(rml.find("nt-map-view__connection--style-3") != std::string::npos);
    CHECK(rml.find("data-visibility-script=\"path &lt; true\"") != std::string::npos);
    CHECK(rml.find("nt-map-view__room--style-2") != std::string::npos);
    CHECK(rml.find("nt-nav=\"0\"") != std::string::npos);
    CHECK(rml.find("Kitchen &amp; Pantry") != std::string::npos);
}

TEST_CASE("RmlUi map view fallback omits click targets for disabled rooms")
{
    RuntimeUIViewState state;
    state.map_view.available = true;
    state.map_view.enabled = false;
    state.map_view.map_id = "main";
    state.map_view.current_room_id = "foyer";
    state.map_view.rooms.push_back(
        RuntimeUIMapRoom{.name = "Kitchen", .room_ids = {"kitchen"}, .navigation_index = 0});

    const auto rml = map_view_rml(make_map_view_snapshot(state));

    CHECK(rml.find("nt-map-view__root--disabled") != std::string::npos);
    CHECK(rml.find("nt-nav=") == std::string::npos);
    CHECK(rml.find("disabled") != std::string::npos);
}

TEST_CASE("RmlUi active text reveal slices rich text deterministically")
{
    ActiveTextComponentSnapshot snapshot;
    snapshot.rich_text = parse_rich_text("[b]abcd[/b]");

    snapshot.reveal_progress = 0.0f;
    CHECK(active_text_rml(snapshot).find("&nbsp;") != std::string::npos);

    snapshot.reveal_progress = 0.5f;
    const auto partial = active_text_rml(snapshot);
    CHECK(partial.find(">a</span>") != std::string::npos);
    CHECK(partial.find(">b</span>") != std::string::npos);
    CHECK(partial.find(">c</span>") == std::string::npos);

    snapshot.reveal_progress = 1.0f;
    const auto complete = active_text_rml(snapshot);
    CHECK(complete.find(">a</span>") != std::string::npos);
    CHECK(complete.find(">d</span>") != std::string::npos);
}

TEST_CASE("RmlUi active text fallback preserves prompts with rich text")
{
    ActiveTextComponentSnapshot snapshot;
    snapshot.rich_text = parse_rich_text("[p=0.25]next");
    snapshot.page_break = true;
    snapshot.awaiting_continue = true;

    const auto rml = active_text_rml(snapshot);
    CHECK(rml.find("Page break") != std::string::npos);
    CHECK(rml.find("Awaiting continue") == std::string::npos);
}
