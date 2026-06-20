#include "ui/rmlui/rmlui_custom_components.hpp"

#include <noveltea/active_text.hpp>

#include <algorithm>
#include <iomanip>
#include <sstream>

#include <RmlUi/Core/Factory.h>

namespace noveltea::ui::rmlui {

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

std::string paragraph_rml(std::string_view text)
{
    if (text.empty())
        return {};

    std::ostringstream out;
    std::size_t start = 0;
    while (start <= text.size()) {
        const std::size_t end = text.find('\n', start);
        const auto line = text.substr(start, end == std::string_view::npos ? std::string_view::npos
                                                                           : end - start);
        if (!line.empty()) {
            out << "<p>" << escape_rml(line) << "</p>";
        }
        if (end == std::string_view::npos)
            break;
        start = end + 1;
    }
    return out.str();
}

std::string color_attr(const core::RichTextColor& color)
{
    std::ostringstream out;
    out << '#' << std::hex << std::setfill('0') << std::setw(2) << static_cast<int>(color.r)
        << std::setw(2) << static_cast<int>(color.g) << std::setw(2) << static_cast<int>(color.b)
        << std::setw(2) << static_cast<int>(color.a);
    return out.str();
}

std::string effect_name(core::TextEffect effect)
{
    switch (effect) {
    case core::TextEffect::Fade:
        return "fade";
    case core::TextEffect::FadeAcross:
        return "fade-across";
    case core::TextEffect::Glow:
        return "glow";
    case core::TextEffect::Nod:
        return "nod";
    case core::TextEffect::Shake:
        return "shake";
    case core::TextEffect::Test:
        return "test";
    case core::TextEffect::Tremble:
        return "tremble";
    case core::TextEffect::Pop:
        return "pop";
    case core::TextEffect::None:
        break;
    }
    return "none";
}

std::string run_class(const core::RichTextRun& run)
{
    std::string classes = "nt-active-text__run";
    if ((run.style.font_style & core::FontBold) != 0)
        classes += " nt-active-text__run--bold";
    if ((run.style.font_style & core::FontItalic) != 0)
        classes += " nt-active-text__run--italic";
    if ((run.style.font_style & core::FontUnderlined) != 0)
        classes += " nt-active-text__run--underlined";
    if ((run.style.font_style & core::FontStrikeThrough) != 0)
        classes += " nt-active-text__run--strike";
    if (run.style.diff)
        classes += " nt-active-text__run--diff";
    if (!run.style.object_id.empty())
        classes += " nt-active-text__run--object";
    if (run.animation.type != core::TextEffect::None)
        classes += " nt-active-text__run--effect nt-active-text__run--effect-" +
                   effect_name(run.animation.type);
    return classes;
}

std::string glyph_rml(const ActiveTextGlyph& glyph)
{
    core::RichTextRun class_source;
    class_source.style = glyph.style;
    class_source.animation = glyph.animation;

    std::ostringstream out;
    out << "<span class=\"nt-active-text__glyph " << run_class(class_source) << "\"";
    out << " data-run-index=\"" << glyph.run_index << "\"";
    out << " data-glyph-index=\"" << glyph.glyph_index << "\"";
    if (!glyph.style.object_id.empty())
        out << " data-object-id=\"" << escape_rml(glyph.style.object_id) << "\"";
    if (!glyph.style.material_id.empty())
        out << " data-material=\"" << escape_rml(glyph.style.material_id) << "\"";
    if (!glyph.style.font_alias.empty())
        out << " data-font=\"" << escape_rml(glyph.style.font_alias) << "\"";
    if (!glyph.style.vertex_shader_id.empty())
        out << " data-vertex-shader=\"" << escape_rml(glyph.style.vertex_shader_id) << "\"";
    if (!glyph.style.fragment_shader_id.empty())
        out << " data-fragment-shader=\"" << escape_rml(glyph.style.fragment_shader_id) << "\"";
    if (glyph.style.font_size != 12)
        out << " data-font-size=\"" << glyph.style.font_size << "\"";
    if (glyph.offset.x != 0.0f)
        out << " data-x-offset=\"" << std::fixed << std::setprecision(3) << glyph.offset.x << "\"";
    if (glyph.offset.y != 0.0f)
        out << " data-y-offset=\"" << std::fixed << std::setprecision(3) << glyph.offset.y << "\"";
    if (glyph.scale != 1.0f)
        out << " data-scale=\"" << std::fixed << std::setprecision(3) << glyph.scale << "\"";
    if (glyph.alpha != 1.0f)
        out << " data-alpha=\"" << std::fixed << std::setprecision(3) << glyph.alpha << "\"";
    if (glyph.glow != 0.0f)
        out << " data-glow=\"" << std::fixed << std::setprecision(3) << glyph.glow << "\"";
    if (glyph.style.diff)
        out << " data-diff=\"true\"";
    if (glyph.animation.type != core::TextEffect::None) {
        out << " data-effect=\"" << effect_name(glyph.animation.type) << "\"";
        out << " data-effect-fallback=\"semantic\"";
        if (glyph.animation.duration_ms > 0)
            out << " data-effect-duration-ms=\"" << glyph.animation.duration_ms << "\"";
        if (glyph.animation.delay_ms > 0)
            out << " data-effect-delay-ms=\"" << glyph.animation.delay_ms << "\"";
    }
    out << " data-color=\"" << color_attr(glyph.style.color) << "\">" << escape_rml(glyph.text)
        << "</span>";
    return out.str();
}

std::string rich_text_rml(const core::RichTextDocument& document, float reveal_progress)
{
    if (document.runs.empty())
        return {};

    const auto frame =
        build_active_text_frame(document, ActiveTextOptions{.reveal_progress = reveal_progress});

    std::ostringstream out;
    bool paragraph_open = false;

    const auto open_paragraph = [&]() {
        if (!paragraph_open) {
            out << "<p>";
            paragraph_open = true;
        }
    };
    const auto close_paragraph = [&]() {
        if (paragraph_open) {
            out << "</p>";
            paragraph_open = false;
        }
    };

    for (const auto& run_frame : frame.runs) {
        const auto& run = document.runs[run_frame.run_index];
        if (run.start_on_new_line)
            close_paragraph();

        for (const auto& glyph : run_frame.glyphs) {
            if (glyph.text == "\n") {
                close_paragraph();
            } else {
                open_paragraph();
                out << glyph_rml(glyph);
            }
        }
    }
    close_paragraph();
    return out.str();
}

ActiveTextComponentSnapshot make_active_text_snapshot(const core::RuntimeUIViewState& state)
{
    return {state.title,       state.body,
            state.active_text, state.awaiting_continue,
            state.page_break,  state.active_text_reveal_progress};
}

MapViewComponentSnapshot make_map_view_snapshot(const core::RuntimeUIViewState& state)
{
    return {state.map_view};
}

TextLogComponentSnapshot make_text_log_snapshot(const core::RuntimeUIViewState& state)
{
    std::ostringstream out;
    for (const auto& entry : state.text_log) {
        out << "<div class=\"nt-text-log__entry\" data-sequence=\"" << entry.sequence << "\"";
        if (!entry.category.empty())
            out << " data-category=\"" << escape_rml(entry.category) << "\"";
        if (!entry.source_name.empty())
            out << " data-source-name=\"" << escape_rml(entry.source_name) << "\"";
        if (entry.source.has_value()) {
            out << " data-source-type=\"" << core::to_integer(entry.source->type) << "\"";
            out << " data-source-id=\"" << escape_rml(entry.source->id) << "\"";
        }
        out << ">";
        if (!entry.speaker.empty()) {
            out << "<span class=\"nt-text-log__speaker\">" << escape_rml(entry.speaker)
                << "</span>";
        }
        const auto rich = rich_text_rml(entry.rich_text, 1.0f);
        const auto body = rich.empty() ? paragraph_rml(entry.plain_text) : rich;
        out << "<div class=\"nt-text-log__body\">" << (body.empty() ? "&nbsp;" : body)
            << "</div></div>";
    }
    return {out.str()};
}

std::string active_text_rml(const ActiveTextComponentSnapshot& snapshot)
{
    std::ostringstream out;
    const auto reveal_progress = std::clamp(snapshot.reveal_progress, 0.0f, 1.0f);
    const auto rich_body = rich_text_rml(snapshot.rich_text, reveal_progress);
    const auto body = rich_body.empty() ? paragraph_rml(snapshot.body) : rich_body;
    out << "<div class=\"nt-active-text__body\" data-reveal-progress=\"" << std::fixed
        << std::setprecision(3) << reveal_progress << "\">" << (body.empty() ? "&nbsp;" : body)
        << "</div>";
    if (snapshot.page_break) {
        out << "<div class=\"nt-active-text__prompt\">Page break</div>";
    } else if (snapshot.awaiting_continue) {
        out << "<div class=\"nt-active-text__prompt\">Awaiting continue</div>";
    }
    return out.str();
}

std::string map_view_rml(const MapViewComponentSnapshot& snapshot)
{
    const auto& map = snapshot.map;
    if (!map.available) {
        return "<p class=\"nt-map-view__placeholder\">Map unavailable</p>";
    }

    std::ostringstream out;
    out << "<div class=\"nt-map-view__root";
    if (!map.enabled)
        out << " nt-map-view__root--disabled";
    out << "\" data-map-id=\"" << escape_rml(map.map_id) << "\"";
    out << " data-current-room-id=\"" << escape_rml(map.current_room_id) << "\"";
    out << " data-enabled=\"" << (map.enabled ? "true" : "false") << "\"";
    out << " data-min-x=\"" << map.min_x << "\" data-min-y=\"" << map.min_y << "\"";
    out << " data-max-x=\"" << map.max_x << "\" data-max-y=\"" << map.max_y << "\"";
    if (!map.default_room_script.empty())
        out << " data-default-room-script=\"" << escape_rml(map.default_room_script) << "\"";
    if (!map.default_path_script.empty())
        out << " data-default-path-script=\"" << escape_rml(map.default_path_script) << "\"";
    out << ">";

    out << "<div class=\"nt-map-view__connections\">";
    for (std::size_t i = 0; i < map.connections.size(); ++i) {
        const auto& connection = map.connections[i];
        out << "<div class=\"nt-map-view__connection nt-map-view__connection--style-"
            << connection.style;
        if (!connection.visible)
            out << " nt-map-view__connection--hidden";
        out << "\" data-index=\"" << i << "\"";
        out << " data-room-start=\"" << connection.room_start << "\"";
        out << " data-room-end=\"" << connection.room_end << "\"";
        out << " data-start-x=\"" << connection.port_start_x << "\"";
        out << " data-start-y=\"" << connection.port_start_y << "\"";
        out << " data-end-x=\"" << connection.port_end_x << "\"";
        out << " data-end-y=\"" << connection.port_end_y << "\"";
        out << " data-visible=\"" << (connection.visible ? "true" : "false") << "\"";
        if (!connection.visibility_script.empty()) {
            out << " data-visibility-script=\"" << escape_rml(connection.visibility_script) << "\"";
        }
        out << "></div>";
    }
    out << "</div>";

    out << "<div class=\"nt-map-view__rooms\">";
    for (std::size_t i = 0; i < map.rooms.size(); ++i) {
        const auto& room = map.rooms[i];
        out << "<button class=\"nt-map-view__room nt-map-view__room--style-" << room.style;
        if (room.current)
            out << " nt-map-view__room--current";
        if (!room.visible)
            out << " nt-map-view__room--hidden";
        if (!room.enabled)
            out << " nt-map-view__room--disabled";
        out << "\" data-index=\"" << i << "\"";
        out << " data-left=\"" << room.left << "\" data-top=\"" << room.top << "\"";
        out << " data-width=\"" << room.width << "\" data-height=\"" << room.height << "\"";
        out << " data-style=\"" << room.style << "\"";
        out << " data-visible=\"" << (room.visible ? "true" : "false") << "\"";
        out << " data-current=\"" << (room.current ? "true" : "false") << "\"";
        if (!room.room_ids.empty()) {
            out << " data-room-ids=\"";
            for (std::size_t id_index = 0; id_index < room.room_ids.size(); ++id_index) {
                if (id_index > 0)
                    out << ",";
                out << escape_rml(room.room_ids[id_index]);
            }
            out << "\"";
        }
        if (!room.visibility_script.empty()) {
            out << " data-visibility-script=\"" << escape_rml(room.visibility_script) << "\"";
        }
        if (room.enabled && room.navigation_index >= 0) {
            out << " nt-nav=\"" << room.navigation_index << "\"";
        } else {
            out << " disabled";
        }
        out << ">"
            << escape_rml(room.name.empty() && !room.room_ids.empty() ? room.room_ids.front()
                                                                      : room.name)
            << "</button>";
    }
    out << "</div></div>";
    return out.str();
}

std::string text_log_rml(const TextLogComponentSnapshot& snapshot)
{
    return snapshot.entries_rml.empty() ? "<p class=\"nt-text-log__empty\">No log entries</p>"
                                        : snapshot.entries_rml;
}

NtActiveTextElement::NtActiveTextElement(const Rml::String& tag) : Rml::Element(tag) {}

void NtActiveTextElement::set_snapshot(const ActiveTextComponentSnapshot& snapshot)
{
    SetInnerRML(active_text_rml(snapshot));
}

NtMapViewElement::NtMapViewElement(const Rml::String& tag) : Rml::Element(tag) {}

void NtMapViewElement::set_snapshot(const MapViewComponentSnapshot& snapshot)
{
    SetInnerRML(map_view_rml(snapshot));
}

NtTextLogElement::NtTextLogElement(const Rml::String& tag) : Rml::Element(tag) {}

void NtTextLogElement::set_snapshot(const TextLogComponentSnapshot& snapshot)
{
    SetInnerRML(text_log_rml(snapshot));
}

RuntimeUiComponentRegistry::RuntimeUiComponentRegistry()
    : m_active_text(std::make_unique<Rml::ElementInstancerGeneric<NtActiveTextElement>>()),
      m_map_view(std::make_unique<Rml::ElementInstancerGeneric<NtMapViewElement>>()),
      m_text_log(std::make_unique<Rml::ElementInstancerGeneric<NtTextLogElement>>())
{
    Rml::Factory::RegisterElementInstancer("nt-active-text", m_active_text.get());
    Rml::Factory::RegisterElementInstancer("nt-map-view", m_map_view.get());
    Rml::Factory::RegisterElementInstancer("nt-text-log", m_text_log.get());
}

RuntimeUiComponentRegistry::~RuntimeUiComponentRegistry() = default;

} // namespace noveltea::ui::rmlui
