#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/feature_view.hpp>

#include "ui/rmlui/rmlui_custom_components.hpp"
#include "ui/runtime_ui_lifecycle_fixture.hpp"

#include <string>

using namespace noveltea;
using namespace noveltea::core;
using namespace noveltea::ui::rmlui;

TEST_CASE("RmlUi custom component casts are checked")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());
    {
        NtActiveTextElement active("nt-active-text");
        NtMapViewElement map("nt-map-view");
        Rml::Element* active_base = &active;
        Rml::Element* map_base = &map;

        CHECK(rmlui_dynamic_cast<NtActiveTextElement*>(active_base) == &active);
        CHECK(rmlui_dynamic_cast<NtActiveTextElement*>(map_base) == nullptr);
        CHECK(rmlui_dynamic_cast<Rml::Element*>(active_base) == active_base);
    }
}

TEST_CASE("RmlUi typed component snapshots tolerate empty runtime state")
{
    TypedRuntimeUIViewState state;

    const auto active = make_active_text_snapshot(state);
    CHECK(active.body.empty());
    CHECK(active.rich_text.plain_text.empty());
    CHECK_FALSE(active.awaiting_continue);

    const auto map = make_map_view_snapshot(state);
    CHECK_FALSE(map.map);
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
    CHECK(rml.find("data-location-id=\"hall-location\"") != std::string::npos);
    CHECK(rml.find("Game.ui.navigate_map_connection(&#39;start-hall&#39;)") != std::string::npos);
    CHECK(rml.find("nt-map-view__room--focused") != std::string::npos);
}

TEST_CASE("RmlUi provisional Map component preserves current placeholder and generated navigation "
          "contract")
{
    TypedRuntimeUIViewState empty;
    CHECK(map_view_rml(make_map_view_snapshot(empty)) ==
          "<p class=\"nt-map-view__placeholder\">Map unavailable</p>");

    const auto map_id = MapId::create("map");
    const auto room = RoomId::create("room");
    REQUIRE(map_id);
    REQUIRE(room);
    TypedRuntimeUIViewState state;
    state.map = MapView{.map = map_id.value(),
                        .mode = compiled::InitialMapMode::Minimap,
                        .visible = false,
                        .current_room = room.value(),
                        .title = "Provisional map"};
    const auto rml = map_view_rml(make_map_view_snapshot(state));
    CHECK(rml.find("nt-map-view__root--hidden") != std::string::npos);
    CHECK(rml.find("Provisional map") != std::string::npos);
}

TEST_CASE("RmlUi typed text log escapes metadata and rich text")
{
    TypedRuntimeUIViewState state;
    state.text_log.entries.push_back(TextLogEntry{.kind = TextLogEntryKind::Line,
                                                  .origin = SystemTextLogOrigin{},
                                                  .text = "[b]A < B[/b]",
                                                  .markup = TextMarkup::ActiveText});

    const auto rml = text_log_rml(make_text_log_snapshot(state));
    CHECK(rml.find("data-sequence=\"0\"") != std::string::npos);
    CHECK(rml.find("&lt;") != std::string::npos);
    CHECK(rml.find("nt-active-text__run--bold") != std::string::npos);
}

TEST_CASE("RmlUi Text Log characterization preserves order speaker kind sequence rich text and "
          "empty state")
{
    const auto speaker = CharacterId::create("alice");
    REQUIRE(speaker);
    TypedRuntimeUIViewState state;
    state.text_log.entries = {TextLogEntry{.kind = TextLogEntryKind::Line,
                                           .origin = SystemTextLogOrigin{},
                                           .speaker = speaker.value(),
                                           .text = "[b]First[/b]",
                                           .markup = TextMarkup::ActiveText},
                              TextLogEntry{.kind = TextLogEntryKind::Choice,
                                           .origin = SystemTextLogOrigin{},
                                           .text = "Second",
                                           .markup = TextMarkup::Plain},
                              TextLogEntry{.kind = TextLogEntryKind::Notification,
                                           .origin = SystemTextLogOrigin{},
                                           .text = "Third",
                                           .markup = TextMarkup::Plain}};

    const auto snapshot = make_text_log_snapshot(state);
    const auto rml = text_log_rml(snapshot);
    const auto first = rml.find("data-sequence=\"0\"");
    const auto second = rml.find("data-sequence=\"1\"");
    const auto third = rml.find("data-sequence=\"2\"");
    REQUIRE(first != std::string::npos);
    REQUIRE(second != std::string::npos);
    REQUIRE(third != std::string::npos);
    CHECK(first < second);
    CHECK(second < third);
    CHECK(rml.find("data-kind=\"0\"") != std::string::npos);
    CHECK(rml.find("data-kind=\"1\"") != std::string::npos);
    CHECK(rml.find("data-kind=\"2\"") != std::string::npos);
    CHECK(rml.find("nt-text-log__speaker\">alice") != std::string::npos);
    CHECK(rml.find("nt-active-text__run--bold") != std::string::npos);
    state.text_log.entries.clear();
    CHECK(text_log_rml(make_text_log_snapshot(state)) ==
          "<p class=\"nt-text-log__empty\">No log entries</p>");
}

TEST_CASE("ActiveText typed snapshot remains data-only for direct rendering")
{
    const auto room_id = RoomId::create("start");
    REQUIRE(room_id);

    SECTION("active-text Room descriptions use rich-text parsing")
    {
        TypedRuntimeUIViewState state;
        state.room = RoomView{.room = room_id.value(),
                              .description = "[b]Styled[/b] direct text",
                              .description_markup = TextMarkup::ActiveText};
        state.can_continue = true;

        const auto snapshot = make_active_text_snapshot(state);
        CHECK(snapshot.body == "[b]Styled[/b] direct text");
        CHECK(snapshot.rich_text.plain_text == "Styled direct text");
    }

    SECTION("plain Room descriptions enter the same direct-render path")
    {
        TypedRuntimeUIViewState state;
        state.room = RoomView{.room = room_id.value(),
                              .description = "Plain direct text",
                              .description_markup = TextMarkup::Plain};
        state.can_continue = true;

        const auto snapshot = make_active_text_snapshot(state);
        CHECK(snapshot.body == "Plain direct text");
        CHECK(snapshot.rich_text.plain_text == "Plain direct text");
    }
}
