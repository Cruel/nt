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

std::string glyph_text_rml(std::string_view text)
{
    if (text == " ")
        return "&#160;";
    return escape_rml(text);
}

std::string glyph_style_rml(const ActiveTextGlyph& glyph)
{
    std::ostringstream style;
    style << "color: #" << std::hex << std::setw(2) << std::setfill('0')
          << static_cast<int>(glyph.style.color.r) << std::setw(2)
          << static_cast<int>(glyph.style.color.g) << std::setw(2)
          << static_cast<int>(glyph.style.color.b) << std::dec << ";";
    if (glyph.style.font_size != 12)
        style << "font-size: " << glyph.style.font_size << "px;";
    if ((glyph.style.font_style & core::FontBold) != 0)
        style << "font-weight: bold;";
    if ((glyph.style.font_style & core::FontItalic) != 0)
        style << "color: #bfe3ff;";
    if ((glyph.style.font_style & core::FontUnderlined) != 0)
        style << "text-decoration: underline;";
    return style.str();
}

std::string glyph_rml(const ActiveTextGlyph& glyph)
{
    core::RichTextRun class_source;
    class_source.style = glyph.style;
    class_source.animation = glyph.animation;

    std::ostringstream out;
    out << "<span class=\"nt-active-text__glyph " << run_class(class_source) << "\"";
    out << " style=\"" << glyph_style_rml(glyph) << "\"";
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
    out << " data-color=\"" << color_attr(glyph.style.color) << "\">" << glyph_text_rml(glyph.text)
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

TextLogComponentSnapshot make_text_log_snapshot(const core::TypedRuntimeUIViewState& state)
{
    std::ostringstream out;
    for (std::size_t index = 0; index < state.text_log.entries.size(); ++index) {
        const auto& entry = state.text_log.entries[index];
        out << "<div class=\"nt-text-log__entry\" data-sequence=\"" << index << "\"";
        out << " data-kind=\"" << static_cast<int>(entry.kind) << "\"";
        out << ">";
        if (entry.speaker)
            out << "<span class=\"nt-text-log__speaker\">" << escape_rml(entry.speaker->text())
                << "</span>";
        const auto rich = rich_text_rml(core::parse_rich_text(entry.text), 1.0f);
        out << "<div class=\"nt-text-log__body\">"
            << (rich.empty() ? paragraph_rml(entry.text) : rich) << "</div></div>";
    }
    return {out.str()};
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

std::string text_log_rml(const TextLogComponentSnapshot& snapshot)
{
    return snapshot.entries_rml.empty() ? "<p class=\"nt-text-log__empty\">No log entries</p>"
                                        : snapshot.entries_rml;
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
