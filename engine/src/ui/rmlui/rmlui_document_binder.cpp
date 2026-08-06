#include "ui/rmlui/rmlui_document_binder.hpp"

#include "ui/rmlui/rmlui_custom_components.hpp"

#include <RmlUi/Core/ElementDocument.h>

#include <algorithm>
#include <array>
#include <sstream>

namespace noveltea::ui::rmlui {

namespace {
Rml::Element* find_element(Rml::ElementDocument& doc, const std::string& id)
{
    return doc.GetElementById(id);
}

Rml::Element* find_component(Rml::ElementDocument& doc, const std::string& tag)
{
    Rml::ElementList elements;
    doc.GetElementsByTagName(elements, tag);
    return elements.empty() ? nullptr : elements.front();
}

template<class T> T* find_component_as(Rml::ElementDocument& doc, const std::string& tag)
{
    auto* component = find_component(doc, tag);
    return component ? rmlui_dynamic_cast<T*>(component) : nullptr;
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

std::string actor_instance_text(const core::ActorPresentationKey& key)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::CharacterActorKey>)
                return value.character.text();
            else if constexpr (std::is_same_v<T, core::RoomCastActorKey>)
                return value.entry.text();
            else if constexpr (std::is_same_v<T, core::SceneActorKey>)
                return value.slot.text();
            else
                return value.instance.text();
        },
        key);
}

void set_element_visible(Rml::ElementDocument& doc, const char* id, bool visible)
{
    if (auto* element = doc.GetElementById(id))
        element->SetProperty("display", visible ? "block" : "none");
}

void set_element_pointer_events(Rml::ElementDocument& doc, const char* id, bool enabled)
{
    if (auto* element = doc.GetElementById(id))
        element->SetProperty("pointer-events", enabled ? "auto" : "none");
}

struct DirectionPresentation {
    core::compiled::RoomExitDirection direction;
    std::string_view token;
    std::string_view glyph;
    std::string_view element_id;
};

constexpr std::array kDirectionPresentations{
    DirectionPresentation{core::compiled::RoomExitDirection::Northwest, "northwest", "NW",
                          "rt_nav_northwest"},
    DirectionPresentation{core::compiled::RoomExitDirection::North, "north", "N", "rt_nav_north"},
    DirectionPresentation{core::compiled::RoomExitDirection::Northeast, "northeast", "NE",
                          "rt_nav_northeast"},
    DirectionPresentation{core::compiled::RoomExitDirection::West, "west", "W", "rt_nav_west"},
    DirectionPresentation{core::compiled::RoomExitDirection::Custom, "custom", "GO",
                          "rt_nav_custom"},
    DirectionPresentation{core::compiled::RoomExitDirection::East, "east", "E", "rt_nav_east"},
    DirectionPresentation{core::compiled::RoomExitDirection::Southwest, "southwest", "SW",
                          "rt_nav_southwest"},
    DirectionPresentation{core::compiled::RoomExitDirection::South, "south", "S", "rt_nav_south"},
    DirectionPresentation{core::compiled::RoomExitDirection::Southeast, "southeast", "SE",
                          "rt_nav_southeast"},
};

} // namespace

RuntimeUiDocumentBinder::RuntimeUiDocumentBinder() = default;

void RuntimeUiDocumentBinder::bind(Rml::ElementDocument& doc,
                                   const core::TypedRuntimeUIViewState& state,
                                   std::string_view output_notification)
{
    if (auto* mode = find_element(doc, "rt_mode"))
        mode->SetInnerRML(escape_rml(state.mode));

    std::string title;
    std::string notification(output_notification);
    if (state.map && state.map->title)
        title = *state.map->title;
    if (notification.empty() && state.interaction && state.interaction->notification)
        notification = *state.interaction->notification;
    if (auto* title_slot = find_element(doc, "rt_title"))
        title_slot->SetInnerRML(escape_rml(title));
    if (auto* note = find_element(doc, "rt_notification"))
        note->SetInnerRML(escape_rml(notification));
    set_element_visible(doc, "rt_title", !title.empty());
    set_element_visible(doc, "rt_notification", !notification.empty());

    const auto active_text_snapshot = make_active_text_snapshot(state);
    if (auto* active_text = find_component_as<NtActiveTextElement>(doc, "nt-active-text")) {
        active_text->set_snapshot(active_text_snapshot);
    } else if (auto* body = find_element(doc, "rt_body")) {
        body->SetInnerRML(paragraph_rml(active_text_snapshot.body));
    }

    if (auto* prompt = find_element(doc, "rt_prompt")) {
        prompt->SetInnerRML(state.can_continue
                                ? "<button class=\"continue\"" + typed_onclick("continue") +
                                      ">Continue</button>"
                                : "");
    }

    std::ostringstream options_rml;
    if (state.scene && state.scene->choice) {
        for (const auto& option : state.scene->choice->options) {
            options_rml << "<button class=\"option" << (option.enabled ? "" : " disabled") << "\""
                        << typed_onclick("choose_scene", option.option.text());
            if (!option.enabled)
                options_rml << " disabled";
            options_rml << ">" << escape_rml(option.label) << "</button>";
        }
    } else if (state.dialogue && state.dialogue->choice) {
        for (const auto& option : state.dialogue->choice->options) {
            options_rml << "<button class=\"option" << (option.enabled ? "" : " disabled") << "\""
                        << typed_onclick("choose_dialogue", option.edge.text());
            if (!option.enabled)
                options_rml << " disabled";
            options_rml << ">" << escape_rml(option.label) << "</button>";
        }
    }
    const auto options_markup = options_rml.str();
    if (auto* options = find_element(doc, "rt_options"))
        options->SetInnerRML(options_markup);
    set_element_visible(doc, "rt_text_panel",
                        !active_text_snapshot.body.empty() || !options_markup.empty());
    set_element_pointer_events(doc, "rt_text_panel", state.can_continue || !options_markup.empty());

    if (auto* actors = find_element(doc, "rt_actors")) {
        std::ostringstream out;
        if (state.scene) {
            for (const auto& actor : state.scene->actors) {
                if (!actor.visible)
                    continue;
                out << "<div class=\"actor\" data-character-id=\""
                    << escape_rml(actor.character.text()) << "\" data-slot-id=\""
                    << escape_rml(actor_instance_text(actor.key)) << "\" data-pose-id=\""
                    << escape_rml(actor.pose.text()) << "\" data-expression-id=\""
                    << escape_rml(actor.expression.text()) << "\" data-presentation-complete=\""
                    << (actor.presentation_complete ? "true" : "false") << "\"></div>";
            }
        }
        actors->SetInnerRML(out.str());
    }

    bool navigation_available = false;
    for (const auto& presentation : kDirectionPresentations) {
        auto* button = find_element(doc, std::string(presentation.element_id));
        if (!button)
            continue;
        const core::RoomExitView* selected = nullptr;
        if (state.room) {
            const auto exit = std::find_if(
                state.room->exits.begin(), state.room->exits.end(), [&](const auto& candidate) {
                    return candidate.enabled && candidate.direction == presentation.direction;
                });
            if (exit != state.room->exits.end())
                selected = &*exit;
        }
        if (!selected) {
            button->RemoveAttribute("data-exit-id");
            button->SetProperty("display", "none");
            continue;
        }
        button->SetAttribute("data-exit-id", selected->exit.text());
        button->SetInnerRML("<span class=\"nav-glyph\">" + std::string(presentation.glyph) +
                            "</span><span class=\"nav-label\">" + escape_rml(selected->label) +
                            "</span>");
        button->SetProperty("display", "block");
        navigation_available = true;
    }
    set_element_visible(doc, "rt_navigation", navigation_available);

    std::ostringstream objects_rml;
    if (state.room) {
        for (const auto& placement : state.room->placements) {
            for (const auto& occupant : placement.occupants) {
                if (!occupant.visible)
                    continue;
                const auto subject_text = std::visit(
                    [](const auto& subject) {
                        if constexpr (std::is_same_v<std::decay_t<decltype(subject)>,
                                                     core::compiled::CharacterInteractionSubject>)
                            return subject.character.text();
                        else
                            return subject.interactable.text();
                    },
                    occupant.subject);
                const auto action =
                    std::holds_alternative<core::compiled::CharacterInteractionSubject>(
                        occupant.subject)
                        ? "toggle_character"
                        : "toggle_interactable";
                objects_rml << "<button class=\"object" << (occupant.enabled ? "" : " disabled")
                            << (std::find(state.selected_subjects.begin(),
                                          state.selected_subjects.end(),
                                          occupant.subject) != state.selected_subjects.end()
                                    ? " selected"
                                    : "")
                            << "\"" << typed_onclick(action, subject_text);
                if (!occupant.enabled)
                    objects_rml << " disabled";
                objects_rml << ">" << escape_rml(placement.label.value_or(subject_text))
                            << "</button>";
            }
        }
    }
    const auto objects_markup = objects_rml.str();
    if (auto* objects = find_element(doc, "rt_objects"))
        objects->SetInnerRML(objects_markup);
    set_element_visible(doc, "rt_objects_group", !objects_markup.empty());

    std::ostringstream inventory_rml;
    for (const auto& item : state.inventory.items) {
        if (!item.visible)
            continue;
        inventory_rml << "<button class=\"object" << (item.enabled ? "" : " disabled")
                      << (std::find(state.selected_subjects.begin(), state.selected_subjects.end(),
                                    core::compiled::InteractionSubject{
                                        core::compiled::InteractableInteractionSubject{
                                            item.interactable}}) != state.selected_subjects.end()
                              ? " selected"
                              : "")
                      << "\"" << typed_onclick("toggle_interactable", item.interactable.text());
        if (!item.enabled)
            inventory_rml << " disabled";
        inventory_rml << ">" << escape_rml(item.display_name) << "</button>";
    }
    const auto inventory_markup = inventory_rml.str();
    if (auto* inventory = find_element(doc, "rt_inventory"))
        inventory->SetInnerRML(inventory_markup);
    set_element_visible(doc, "rt_inventory_group", !inventory_markup.empty());

    std::ostringstream actions_rml;
    if (!state.selected_subjects.empty())
        actions_rml << "<button class=\"clear-selection\"" << typed_onclick("clear_selection")
                    << ">Clear selection</button>";
    const auto* controls = state.room ? &state.room->controls : &state.inventory.controls;
    for (const auto& control : *controls) {
        actions_rml << "<button class=\"action" << (control.enabled ? "" : " disabled") << "\""
                    << typed_onclick("invoke_interaction", control.verb.text());
        if (!control.enabled)
            actions_rml << " disabled";
        actions_rml << ">" << escape_rml(control.label) << "</button>";
    }
    const auto actions_markup = actions_rml.str();
    if (auto* actions = find_element(doc, "rt_actions"))
        actions->SetInnerRML(actions_markup);
    set_element_visible(doc, "rt_actions_group", !actions_markup.empty());
    set_element_visible(doc, "rt_interaction_dock",
                        !objects_markup.empty() || !inventory_markup.empty() ||
                            !actions_markup.empty());

    if (auto* text_log = find_component_as<NtTextLogElement>(doc, "nt-text-log")) {
        text_log->set_snapshot(make_text_log_snapshot(state));
    } else if (auto* log = find_element(doc, "rt_log")) {
        log->SetInnerRML(text_log_rml(make_text_log_snapshot(state)));
    }
    if (auto* map_view = find_component_as<NtMapViewElement>(doc, "nt-map-view")) {
        map_view->set_snapshot(make_map_view_snapshot(state));
    } else if (auto* map = find_element(doc, "rt_map")) {
        map->SetInnerRML(map_view_rml(make_map_view_snapshot(state)));
    }
}

} // namespace noveltea::ui::rmlui
