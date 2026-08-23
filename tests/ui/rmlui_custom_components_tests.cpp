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
    const auto icon_id = AssetId::create("map-icon");
    REQUIRE(map_id);
    REQUIRE(room_id);
    REQUIRE(target_room);
    REQUIRE(source_location);
    REQUIRE(target_location);
    REQUIRE(connection_id);
    REQUIRE(exit_id);
    REQUIRE(icon_id);

    TypedRuntimeUIViewState state;
    state.mode = "room";
    state.maps.push_back(MapView{
        .map = map_id.value(),
        .initial_mode = compiled::InitialMapMode::Minimap,
        .current_room = room_id.value(),
        .title = "House",
        .locations = {{.location = source_location.value(),
                       .room = room_id.value(),
                       .regions = {{{{0.0, 0.0}, {0.4, 0.0}, {0.4, 0.4}}}},
                       .label = "Start",
                       .icon = icon_id.value(),
                       .style = "start-room",
                       .label_anchor = compiled::Vector2{0.1, 0.2},
                       .connection_anchor = compiled::Vector2{0.3, 0.4},
                       .current = true},
                      {.location = target_location.value(),
                       .room = target_room.value(),
                       .regions = {{{{0.6, 0.6}, {1.0, 0.6}, {1.0, 1.0}}}},
                       .label = "Hall",
                       .actionable = true,
                       .convenience_exit = core::compiled::RoomExitRef{room_id.value(),
                                                                       exit_id.value()}}},
        .connections = {{.connection = connection_id.value(),
                         .exits = {{room_id.value(), exit_id.value()}},
                         .source = source_location.value(),
                         .target = target_location.value(),
                         .active_exit = core::compiled::RoomExitRef{room_id.value(), exit_id.value()},
                         .label = "Hall route",
                         .icon = icon_id.value(),
                         .style = "hall-route",
                         .actionable = true}}});

    const auto rml = map_view_rml(make_map_view_snapshot(state));
    CHECK(rml.find("data-map-id=\"house\"") != std::string::npos);
    CHECK(rml.find("data-exit-id=\"north-exit\"") != std::string::npos);
    CHECK(rml.find("data-location-id=\"hall-location\"") != std::string::npos);
    CHECK(rml.find("data-icon-id=\"map-icon\"") != std::string::npos);
    CHECK(rml.find("data-map-style=\"start-room\"") != std::string::npos);
    CHECK(rml.find("data-map-style=\"hall-route\"") != std::string::npos);
    CHECK(rml.find("data-label-anchor-x=\"0.1\"") != std::string::npos);
    CHECK(rml.find("data-label-anchor-y=\"0.2\"") != std::string::npos);
    CHECK(rml.find("data-connection-anchor-x=\"0.3\"") != std::string::npos);
    CHECK(rml.find("data-connection-anchor-y=\"0.4\"") != std::string::npos);
    CHECK(rml.find("Game.ui.navigate_map_connection(&#39;house&#39;, &#39;start-hall&#39;)") !=
          std::string::npos);
    CHECK(rml.find("nt-map-view__room--focused") != std::string::npos);
}

TEST_CASE("RmlUi Map view state is isolated per element occurrence")
{
    noveltea::test::RuntimeUiLifecycleFixture fixture;
    REQUIRE(fixture.initialize());

    const auto map_id = MapId::create("house");
    const auto room_id = RoomId::create("start");
    const auto location_id = MapLocationId::create("start-location");
    REQUIRE(map_id);
    REQUIRE(room_id);
    REQUIRE(location_id);

    TypedMapViewComponentSnapshot snapshot;
    snapshot.map = MapView{.map = map_id.value(),
                           .initial_mode = compiled::InitialMapMode::Minimap,
                           .current_room = room_id.value(),
                           .title = "House",
                           .locations = {{.location = location_id.value(),
                                          .room = room_id.value(),
                                          .regions = {},
                                          .label = "Start",
                                          .current = true}}};
    snapshot.mode = compiled::InitialMapMode::Minimap;
    snapshot.focused_location = location_id.value();

    NtMapViewElement first("nt-map-view");
    NtMapViewElement second("nt-map-view");
    first.set_snapshot(snapshot);
    second.set_snapshot(snapshot);

    first.SetAttribute("open", "false");
    first.SetAttribute("zoom", "2");
    first.SetAttribute("pan-x", "0.25");

    CHECK(first.GetInnerRML().find("nt-map-view__root--closed") != std::string::npos);
    CHECK(first.GetAttribute<Rml::String>("zoom", "") == "2");
    CHECK(first.GetAttribute<Rml::String>("pan-x", "") == "0.25");
    CHECK(second.GetInnerRML().find("nt-map-view__root--closed") == std::string::npos);
    CHECK(second.GetAttribute<Rml::String>("zoom", "") == "1");
    CHECK(second.GetAttribute<Rml::String>("pan-x", "") == "0");

    first.set_snapshot(snapshot);
    second.set_snapshot(snapshot);
    CHECK(first.GetInnerRML().find("nt-map-view__root--closed") != std::string::npos);
    CHECK(first.GetAttribute<Rml::String>("zoom", "") == "2");
    CHECK(second.GetInnerRML().find("nt-map-view__root--closed") == std::string::npos);
    CHECK(second.GetAttribute<Rml::String>("zoom", "") == "1");
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
    state.maps.push_back(MapView{.map = map_id.value(),
                                 .initial_mode = compiled::InitialMapMode::Minimap,
                                 .current_room = room.value(),
                                 .title = "Provisional map"});
    auto snapshot = make_map_view_snapshot(state);
    snapshot.open = false;
    const auto rml = map_view_rml(snapshot);
    CHECK(rml.find("nt-map-view__root--closed") != std::string::npos);
    CHECK(rml.find("Provisional map") == std::string::npos);
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
