#include "ui/rmlui/rmlui_custom_components.hpp"

#include <sstream>

#if defined(NOVELTEA_HAS_RMLUI)
#include <RmlUi/Core/Factory.h>
#endif

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

ActiveTextComponentSnapshot make_active_text_snapshot(const core::RuntimeUIViewState& state)
{
    return {state.title, state.body, state.awaiting_continue, state.page_break};
}

MapViewComponentSnapshot make_map_view_snapshot(const core::RuntimeUIViewState& state)
{
    if (state.navigation.empty())
        return {"Map unavailable"};

    std::ostringstream label;
    label << "Available paths: ";
    for (std::size_t i = 0; i < state.navigation.size(); ++i) {
        if (i > 0)
            label << ", ";
        label << state.navigation[i];
    }
    return {label.str()};
}

TextLogComponentSnapshot make_text_log_snapshot(const core::RuntimeUIViewState& state)
{
    std::ostringstream out;
    for (const auto& line : state.text_log) {
        out << "<p>" << escape_rml(line) << "</p>";
    }
    return {out.str()};
}

std::string active_text_rml(const ActiveTextComponentSnapshot& snapshot)
{
    std::ostringstream out;
    const auto body = paragraph_rml(snapshot.body);
    out << "<div class=\"nt-active-text__body\">" << (body.empty() ? "&nbsp;" : body) << "</div>";
    if (snapshot.page_break) {
        out << "<div class=\"nt-active-text__prompt\">Page break</div>";
    } else if (snapshot.awaiting_continue) {
        out << "<div class=\"nt-active-text__prompt\">Awaiting continue</div>";
    }
    return out.str();
}

std::string map_view_rml(const MapViewComponentSnapshot& snapshot)
{
    return "<p class=\"nt-map-view__placeholder\">" + escape_rml(snapshot.label) + "</p>";
}

std::string text_log_rml(const TextLogComponentSnapshot& snapshot)
{
    return snapshot.entries_rml.empty() ? "<p class=\"nt-text-log__empty\">No log entries</p>"
                                        : snapshot.entries_rml;
}

#if defined(NOVELTEA_HAS_RMLUI)
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
#endif

} // namespace noveltea::ui::rmlui
