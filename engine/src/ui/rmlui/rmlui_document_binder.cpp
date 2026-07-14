#include "ui/rmlui/rmlui_document_binder.hpp"

#include "ui/rmlui/rmlui_custom_components.hpp"

#include <cstdio>
#include <sstream>
#include <algorithm>

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

std::string lua_string_argument(std::string_view value)
{
    std::string out;
    out.reserve(value.size() + 2);
    out.push_back('\'');
    for (const char ch : value) {
        if (ch == '\\' || ch == '\'')
            out.push_back('\\');
        if (ch == '\n') {
            out += "\\n";
        } else if (ch == '\r') {
            out += "\\r";
        } else {
            out.push_back(ch);
        }
    }
    out.push_back('\'');
    return out;
}

std::string typed_onclick(std::string_view function, std::string_view argument = {})
{
    std::string call = "Game.ui." + std::string(function) + "(";
    if (!argument.empty())
        call += lua_string_argument(argument);
    call += ")";
    return " onclick=\"" + escape_rml(call) + "\"";
}

} // namespace

RuntimeUiDocumentBinder::RuntimeUiDocumentBinder() = default;

void RuntimeUiDocumentBinder::bind(Rml::ElementDocument& doc, const core::RuntimeUIViewState& state)
{
    if (auto* mode = find_element(doc, "rt_mode", m_logged_missing)) {
        mode->SetInnerRML(escape_rml(state.mode));
    }
    if (auto* title = find_element(doc, "rt_title", m_logged_missing)) {
        title->SetInnerRML(escape_rml(state.title));
    }
    if (auto* active_text =
            rmlui_dynamic_cast<NtActiveTextElement*>(find_component(doc, "nt-active-text"))) {
        active_text->set_snapshot(make_active_text_snapshot(state));
    } else if (auto* body = find_element(doc, "rt_body", m_logged_missing)) {
        body->SetInnerRML("");
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
            prompt->SetInnerRML(
                "<button class=\"continue\" nt-continue=\"1\" onclick=\"Game.continue()\">Page "
                "break</button>");
        } else if (state.awaiting_continue) {
            prompt->SetInnerRML("<button class=\"continue\" nt-continue=\"1\" "
                                "onclick=\"Game.continue()\">Continue</button>");
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
            out << "\" nt-option=\"" << i << "\" onclick=\"Game.choose(" << i << ")\"";
            if (!opt.enabled)
                out << " disabled";
            out << ">" << escape_rml(opt.text) << "</button>";
        }
        options->SetInnerRML(out.str());
    }

    if (auto* nav = find_element(doc, "rt_navigation", m_logged_missing)) {
        std::ostringstream out;
        for (std::size_t i = 0; i < state.navigation.size(); ++i) {
            out << "<button class=\"nav\" nt-nav=\"" << i << "\" onclick=\"Game.navigate(" << i
                << ")\">" << escape_rml(state.navigation[i]) << "</button>";
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
            out << "\" nt-object=\"" << escape_rml(obj.id) << "\" onclick=\"Game.select_object('"
                << escape_rml(obj.id) << "')\"";
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
            out << "\" nt-object=\"" << escape_rml(obj.id) << "\" onclick=\"Game.select_object('"
                << escape_rml(obj.id) << "')\"";
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
            out << "<button class=\"clear-selection\" nt-clear-selection=\"1\" "
                   "onclick=\"Game.clear_selection()\">Clear "
                   "selection</button>";
        }
        for (const auto& action : state.actions) {
            out << "<button class=\"action";
            if (!action.enabled)
                out << " disabled";
            out << "\" nt-action=\"" << escape_rml(action.verb_id)
                << "\" onclick=\"Game.run_action('" << escape_rml(action.verb_id) << "')\"";
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
    if (auto* text_log =
            rmlui_dynamic_cast<NtTextLogElement*>(find_component(doc, "nt-text-log"))) {
        text_log->set_snapshot(make_text_log_snapshot(state));
    } else if (auto* log = find_element(doc, "rt_log", m_logged_missing)) {
        log->SetInnerRML(text_log_rml(make_text_log_snapshot(state)));
    }
    if (auto* map_view =
            rmlui_dynamic_cast<NtMapViewElement*>(find_component(doc, "nt-map-view"))) {
        map_view->set_snapshot(make_map_view_snapshot(state));
    } else if (auto* map = find_element(doc, "rt_map", m_logged_missing)) {
        map->SetInnerRML(map_view_rml(make_map_view_snapshot(state)));
    }
}

void RuntimeUiDocumentBinder::bind(Rml::ElementDocument& doc,
                                   const core::TypedRuntimeUIViewState& state,
                                   std::string_view output_notification)
{
    if (auto* mode = find_element(doc, "rt_mode", m_logged_missing))
        mode->SetInnerRML(escape_rml(state.mode));

    std::string title;
    std::string notification(output_notification);
    if (state.map && state.map->title)
        title = *state.map->title;
    if (notification.empty() && state.interaction && state.interaction->notification)
        notification = *state.interaction->notification;
    if (auto* title_slot = find_element(doc, "rt_title", m_logged_missing))
        title_slot->SetInnerRML(escape_rml(title));
    if (auto* note = find_element(doc, "rt_notification", m_logged_missing))
        note->SetInnerRML(escape_rml(notification));

    if (auto* active_text =
            rmlui_dynamic_cast<NtActiveTextElement*>(find_component(doc, "nt-active-text"))) {
        active_text->set_snapshot(make_active_text_snapshot(state));
    } else if (auto* body = find_element(doc, "rt_body", m_logged_missing)) {
        body->SetInnerRML(paragraph_rml(make_active_text_snapshot(state).body));
    }

    if (auto* prompt = find_element(doc, "rt_prompt", m_logged_missing)) {
        prompt->SetInnerRML(state.can_continue
                                ? "<button class=\"continue\"" + typed_onclick("continue") +
                                      ">Continue</button>"
                                : "");
    }

    if (auto* options = find_element(doc, "rt_options", m_logged_missing)) {
        std::ostringstream out;
        if (state.scene && state.scene->choice) {
            for (const auto& option : state.scene->choice->options) {
                out << "<button class=\"option" << (option.enabled ? "" : " disabled") << "\""
                    << typed_onclick("choose_scene", option.option.text());
                if (!option.enabled)
                    out << " disabled";
                out << ">" << escape_rml(option.label) << "</button>";
            }
        } else if (state.dialogue && state.dialogue->choice) {
            for (const auto& option : state.dialogue->choice->options) {
                out << "<button class=\"option" << (option.enabled ? "" : " disabled") << "\""
                    << typed_onclick("choose_dialogue", option.edge.text());
                if (!option.enabled)
                    out << " disabled";
                out << ">" << escape_rml(option.label) << "</button>";
            }
        }
        options->SetInnerRML(out.str());
    }

    if (auto* actors = find_element(doc, "rt_actors", m_logged_missing)) {
        std::ostringstream out;
        if (state.scene) {
            for (const auto& actor : state.scene->actors) {
                if (!actor.visible)
                    continue;
                out << "<div class=\"actor\" data-character-id=\""
                    << escape_rml(actor.character.text()) << "\" data-slot-id=\""
                    << escape_rml(actor.key.slot.text()) << "\" data-pose-id=\""
                    << escape_rml(actor.pose.text()) << "\" data-expression-id=\""
                    << escape_rml(actor.expression.text()) << "\" data-presentation-complete=\""
                    << (actor.presentation_complete ? "true" : "false") << "\"></div>";
            }
        }
        actors->SetInnerRML(out.str());
    }

    if (auto* nav = find_element(doc, "rt_navigation", m_logged_missing)) {
        std::ostringstream out;
        if (state.room) {
            for (const auto& exit : state.room->exits) {
                out << "<button class=\"nav" << (exit.enabled ? "" : " disabled") << "\""
                    << typed_onclick("navigate_room", exit.exit.text());
                if (!exit.enabled)
                    out << " disabled";
                out << ">" << escape_rml(exit.label) << "</button>";
            }
        }
        nav->SetInnerRML(out.str());
    }

    if (auto* objects = find_element(doc, "rt_objects", m_logged_missing)) {
        std::ostringstream out;
        if (state.room) {
            for (const auto& placement : state.room->placements) {
                if (!placement.visible)
                    continue;
                out << "<button class=\"object" << (placement.enabled ? "" : " disabled")
                    << (std::find(state.selected_interactables.begin(),
                                  state.selected_interactables.end(),
                                  placement.interactable) != state.selected_interactables.end()
                            ? " selected"
                            : "")
                    << "\"" << typed_onclick("toggle_interactable", placement.interactable.text());
                if (!placement.enabled)
                    out << " disabled";
                out << ">" << escape_rml(placement.label.value_or(placement.interactable.text()))
                    << "</button>";
            }
        }
        objects->SetInnerRML(out.str());
    }

    if (auto* inventory = find_element(doc, "rt_inventory", m_logged_missing)) {
        std::ostringstream out;
        for (const auto& item : state.inventory.items) {
            if (!item.visible)
                continue;
            out << "<button class=\"object" << (item.enabled ? "" : " disabled")
                << (std::find(state.selected_interactables.begin(),
                              state.selected_interactables.end(),
                              item.interactable) != state.selected_interactables.end()
                        ? " selected"
                        : "")
                << "\"" << typed_onclick("toggle_interactable", item.interactable.text());
            if (!item.enabled)
                out << " disabled";
            out << ">" << escape_rml(item.display_name) << "</button>";
        }
        inventory->SetInnerRML(out.str());
    }

    if (auto* actions = find_element(doc, "rt_actions", m_logged_missing)) {
        std::ostringstream out;
        if (!state.selected_interactables.empty())
            out << "<button class=\"clear-selection\"" << typed_onclick("clear_selection")
                << ">Clear selection</button>";
        const auto* controls = state.room ? &state.room->controls : &state.inventory.controls;
        for (const auto& control : *controls) {
            out << "<button class=\"action" << (control.enabled ? "" : " disabled") << "\""
                << typed_onclick("invoke_interaction", control.verb.text());
            if (!control.enabled)
                out << " disabled";
            out << ">" << escape_rml(control.label) << "</button>";
        }
        actions->SetInnerRML(out.str());
    }

    if (auto* text_log =
            rmlui_dynamic_cast<NtTextLogElement*>(find_component(doc, "nt-text-log"))) {
        text_log->set_snapshot(make_text_log_snapshot(state));
    } else if (auto* log = find_element(doc, "rt_log", m_logged_missing)) {
        log->SetInnerRML(text_log_rml(make_text_log_snapshot(state)));
    }
    if (auto* map_view =
            rmlui_dynamic_cast<NtMapViewElement*>(find_component(doc, "nt-map-view"))) {
        map_view->set_snapshot(make_map_view_snapshot(state));
    } else if (auto* map = find_element(doc, "rt_map", m_logged_missing)) {
        map->SetInnerRML(map_view_rml(make_map_view_snapshot(state)));
    }
}

void RuntimeUiDocumentBinder::clear_missing_slot_log() { m_logged_missing.clear(); }

} // namespace noveltea::ui::rmlui
