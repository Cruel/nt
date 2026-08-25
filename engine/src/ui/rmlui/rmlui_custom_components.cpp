#include "ui/rmlui/rmlui_custom_components.hpp"

#include <algorithm>
#include <cmath>
#include <locale>
#include <sstream>

#include <RmlUi/Core/Event.h>
#include <RmlUi/Core/Factory.h>

namespace noveltea::ui::rmlui {

RMLUI_RTTI_Define(NtActiveTextElement) RMLUI_RTTI_Define(NtMapViewElement)

    namespace
{
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

    const char* map_mode_name(core::compiled::InitialMapMode mode) noexcept
    {
        return mode == core::compiled::InitialMapMode::Minimap ? "minimap" : "full-map";
    }

    std::optional<double> parse_number(std::string_view value)
    {
        std::istringstream stream{std::string(value)};
        stream.imbue(std::locale::classic());
        stream >> std::noskipws;
        double parsed = 0.0;
        if (!(stream >> parsed) || stream.peek() != std::char_traits<char>::eof() ||
            !std::isfinite(parsed))
            return std::nullopt;
        return parsed;
    }

    bool point_in_polygon(double x, double y, const core::compiled::MapPolygon& polygon)
    {
        if (polygon.points.size() < 3)
            return false;
        bool inside = false;
        std::size_t previous = polygon.points.size() - 1;
        for (std::size_t current = 0; current < polygon.points.size(); ++current) {
            const auto& a = polygon.points[current];
            const auto& b = polygon.points[previous];
            const bool crosses = (a.y > y) != (b.y > y);
            if (crosses) {
                const double denominator = b.y - a.y;
                const double intersection =
                    denominator == 0.0 ? a.x : (b.x - a.x) * (y - a.y) / denominator + a.x;
                if (x < intersection)
                    inside = !inside;
            }
            previous = current;
        }
        return inside;
    }

} // namespace

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

TypedMapViewComponentSnapshot make_map_view_snapshot(const core::TypedRuntimeUIViewState& state,
                                                     std::optional<core::MapId> map)
{
    TypedMapViewComponentSnapshot snapshot;
    const core::MapView* selected = nullptr;
    if (map) {
        const auto found =
            std::find_if(state.maps.begin(), state.maps.end(),
                         [&](const auto& candidate) { return candidate.map == *map; });
        if (found != state.maps.end())
            selected = &*found;
    } else if (state.maps.size() == 1) {
        selected = &state.maps.front();
    }
    if (selected != nullptr) {
        snapshot.map = *selected;
        snapshot.mode = selected->initial_mode;
        const auto current = std::find_if(selected->locations.begin(), selected->locations.end(),
                                          [](const auto& location) { return location.current; });
        if (current != selected->locations.end())
            snapshot.focused_location = current->location;
    }
    return snapshot;
}

std::string map_view_rml(const TypedMapViewComponentSnapshot& snapshot)
{
    if (!snapshot.map)
        return "<p class=\"nt-map-view__placeholder\">Map unavailable</p>";
    const auto& map = *snapshot.map;
    std::ostringstream out;
    out << "<div class=\"nt-map-view__root";
    if (!snapshot.open)
        out << " nt-map-view__root--closed";
    out << "\" data-map-id=\"" << escape_rml(map.map.text()) << "\"";
    if (map.current_room)
        out << " data-current-room-id=\"" << escape_rml(map.current_room->text()) << "\"";
    if (snapshot.focused_location)
        out << " data-focused-location-id=\"" << escape_rml(snapshot.focused_location->text())
            << "\"";
    out << " data-open=\"" << (snapshot.open ? "true" : "false") << "\" data-mode=\""
        << map_mode_name(snapshot.mode) << "\" data-pan-x=\"" << snapshot.pan_x
        << "\" data-pan-y=\"" << snapshot.pan_y << "\" data-zoom=\"" << snapshot.zoom << "\">";

    out << "<div class=\"nt-map-view__view-controls\">"
        << "<button data-map-action=\"toggle-open\" aria-label=\""
        << (snapshot.open ? "Close map" : "Open map") << "\">" << (snapshot.open ? "Close" : "Open")
        << "</button>";
    if (snapshot.open) {
        out << "<button data-map-action=\"toggle-mode\" aria-label=\"Toggle map mode\">"
            << (snapshot.mode == core::compiled::InitialMapMode::Minimap ? "Full map" : "Minimap")
            << "</button>"
            << "<button data-map-action=\"zoom-in\" aria-label=\"Zoom map in\">+</button>"
            << "<button data-map-action=\"zoom-out\" aria-label=\"Zoom map out\">-</button>"
            << "<button data-map-action=\"pan-left\" aria-label=\"Pan map left\">Left</button>"
            << "<button data-map-action=\"pan-right\" aria-label=\"Pan map right\">Right</button>"
            << "<button data-map-action=\"pan-up\" aria-label=\"Pan map up\">Up</button>"
            << "<button data-map-action=\"pan-down\" aria-label=\"Pan map down\">Down</button>";
    }
    out << "</div>";
    if (!snapshot.open) {
        out << "</div>";
        return out.str();
    }

    if (map.title)
        out << "<h2 class=\"nt-map-view__title\">" << escape_rml(*map.title) << "</h2>";

    out << "<div class=\"nt-map-view__canvas\" data-map-canvas=\"true\" "
           "aria-hidden=\"true\"></div>";
    out << "<div class=\"nt-map-view__connections\">";
    for (const auto& connection : map.connections) {
        if (!connection.visible)
            continue;
        out << "<button class=\"nt-map-view__connection";
        if (connection.actionable)
            out << " nt-map-view__connection--actionable";
        out << "\" data-connection-id=\"" << escape_rml(connection.connection.text())
            << "\" data-source-location-id=\"" << escape_rml(connection.source.text())
            << "\" data-target-location-id=\"" << escape_rml(connection.target.text())
            << "\" data-logical-order=\"" << connection.logical_order << "\"";
        if (connection.icon)
            out << " data-icon-id=\"" << escape_rml(connection.icon->text()) << "\"";
        if (connection.style)
            out << " data-map-style=\"" << escape_rml(*connection.style) << "\"";
        if (connection.active_exit) {
            out << " data-exit-room-id=\"" << escape_rml(connection.active_exit->room.text())
                << "\" data-exit-id=\"" << escape_rml(connection.active_exit->exit_id.text())
                << "\"";
        }
        if (connection.actionable) {
            out << " onclick=\""
                << escape_rml("Game.ui.navigate_map_connection(" +
                              escape_lua_string(map.map.text()) + ", " +
                              escape_lua_string(connection.connection.text()) + ")")
                << "\"";
        } else {
            out << " disabled";
        }
        out << " aria-label=\""
            << escape_rml(connection.label.value_or(connection.connection.text())) << "\">"
            << escape_rml(connection.label.value_or(connection.connection.text())) << "</button>";
    }
    out << "</div><div class=\"nt-map-view__rooms\">";
    for (const auto& location : map.locations) {
        if (!location.visible)
            continue;
        out << "<button class=\"nt-map-view__room";
        if (location.current)
            out << " nt-map-view__room--current";
        if (snapshot.focused_location && *snapshot.focused_location == location.location)
            out << " nt-map-view__room--focused";
        if (location.actionable)
            out << " nt-map-view__room--actionable";
        out << "\" data-location-id=\"" << escape_rml(location.location.text())
            << "\" data-room-id=\"" << escape_rml(location.room.text()) << "\" data-pick-order=\""
            << location.pick_order << "\" data-logical-order=\"" << location.logical_order
            << "\" data-region-count=\"" << location.regions.size() << "\"";
        if (location.icon)
            out << " data-icon-id=\"" << escape_rml(location.icon->text()) << "\"";
        if (location.style)
            out << " data-map-style=\"" << escape_rml(*location.style) << "\"";
        if (location.label_anchor)
            out << " data-label-anchor-x=\"" << location.label_anchor->x
                << "\" data-label-anchor-y=\"" << location.label_anchor->y << "\"";
        if (location.connection_anchor)
            out << " data-connection-anchor-x=\"" << location.connection_anchor->x
                << "\" data-connection-anchor-y=\"" << location.connection_anchor->y << "\"";
        if (location.convenience_exit) {
            out << " data-exit-room-id=\"" << escape_rml(location.convenience_exit->room.text())
                << "\" data-exit-id=\"" << escape_rml(location.convenience_exit->exit_id.text())
                << "\" onclick=\""
                << escape_rml("Game.ui.navigate_map_location(" + escape_lua_string(map.map.text()) +
                              ", " + escape_lua_string(location.location.text()) + ")")
                << "\"";
        }
        const auto label = location.label.value_or(location.room.text());
        out << " aria-label=\"" << escape_rml(label) << "\">" << escape_rml(label) << "</button>";
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

std::optional<core::MapId> NtMapViewElement::requested_map() const
{
    const auto value = GetAttribute<Rml::String>("map", "");
    if (value.empty())
        return std::nullopt;
    auto parsed = core::MapId::create(value);
    return parsed ? std::optional<core::MapId>{*parsed.value_if()} : std::nullopt;
}

void NtMapViewElement::set_snapshot(const TypedMapViewComponentSnapshot& snapshot)
{
    const std::optional<core::MapId> next_map =
        snapshot.map ? std::optional<core::MapId>{snapshot.map->map} : std::nullopt;
    const bool map_changed = next_map != m_bound_map;
    m_map = snapshot.map;
    m_bound_map = next_map;
    if (!m_initialized || map_changed) {
        m_initialized = true;
        m_open = snapshot.open;
        m_mode = snapshot.mode;
        m_focused_location = snapshot.focused_location;
        m_pan_x = snapshot.pan_x;
        m_pan_y = snapshot.pan_y;
        m_zoom = snapshot.zoom;
        apply_state_attributes();
    } else if (m_map && m_focused_location) {
        const auto focus = std::find_if(
            m_map->locations.begin(), m_map->locations.end(), [&](const auto& location) {
                return location.location == *m_focused_location && location.visible;
            });
        if (focus == m_map->locations.end())
            m_focused_location.reset();
    }
    refresh();
}

void NtMapViewElement::refresh()
{
    TypedMapViewComponentSnapshot snapshot{.map = m_map,
                                           .open = m_open,
                                           .mode = m_mode,
                                           .focused_location = m_focused_location,
                                           .pan_x = m_pan_x,
                                           .pan_y = m_pan_y,
                                           .zoom = m_zoom};
    sync_state_attributes();
    SetInnerRML(map_view_rml(snapshot));
}

void NtMapViewElement::sync_state_attributes()
{
    m_syncing_attributes = true;
    SetAttribute("open", m_open ? "true" : "false");
    SetAttribute("mode", map_mode_name(m_mode));
    SetAttribute("focus", m_focused_location ? m_focused_location->text() : "");
    SetAttribute("pan-x", m_pan_x);
    SetAttribute("pan-y", m_pan_y);
    SetAttribute("zoom", m_zoom);
    m_syncing_attributes = false;
}

void NtMapViewElement::apply_state_attributes()
{
    const auto open = GetAttribute<Rml::String>("open", "");
    if (open == "true" || open == "1")
        m_open = true;
    else if (open == "false" || open == "0")
        m_open = false;

    const auto mode = GetAttribute<Rml::String>("mode", "");
    if (mode == "minimap")
        m_mode = core::compiled::InitialMapMode::Minimap;
    else if (mode == "full-map")
        m_mode = core::compiled::InitialMapMode::FullMap;

    const auto focus = GetAttribute<Rml::String>("focus", "");
    if (!focus.empty()) {
        auto parsed = core::MapLocationId::create(focus);
        if (parsed)
            m_focused_location = *parsed.value_if();
    }
    if (const auto pan = parse_number(GetAttribute<Rml::String>("pan-x", "")))
        m_pan_x = std::clamp(*pan, -1.0, 1.0);
    if (const auto pan = parse_number(GetAttribute<Rml::String>("pan-y", "")))
        m_pan_y = std::clamp(*pan, -1.0, 1.0);
    if (const auto zoom = parse_number(GetAttribute<Rml::String>("zoom", "")))
        m_zoom = std::clamp(*zoom, 0.25, 8.0);
}

void NtMapViewElement::OnAttributeChange(const Rml::ElementAttributes& changed_attributes)
{
    Rml::Element::OnAttributeChange(changed_attributes);
    if (m_syncing_attributes || !m_initialized)
        return;
    apply_state_attributes();
    refresh();
}

void NtMapViewElement::emit_state_change()
{
    Rml::Dictionary parameters;
    parameters["open"] = m_open;
    parameters["mode"] = Rml::String(map_mode_name(m_mode));
    parameters["focus"] = Rml::String(m_focused_location ? m_focused_location->text() : "");
    parameters["pan_x"] = static_cast<float>(m_pan_x);
    parameters["pan_y"] = static_cast<float>(m_pan_y);
    parameters["zoom"] = static_cast<float>(m_zoom);
    DispatchEvent("mapstatechange", parameters, false, true);
}

Rml::Element* NtMapViewElement::semantic_location_element(const core::MapLocationId& location)
{
    Rml::ElementList elements;
    QuerySelectorAll(elements, "[data-location-id]");
    const auto found = std::find_if(elements.begin(), elements.end(), [&](Rml::Element* element) {
        return element != nullptr &&
               element->GetAttribute<Rml::String>("data-location-id", "") == location.text();
    });
    return found == elements.end() ? nullptr : *found;
}

Rml::Element* NtMapViewElement::semantic_connection_element(const core::MapConnectionId& connection)
{
    Rml::ElementList elements;
    QuerySelectorAll(elements, "[data-connection-id]");
    const auto found = std::find_if(elements.begin(), elements.end(), [&](Rml::Element* element) {
        return element != nullptr &&
               element->GetAttribute<Rml::String>("data-connection-id", "") == connection.text();
    });
    return found == elements.end() ? nullptr : *found;
}

const core::MapLocationView* NtMapViewElement::pick_location(double x, double y) const
{
    if (!m_map || m_zoom <= 0.0)
        return nullptr;
    const double map_x = ((x - 0.5) / m_zoom + 0.5) - m_pan_x;
    const double map_y = ((y - 0.5) / m_zoom + 0.5) - m_pan_y;
    const core::MapLocationView* selected = nullptr;
    for (const auto& location : m_map->locations) {
        if (!location.visible)
            continue;
        const bool hit =
            std::any_of(location.regions.begin(), location.regions.end(),
                        [&](const auto& region) { return point_in_polygon(map_x, map_y, region); });
        if (!hit)
            continue;
        if (selected == nullptr || location.pick_order > selected->pick_order ||
            (location.pick_order == selected->pick_order &&
             location.logical_order > selected->logical_order) ||
            (location.pick_order == selected->pick_order &&
             location.logical_order == selected->logical_order &&
             location.location.text() > selected->location.text()))
            selected = &location;
    }
    return selected;
}

const core::MapConnectionView* NtMapViewElement::pick_connection(double x, double y) const
{
    if (!m_map || m_zoom <= 0.0)
        return nullptr;
    const double map_x = ((x - 0.5) / m_zoom + 0.5) - m_pan_x;
    const double map_y = ((y - 0.5) / m_zoom + 0.5) - m_pan_y;
    const core::MapConnectionView* selected = nullptr;
    for (const auto& connection : m_map->connections) {
        if (!connection.visible || !connection.actionable)
            continue;
        const bool hit =
            std::any_of(connection.hit_regions.begin(), connection.hit_regions.end(),
                        [&](const auto& region) { return point_in_polygon(map_x, map_y, region); });
        if (!hit)
            continue;
        if (selected == nullptr || connection.logical_order > selected->logical_order ||
            (connection.logical_order == selected->logical_order &&
             connection.connection.text() > selected->connection.text()))
            selected = &connection;
    }
    return selected;
}

void NtMapViewElement::ProcessDefaultAction(Rml::Event& event)
{
    Rml::Element::ProcessDefaultAction(event);
    if (event.GetType() != "click" || !m_map)
        return;

    Rml::Element* target = event.GetTargetElement();
    Rml::Element* cursor = target;
    while (cursor != nullptr && cursor != this) {
        const auto action = cursor->GetAttribute<Rml::String>("data-map-action", "");
        if (!action.empty()) {
            if (action == "toggle-open")
                m_open = !m_open;
            else if (action == "toggle-mode")
                m_mode = m_mode == core::compiled::InitialMapMode::Minimap
                             ? core::compiled::InitialMapMode::FullMap
                             : core::compiled::InitialMapMode::Minimap;
            else if (action == "zoom-in")
                m_zoom = std::min(8.0, m_zoom * 1.25);
            else if (action == "zoom-out")
                m_zoom = std::max(0.25, m_zoom / 1.25);
            else if (action == "pan-left")
                m_pan_x = std::max(-1.0, m_pan_x - 0.05 / m_zoom);
            else if (action == "pan-right")
                m_pan_x = std::min(1.0, m_pan_x + 0.05 / m_zoom);
            else if (action == "pan-up")
                m_pan_y = std::max(-1.0, m_pan_y - 0.05 / m_zoom);
            else if (action == "pan-down")
                m_pan_y = std::min(1.0, m_pan_y + 0.05 / m_zoom);
            emit_state_change();
            refresh();
            return;
        }
        const auto location_id = cursor->GetAttribute<Rml::String>("data-location-id", "");
        if (!location_id.empty()) {
            auto parsed = core::MapLocationId::create(location_id);
            if (parsed) {
                m_focused_location = *parsed.value_if();
                emit_state_change();
                refresh();
            }
            return;
        }
        cursor = cursor->GetParentNode();
    }

    if (target == nullptr)
        return;
    const Rml::Vector2f size = GetBox().GetSize(Rml::BoxArea::Content);
    if (size.x <= 0.0f || size.y <= 0.0f)
        return;
    const Rml::Vector2f origin = GetAbsoluteOffset(Rml::BoxArea::Content);
    const double x = (event.GetParameter<float>("mouse_x", 0.0f) - origin.x) / size.x;
    const double y = (event.GetParameter<float>("mouse_y", 0.0f) - origin.y) / size.y;
    if (const auto* picked = pick_location(x, y)) {
        m_focused_location = picked->location;
        emit_state_change();
        if (Rml::Element* semantic = semantic_location_element(picked->location)) {
            semantic->Focus();
            semantic->DispatchEvent("click", Rml::Dictionary{}, true, true);
        }
        refresh();
        return;
    }
    if (const auto* connection = pick_connection(x, y)) {
        if (Rml::Element* semantic = semantic_connection_element(connection->connection)) {
            semantic->Focus();
            semantic->DispatchEvent("click", Rml::Dictionary{}, true, true);
        }
    }
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
