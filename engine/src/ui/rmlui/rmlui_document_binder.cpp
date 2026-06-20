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

std::string image_rml(std::string_view path, std::string_view css_class, std::string_view label)
{
    if (path.empty()) {
        return {};
    }
    std::ostringstream out;
    out << "<img class=\"" << css_class << "\" src=\"" << escape_rml(path) << "\" alt=\""
        << escape_rml(label) << "\"/>";
    return out.str();
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
    if (auto* cover = find_element(doc, "rt_cover_image", m_logged_missing)) {
        cover->SetInnerRML(image_rml(state.cover_image, "visual cover", "Cover image"));
    }
    if (auto* background = find_element(doc, "rt_background_image", m_logged_missing)) {
        background->SetInnerRML(
            image_rml(state.background_image, "visual background", "Background image"));
    }
    if (auto* room = find_element(doc, "rt_room_image", m_logged_missing)) {
        room->SetInnerRML(image_rml(state.room_image, "visual room", "Room image"));
    }
    if (auto* asset_status = find_element(doc, "rt_asset_status", m_logged_missing)) {
        std::ostringstream out;
        for (const auto& diagnostic : state.asset_diagnostics) {
            out << "<div class=\"asset-warning\" data-asset=\"" << escape_rml(diagnostic.asset_path)
                << "\">" << escape_rml(diagnostic.message) << "</div>";
        }
        asset_status->SetInnerRML(out.str());
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
            out << "<button class=\"object";
            if (obj.selected)
                out << " selected";
            if (!obj.enabled)
                out << " disabled";
            out << "\" nt-object=\"" << escape_rml(obj.id) << "\"";
            if (!obj.enabled)
                out << " disabled";
            out << ">";
            if (!obj.image.empty()) {
                out << image_rml(obj.image, "visual object", obj.name);
            }
            out << "<span class=\"object-label\">" << escape_rml(obj.name) << "</span>";
            if (obj.selected)
                out << " [selected]";
            if (!obj.reason.empty())
                out << " - " << escape_rml(obj.reason);
            out << "</button>";
        }
        objects->SetInnerRML(out.str());
    }
    if (auto* inventory = find_element(doc, "rt_inventory", m_logged_missing)) {
        std::ostringstream out;
        for (const auto& obj : state.objects) {
            if (!obj.in_inventory)
                continue;
            out << "<button class=\"object";
            if (obj.selected)
                out << " selected";
            if (!obj.enabled)
                out << " disabled";
            out << "\" nt-object=\"" << escape_rml(obj.id) << "\"";
            if (!obj.enabled)
                out << " disabled";
            out << ">";
            if (!obj.image.empty()) {
                out << image_rml(obj.image, "visual object", obj.name);
            }
            out << "<span class=\"object-label\">" << escape_rml(obj.name) << "</span>";
            if (obj.selected)
                out << " [selected]";
            if (!obj.reason.empty())
                out << " - " << escape_rml(obj.reason);
            out << "</button>";
        }
        inventory->SetInnerRML(out.str());
    }
    if (auto* actions = find_element(doc, "rt_actions", m_logged_missing)) {
        std::ostringstream out;
        bool has_selection = false;
        for (const auto& obj : state.objects) {
            has_selection = has_selection || obj.selected;
        }
        if (has_selection) {
            out << "<button class=\"clear-selection\" nt-clear-selection=\"1\">Clear "
                   "selection</button>";
        }
        for (const auto& action : state.actions) {
            out << "<button class=\"action";
            if (!action.enabled)
                out << " disabled";
            out << "\" nt-action=\"" << escape_rml(action.verb_id) << "\"";
            if (!action.enabled)
                out << " disabled";
            out << ">" << escape_rml(action.label) << " (" << action.selected_count << "/"
                << action.object_count << ")";
            if (!action.reason.empty())
                out << " - " << escape_rml(action.reason);
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
}

void RuntimeUiDocumentBinder::clear_missing_slot_log() { m_logged_missing.clear(); }
#endif

} // namespace noveltea::ui::rmlui
