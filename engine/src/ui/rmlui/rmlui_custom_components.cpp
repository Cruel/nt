#include "ui/rmlui/rmlui_custom_components.hpp"

#include <algorithm>
#include <sstream>

#include <RmlUi/Core/Factory.h>

namespace noveltea::ui::rmlui {

RMLUI_RTTI_Define(NtActiveTextElement) RMLUI_RTTI_Define(NtMapViewElement)

    std::string escape_rml(std::string_view value)
{
    std::string escaped;
    escaped.reserve(value.size());
    for (const char ch : value) {
        switch (ch) {
        case '&':
            escaped += "&amp;";
            break;
        case '<':
            escaped += "&lt;";
            break;
        case '>':
            escaped += "&gt;";
            break;
        case '"':
            escaped += "&quot;";
            break;
        case '\'':
            escaped += "&#39;";
            break;
        default:
            escaped.push_back(ch);
            break;
        }
    }
    return escaped;
}

std::string escape_lua_string(std::string_view value)
{
    std::string out;
    out.reserve(value.size() + 2);
    out.push_back('\'');
    for (const char ch : value) {
        if (ch == '\\' || ch == '\'')
            out.push_back('\\');
        out.push_back(ch);
    }
    out.push_back('\'');
    return out;
}

ActiveTextComponentSnapshot make_active_text_snapshot(const core::TypedRuntimeUIViewState& state)
{
    ActiveTextComponentSnapshot snapshot;
    const core::PresentedTextState* text = nullptr;
    if (state.scene && state.scene->text)
        text = &*state.scene->text;
    else if (state.dialogue && state.dialogue->line)
        text = &*state.dialogue->line;
    if (text != nullptr) {
        snapshot.body = text->text;
        snapshot.rich_text = core::parse_rich_text(text->text);
        snapshot.awaiting_continue = state.can_continue;
    } else if (state.room) {
        snapshot.body = state.room->description;
        snapshot.rich_text = core::parse_rich_text(state.room->description);
    }
    return snapshot;
}

TypedMapViewComponentSnapshot make_map_view_snapshot(const core::TypedRuntimeUIViewState& state)
{
    return {state.map};
}

std::string map_view_rml(const TypedMapViewComponentSnapshot& snapshot)
{
    if (!snapshot.map)
        return "<p class=\"nt-map-view__placeholder\">Map unavailable</p>";
    const auto& map = *snapshot.map;
    std::ostringstream out;
    out << "<div class=\"nt-map-view__root";
    if (!map.visible)
        out << " nt-map-view__root--hidden";
    out << "\" data-map-id=\"" << escape_rml(map.map.text()) << "\"";
    if (map.current_room)
        out << " data-current-room-id=\"" << escape_rml(map.current_room->text()) << "\"";
    out << " data-mode=\""
        << (map.mode == core::compiled::InitialMapMode::Minimap ? "minimap" : "full-map") << "\">";
    if (map.title)
        out << "<h2 class=\"nt-map-view__title\">" << escape_rml(*map.title) << "</h2>";
    out << "<div class=\"nt-map-view__connections\">";
    for (const auto& connection : map.connections) {
        out << "<button class=\"nt-map-view__connection";
        if (connection.selectable)
            out << " nt-map-view__connection--selectable";
        out << "\" data-connection-id=\"" << escape_rml(connection.connection.text())
            << "\" data-source-location-id=\"" << escape_rml(connection.source.text())
            << "\" data-target-location-id=\"" << escape_rml(connection.target.text())
            << "\" data-exit-room-id=\"" << escape_rml(connection.exit.room.text())
            << "\" data-exit-id=\"" << escape_rml(connection.exit.exit_id.text()) << "\" onclick=\""
            << escape_rml("Game.ui.navigate_map_connection(" +
                          escape_lua_string(connection.connection.text()) + ")")
            << "\"";
        if (!connection.selectable)
            out << " disabled";
        out << "></button>";
    }
    out << "</div><div class=\"nt-map-view__rooms\">";
    for (const auto& location : map.locations) {
        const bool current = map.current_room && *map.current_room == location.room;
        out << "<button class=\"nt-map-view__room";
        if (current)
            out << " nt-map-view__room--current";
        if (location.focused)
            out << " nt-map-view__room--focused";
        out << "\" data-location-id=\"" << escape_rml(location.location.text())
            << "\" data-room-id=\"" << escape_rml(location.room.text()) << "\"" << " data-x=\""
            << location.position.x << "\" data-y=\"" << location.position.y << "\">"
            << escape_rml(location.label.value_or(location.room.text())) << "</button>";
    }
    out << "</div></div>";
    return out.str();
}

NtActiveTextElement::NtActiveTextElement(const Rml::String& tag) : Rml::Element(tag) {}

void NtActiveTextElement::set_snapshot(const ActiveTextComponentSnapshot& snapshot)
{
    SetAttribute("data-reveal-progress", snapshot.reveal_progress);
    SetAttribute("data-page-break", snapshot.page_break);
    SetAttribute("data-awaiting-continue", snapshot.awaiting_continue);
    SetInnerRML("");
}

NtMapViewElement::NtMapViewElement(const Rml::String& tag) : Rml::Element(tag) {}

void NtMapViewElement::set_snapshot(const TypedMapViewComponentSnapshot& snapshot)
{
    SetInnerRML(map_view_rml(snapshot));
}

RuntimeUiComponentRegistry::RuntimeUiComponentRegistry()
    : m_active_text(std::make_unique<Rml::ElementInstancerGeneric<NtActiveTextElement>>()),
      m_map_view(std::make_unique<Rml::ElementInstancerGeneric<NtMapViewElement>>())
{
    Rml::Factory::RegisterElementInstancer("nt-active-text", m_active_text.get());
    Rml::Factory::RegisterElementInstancer("nt-map-view", m_map_view.get());
}

RuntimeUiComponentRegistry::~RuntimeUiComponentRegistry() = default;

} // namespace noveltea::ui::rmlui
