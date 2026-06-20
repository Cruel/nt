#include "ui/rmlui/rmlui_document_binder.hpp"

#include <cstdio>
#include <sstream>

namespace noveltea::ui::rmlui {

namespace {

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

std::string paragraph_rml(const std::string& text)
{
    if (text.empty())
        return {};
    std::ostringstream out;
    std::size_t start = 0;
    while (start <= text.size()) {
        const std::size_t end = text.find('\n', start);
        const auto line =
            text.substr(start, end == std::string::npos ? std::string::npos : end - start);
        if (!line.empty()) {
            out << "<p>" << escape_rml(line) << "</p>";
        }
        if (end == std::string::npos)
            break;
        start = end + 1;
    }
    return out.str();
}

Rml::Element* find_element(Rml::ElementDocument& doc, const std::string& id,
                           std::unordered_set<std::string>& logged)
{
    auto* el = doc.GetElementById(id);
    if (!el && logged.find(id) == logged.end()) {
        std::fprintf(stderr, "[runtime_ui] document missing optional slot #%s\n", id.c_str());
        logged.insert(id);
    }
    return el;
}

} // namespace

RuntimeUiDocumentBinder::RuntimeUiDocumentBinder() = default;

#if defined(NOVELTEA_HAS_RMLUI)
void RuntimeUiDocumentBinder::bind(Rml::ElementDocument& doc, const core::RuntimeUIViewState& state)
{
    if (auto* mode = find_element(doc, "rt_mode", m_logged_missing)) {
        mode->SetInnerRML(escape_rml(state.mode));
    }
    if (auto* title = find_element(doc, "rt_title", m_logged_missing)) {
        title->SetInnerRML(escape_rml(state.title));
    }
    if (auto* body = find_element(doc, "rt_body", m_logged_missing)) {
        const auto rml = paragraph_rml(state.body);
        body->SetInnerRML(rml.empty() ? "&nbsp;" : rml);
    }
    if (auto* note = find_element(doc, "rt_notification", m_logged_missing)) {
        note->SetInnerRML(escape_rml(state.notification));
    }
    if (auto* prompt = find_element(doc, "rt_prompt", m_logged_missing)) {
        if (state.page_break) {
            prompt->SetInnerRML("<button class=\"continue\" nt-continue=\"1\">Page break</button>");
        } else if (state.awaiting_continue) {
            prompt->SetInnerRML("<button class=\"continue\" nt-continue=\"1\">Continue</button>");
        } else {
            prompt->SetInnerRML("");
        }
    }
    if (auto* options = find_element(doc, "rt_options", m_logged_missing)) {
        std::ostringstream out;
        for (std::size_t i = 0; i < state.dialogue_options.size(); ++i) {
            const auto& opt = state.dialogue_options[i];
            out << "<button class=\"option";
            if (!opt.enabled)
                out << " disabled";
            out << "\" nt-option=\"" << i << "\"";
            if (!opt.enabled)
                out << " disabled";
            out << ">" << escape_rml(opt.text) << "</button>";
        }
        options->SetInnerRML(out.str());
    }
    if (auto* nav = find_element(doc, "rt_navigation", m_logged_missing)) {
        std::ostringstream out;
        for (std::size_t i = 0; i < state.navigation.size(); ++i) {
            out << "<button class=\"nav\" nt-nav=\"" << i << "\">"
                << escape_rml(state.navigation[i]) << "</button>";
        }
        nav->SetInnerRML(out.str());
    }
    if (auto* objects = find_element(doc, "rt_objects", m_logged_missing)) {
        std::ostringstream out;
        for (const auto& obj : state.objects) {
            if (obj.in_inventory && !obj.in_room)
                continue;
            out << "<button class=\"object\" nt-object=\"" << escape_rml(obj.id) << "\">"
                << escape_rml(obj.name) << "</button>";
        }
        objects->SetInnerRML(out.str());
    }
    if (auto* inventory = find_element(doc, "rt_inventory", m_logged_missing)) {
        std::ostringstream out;
        for (const auto& obj : state.objects) {
            if (!obj.in_inventory)
                continue;
            out << "<button class=\"object\" nt-object=\"" << escape_rml(obj.id) << "\">"
                << escape_rml(obj.name) << "</button>";
        }
        inventory->SetInnerRML(out.str());
    }
    if (auto* actions = find_element(doc, "rt_actions", m_logged_missing)) {
        std::ostringstream out;
        for (const auto& action : state.actions) {
            out << "<button class=\"action\" nt-action=\"" << escape_rml(action.verb_id) << "\">"
                << escape_rml(action.label);
            if (action.object_count > 0)
                out << " (" << action.object_count << ")";
            out << "</button>";
        }
        actions->SetInnerRML(out.str());
    }
    if (auto* log = find_element(doc, "rt_log", m_logged_missing)) {
        std::ostringstream out;
        for (const auto& line : state.text_log) {
            out << "<p>" << escape_rml(line) << "</p>";
        }
        log->SetInnerRML(out.str());
    }
    if (auto* map = find_element(doc, "rt_map", m_logged_missing)) {
        if (map->GetNumChildren() == 0) {
            map->SetInnerRML("<p>Map placeholder</p>");
        }
    }

    doc.Show();
}

void RuntimeUiDocumentBinder::clear_missing_slot_log() { m_logged_missing.clear(); }
#endif

} // namespace noveltea::ui::rmlui
