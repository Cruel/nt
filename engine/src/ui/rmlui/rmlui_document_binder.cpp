#include "ui/rmlui/rmlui_document_binder.hpp"

#include "ui/rmlui/rmlui_custom_components.hpp"

#include <cstdio>
#include <sstream>

namespace noveltea::ui::rmlui {

namespace {
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

Rml::Element* find_component(Rml::ElementDocument& doc, const std::string& tag)
{
    Rml::ElementList elements;
    doc.GetElementsByTagName(elements, tag);
    return elements.empty() ? nullptr : elements.front();
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
    if (auto* active_text =
            dynamic_cast<NtActiveTextElement*>(find_component(doc, "nt-active-text"))) {
        active_text->set_snapshot(make_active_text_snapshot(state));
    } else if (auto* body = find_element(doc, "rt_body", m_logged_missing)) {
        body->SetInnerRML(active_text_rml(make_active_text_snapshot(state)));
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
    if (auto* text_log = dynamic_cast<NtTextLogElement*>(find_component(doc, "nt-text-log"))) {
        text_log->set_snapshot(make_text_log_snapshot(state));
    } else if (auto* log = find_element(doc, "rt_log", m_logged_missing)) {
        log->SetInnerRML(text_log_rml(make_text_log_snapshot(state)));
    }
    if (auto* map_view = dynamic_cast<NtMapViewElement*>(find_component(doc, "nt-map-view"))) {
        map_view->set_snapshot(make_map_view_snapshot(state));
    } else if (auto* map = find_element(doc, "rt_map", m_logged_missing)) {
        map->SetInnerRML(map_view_rml(make_map_view_snapshot(state)));
    }

    doc.Show();
}

void RuntimeUiDocumentBinder::clear_missing_slot_log() { m_logged_missing.clear(); }
#endif

} // namespace noveltea::ui::rmlui
