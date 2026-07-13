#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/runtime_ui_view.hpp>

#include "ui/rmlui/rmlui_custom_components.hpp"

#include <string>

using namespace noveltea;
using namespace noveltea::core;
using namespace noveltea::ui::rmlui;

TEST_CASE("RmlUi custom component casts are checked")
{
    REQUIRE(Rml::Initialise());
    {
        NtActiveTextElement active("nt-active-text");
        NtMapViewElement map("nt-map-view");
        Rml::Element* active_base = &active;
        Rml::Element* map_base = &map;

        CHECK(rmlui_dynamic_cast<NtActiveTextElement*>(active_base) == &active);
        CHECK(rmlui_dynamic_cast<NtActiveTextElement*>(map_base) == nullptr);
        CHECK(rmlui_dynamic_cast<Rml::Element*>(active_base) == active_base);
    }
    Rml::Shutdown();
}

TEST_CASE("RmlUi custom component helpers escape non-ActiveText fallback RML")
{
    RuntimeUIViewState state;
    state.title = "Room <One>";
    state.body = "Look & listen\nUse \"quotes\"";
    state.text_log.push_back(RuntimeUITextLogEntry{.sequence = 0, .plain_text = "A < B"});
    state.text_log.back().rich_text = parse_rich_text(state.text_log.back().plain_text);
    state.text_log.push_back(RuntimeUITextLogEntry{
        .sequence = 1, .plain_text = "quote \" and apostrophe '", .category = "meta < data"});
    state.text_log.back().rich_text = parse_rich_text(state.text_log.back().plain_text);

    const auto active = make_active_text_snapshot(state);
    CHECK(active.title == "Room <One>");
    CHECK(active.body == "Look & listen\nUse \"quotes\"");

    const auto log = make_text_log_snapshot(state);
    const auto log_rml = text_log_rml(log);
    CHECK(log_rml.find("data-sequence=\"0\"") != std::string::npos);
    CHECK(log_rml.find("&lt;") != std::string::npos);
    CHECK(log_rml.find("&quot;") != std::string::npos);
    CHECK(log_rml.find("&#39;") != std::string::npos);
    CHECK(log_rml.find("data-category=\"meta &lt; data\"") != std::string::npos);
}

TEST_CASE("RmlUi custom component snapshots tolerate empty runtime state")
{
    RuntimeUIViewState state;

    const auto active = make_active_text_snapshot(state);
    CHECK(active.title.empty());
    CHECK(active.body.empty());
    CHECK(active.rich_text.plain_text.empty());
    CHECK_FALSE(active.awaiting_continue);
    CHECK_FALSE(active.page_break);
    CHECK(active.reveal_progress == 1.0f);

    const auto map = make_map_view_snapshot(state);
    CHECK_FALSE(map.map.available);
    CHECK(map_view_rml(map) == "<p class=\"nt-map-view__placeholder\">Map unavailable</p>");

    const auto log = make_text_log_snapshot(state);
    CHECK(log.entries_rml.empty());
    CHECK(text_log_rml(log) == "<p class=\"nt-text-log__empty\">No log entries</p>");
}

TEST_CASE("RmlUi typed Map snapshot preserves strong IDs and typed selection targets")
{
    const auto map_id = MapId::create("house");
    const auto room_id = RoomId::create("start");
    const auto target_room = RoomId::create("hall");
    const auto source_location = MapLocationId::create("start-location");
    const auto target_location = MapLocationId::create("hall-location");
    const auto connection_id = MapConnectionId::create("start-hall");
    const auto exit_id = RoomExitId::create("north-exit");
    REQUIRE(map_id);
    REQUIRE(room_id);
    REQUIRE(target_room);
    REQUIRE(source_location);
    REQUIRE(target_location);
    REQUIRE(connection_id);
    REQUIRE(exit_id);

    TypedRuntimeUIViewState state;
    state.mode = "room";
    state.map = MapView{.map = map_id.value(),
                        .mode = compiled::InitialMapMode::Minimap,
                        .visible = true,
                        .current_room = room_id.value(),
                        .title = "House",
                        .background = std::nullopt,
                        .layout = std::nullopt,
                        .locations = {{source_location.value(),
                                       room_id.value(),
                                       {0.0, 0.0},
                                       compiled::PointMapShape{},
                                       "Start",
                                       false},
                                      {target_location.value(),
                                       target_room.value(),
                                       {1.0, 0.0},
                                       compiled::PointMapShape{},
                                       "Hall",
                                       true}},
                        .connections = {{connection_id.value(),
                                         {room_id.value(), exit_id.value()},
                                         source_location.value(),
                                         target_location.value(),
                                         true}}};

    const auto rml = map_view_rml(make_map_view_snapshot(state));
    CHECK(rml.find("data-map-id=\"house\"") != std::string::npos);
    CHECK(rml.find("data-exit-id=\"north-exit\"") != std::string::npos);
    CHECK(rml.find("nt-map-location=\"hall-location\"") != std::string::npos);
    CHECK(rml.find("nt-map-connection=\"start-hall\"") != std::string::npos);
    CHECK(rml.find("nt-map-view__room--focused") != std::string::npos);
}

TEST_CASE("RmlUi custom component snapshots are deterministic for map and log")
{
    RuntimeUIViewState state;
    state.body = "First\nSecond";
    state.awaiting_continue = true;
    state.navigation = {"north", "east"};
    state.text_log.push_back(RuntimeUITextLogEntry{.sequence = 0, .plain_text = "one"});
    state.text_log.back().rich_text = parse_rich_text(state.text_log.back().plain_text);
    state.text_log.push_back(RuntimeUITextLogEntry{.sequence = 1, .plain_text = "two"});
    state.text_log.back().rich_text = parse_rich_text(state.text_log.back().plain_text);
    state.map_view.available = true;
    state.map_view.enabled = true;
    state.map_view.map_id = "main";
    state.map_view.current_room_id = "foyer";
    RuntimeUIMapRoom current_room;
    current_room.name = "Foyer";
    current_room.room_ids = {"foyer"};
    current_room.width = 10;
    current_room.height = 10;
    current_room.visible = true;
    current_room.current = true;
    state.map_view.rooms.push_back(std::move(current_room));

    const auto active_a = make_active_text_snapshot(state);
    const auto active_b = make_active_text_snapshot(state);
    CHECK(active_a.body == active_b.body);
    CHECK(active_a.awaiting_continue == active_b.awaiting_continue);

    const auto map_a = map_view_rml(make_map_view_snapshot(state));
    const auto map_b = map_view_rml(make_map_view_snapshot(state));
    CHECK(map_a == map_b);
    CHECK(map_a.find("data-map-id=\"main\"") != std::string::npos);
    CHECK(map_a.find("nt-map-view__room--current") != std::string::npos);

    const auto log_a = text_log_rml(make_text_log_snapshot(state));
    const auto log_b = text_log_rml(make_text_log_snapshot(state));
    CHECK(log_a == log_b);
    CHECK(log_a.find("data-sequence=\"0\"") != std::string::npos);
    CHECK(log_a.find("data-sequence=\"1\"") != std::string::npos);
    CHECK(log_a.find(">o</span>") != std::string::npos);
    CHECK(log_a.find(">t</span>") != std::string::npos);
}

TEST_CASE("RmlUi text log fallback exposes metadata and rich text")
{
    RuntimeUIViewState state;
    RuntimeUITextLogEntry entry;
    entry.sequence = 7;
    entry.source = EntityRef{EntityType::Dialogue, "intro"};
    entry.source_name = "Guide";
    entry.category = "dialogue";
    entry.plain_text = "[b]Hello[/b]";
    entry.rich_text = parse_rich_text(entry.plain_text);
    state.text_log.push_back(entry);

    const auto rml = text_log_rml(make_text_log_snapshot(state));

    CHECK(rml.find("data-sequence=\"7\"") != std::string::npos);
    CHECK(rml.find("data-source-type=\"5\"") != std::string::npos);
    CHECK(rml.find("data-source-id=\"intro\"") != std::string::npos);
    CHECK(rml.find("data-source-name=\"Guide\"") != std::string::npos);
    CHECK(rml.find("data-category=\"dialogue\"") != std::string::npos);
    CHECK(rml.find("nt-active-text__run--bold") != std::string::npos);
}

TEST_CASE("RmlUi map view fallback exposes rooms connections and click targets")
{
    RuntimeUIViewState state;
    state.map_view.available = true;
    state.map_view.enabled = true;
    state.map_view.map_id = "main<map>";
    state.map_view.current_room_id = "foyer";
    state.map_view.default_room_script = "return true;";
    state.map_view.default_path_script = "return path;";

    RuntimeUIMapRoom foyer;
    foyer.name = "Foyer";
    foyer.room_ids = {"foyer"};
    foyer.visibility_script = "visible";
    foyer.left = 1;
    foyer.top = 2;
    foyer.width = 100;
    foyer.height = 80;
    foyer.style = 3;
    foyer.navigation_index = 0;
    foyer.visible = true;
    foyer.current = true;
    foyer.enabled = true;
    state.map_view.rooms.push_back(std::move(foyer));

    RuntimeUIMapRoom other;
    other.name = "Other";
    other.room_ids = {"other"};
    other.left = 20;
    other.top = 30;
    other.width = 40;
    other.height = 50;
    other.style = 1;
    other.navigation_index = -1;
    other.visible = false;
    other.enabled = false;
    state.map_view.rooms.push_back(std::move(other));

    RuntimeUIMapConnection connection;
    connection.room_start = 0;
    connection.room_end = 1;
    connection.port_start_x = 1;
    connection.port_start_y = 2;
    connection.port_end_x = 3;
    connection.port_end_y = 4;
    connection.visibility_script = "path";
    connection.style = 2;
    connection.visible = true;
    state.map_view.connections.push_back(std::move(connection));

    const auto rml = map_view_rml(make_map_view_snapshot(state));

    CHECK(rml.find("data-map-id=\"main&lt;map&gt;\"") != std::string::npos);
    CHECK(rml.find("data-default-room-script=\"return true;\"") != std::string::npos);
    CHECK(rml.find("nt-map-view__room--current") != std::string::npos);
    CHECK(rml.find("nt-map-view__room--hidden") != std::string::npos);
    CHECK(rml.find("nt-map-view__room--disabled") != std::string::npos);
    CHECK(rml.find("nt-nav=\"0\"") != std::string::npos);
    CHECK(rml.find("data-room-ids=\"foyer\"") != std::string::npos);
    CHECK(rml.find("data-visibility-script=\"path\"") != std::string::npos);
}

TEST_CASE("RmlUi map view fallback omits click targets for disabled rooms")
{
    RuntimeUIViewState state;
    state.map_view.available = true;
    state.map_view.enabled = true;
    RuntimeUIMapRoom disabled;
    disabled.name = "Disabled";
    disabled.room_ids = {"disabled"};
    disabled.width = 50;
    disabled.height = 40;
    disabled.navigation_index = 3;
    disabled.visible = true;
    disabled.enabled = false;
    state.map_view.rooms.push_back(std::move(disabled));

    const auto rml = map_view_rml(make_map_view_snapshot(state));
    CHECK(rml.find("nt-nav=\"3\"") == std::string::npos);
    CHECK(rml.find("disabled") != std::string::npos);
}

TEST_CASE("ActiveText custom component snapshot is data-only for direct renderer")
{
    RuntimeUIViewState state;
    state.body = "[b]Styled[/b] direct text";
    state.active_text = parse_rich_text(state.body);
    state.active_text_reveal_progress = 0.5f;
    state.page_break = true;

    const auto snapshot = make_active_text_snapshot(state);

    CHECK(snapshot.body == state.body);
    CHECK(snapshot.rich_text.plain_text == "Styled direct text");
    CHECK(snapshot.reveal_progress == 0.5f);
    CHECK(snapshot.page_break);
}
