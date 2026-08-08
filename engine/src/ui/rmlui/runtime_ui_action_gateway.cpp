#include "ui/rmlui/runtime_ui_action_gateway.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <utility>

#include <sol/sol.hpp>

namespace noveltea::ui::rmlui {

RuntimeUiActionGateway::RuntimeUiActionGateway(core::Diagnostics& diagnostics)
    : m_diagnostics(diagnostics)
{
}

RuntimeUiActionGateway::~RuntimeUiActionGateway() { remove_lua_api(); }

void RuntimeUiActionGateway::set_lua_state(lua_State* state) noexcept
{
    if (m_lua_state == state)
        return;
    remove_lua_api();
    m_lua_state = state;
    if (m_input_sink)
        install_lua_api();
}

void RuntimeUiActionGateway::bind_input_sink(RuntimeUiInputSink* sink) noexcept
{
    m_input_sink = sink;
    if (!sink) {
        m_event_capture_active = false;
        m_captured_runtime_inputs.clear();
        m_captured_shell_commands.clear();
    }
    if (sink)
        install_lua_api();
    else
        remove_lua_api();
}

void RuntimeUiActionGateway::bind_layout_gameplay_admission(std::function<bool()> admission)
{
    m_layout_gameplay_admission = std::move(admission);
}

bool RuntimeUiActionGateway::apply(const RuntimeUiGameplayValues& values)
{
    if (!can_apply(values)) {
        m_diagnostics.push_back(core::Diagnostic{
            .code = "runtime_ui.stale_gameplay_values",
            .message = "Gameplay UI revision " + std::to_string(values.revision) +
                       " is older than applied revision " + std::to_string(revision())});
        return false;
    }
    commit(values);
    return true;
}

bool RuntimeUiActionGateway::can_apply(const RuntimeUiGameplayValues& values) const noexcept
{
    return values.revision != 0 && revision() <= values.revision;
}

void RuntimeUiActionGateway::commit(RuntimeUiGameplayValues values) noexcept
{
    m_values = std::move(values);
}

void RuntimeUiActionGateway::clear_gameplay_values() { m_values.reset(); }

const core::TypedRuntimeUIViewState* RuntimeUiActionGateway::view() const noexcept
{
    return m_values ? &m_values->view : nullptr;
}

std::uint64_t RuntimeUiActionGateway::revision() const noexcept
{
    return m_values ? m_values->revision : 0;
}

bool RuntimeUiActionGateway::dispatch_input(const core::RuntimeInputMessage& input)
{
    if (!m_input_sink) {
        m_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.input_sink_unavailable",
                             .message = "Typed runtime UI input requires a bound input sink"});
        return false;
    }
    if (m_event_capture_active) {
        m_captured_runtime_inputs.push_back(input);
        return true;
    }
    return m_input_sink->submit_gameplay_input(input);
}

bool RuntimeUiActionGateway::dispatch_layout_input(const core::RuntimeInputMessage& input)
{
    if (m_layout_gameplay_admission && !m_layout_gameplay_admission())
        return invalid("runtime_ui.layout_input_blocked",
                       "Gameplay input from RuntimeUI is blocked by the active Layout policy");
    return dispatch_input(input);
}

bool RuntimeUiActionGateway::dispatch_shell_command(const core::RuntimeShellCommand& command)
{
    if (!m_input_sink) {
        m_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.input_sink_unavailable",
                             .message = "Runtime shell command requires a bound input sink"});
        return false;
    }
    if (m_event_capture_active) {
        m_captured_shell_commands.push_back(command);
        return true;
    }
    return m_input_sink->submit_shell_command(command);
}

bool RuntimeUiActionGateway::dispatch_layout_event(core::MountedLayoutOwner owner,
                                                   const std::function<bool()>& dispatch)
{
    return m_input_sink ? m_input_sink->dispatch_layout_event(owner, dispatch)
                        : dispatch && dispatch();
}

void RuntimeUiActionGateway::begin_event_capture() noexcept
{
    m_event_capture_active = true;
    m_captured_runtime_inputs.clear();
    m_captured_shell_commands.clear();
}

RuntimeUiEventResult RuntimeUiActionGateway::finish_event_capture() noexcept
{
    RuntimeUiEventResult result;
    result.runtime_inputs = std::move(m_captured_runtime_inputs);
    result.shell_commands = std::move(m_captured_shell_commands);
    m_captured_runtime_inputs.clear();
    m_captured_shell_commands.clear();
    m_event_capture_active = false;
    return result;
}

bool RuntimeUiActionGateway::invalid(std::string code, std::string message)
{
    m_diagnostics.push_back(
        core::Diagnostic{.code = std::move(code), .message = std::move(message)});
    return false;
}

bool RuntimeUiActionGateway::require_view()
{
    return view() != nullptr ||
           invalid("runtime_ui.view_unavailable", "Typed runtime view is unavailable");
}

bool RuntimeUiActionGateway::action_continue()
{
    if (!require_view())
        return false;
    if (!view()->can_continue)
        return invalid("runtime_ui.continue_unavailable", "Continue is not currently enabled");
    return dispatch_layout_input(core::RuntimeInputMessage{core::ContinueInput{}});
}

bool RuntimeUiActionGateway::action_choose(std::string kind, std::string text)
{
    if (!require_view())
        return false;
    if (kind == "scene") {
        auto id = core::SceneChoiceOptionId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        const auto* choice =
            view()->scene && view()->scene->choice ? &*view()->scene->choice : nullptr;
        const bool enabled =
            choice &&
            std::any_of(choice->options.begin(), choice->options.end(), [&](const auto& option) {
                return option.option == *id.value_if() && option.enabled;
            });
        if (!enabled)
            return invalid("runtime_ui.invalid_scene_choice",
                           "Scene choice is stale, unknown, or disabled");
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::SelectSceneChoiceInput{*id.value_if()}});
    }
    if (kind == "dialogue") {
        auto id = core::DialogueEdgeId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        const auto* choice =
            view()->dialogue && view()->dialogue->choice ? &*view()->dialogue->choice : nullptr;
        const bool enabled =
            choice &&
            std::any_of(choice->options.begin(), choice->options.end(), [&](const auto& option) {
                return option.edge == *id.value_if() && option.enabled;
            });
        if (!enabled)
            return invalid("runtime_ui.invalid_dialogue_choice",
                           "Dialogue choice is stale, unknown, or disabled");
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::SelectDialogueChoiceInput{*id.value_if()}});
    }
    return invalid("runtime_ui.invalid_choice_kind", "Choice kind must be scene or dialogue");
}

bool RuntimeUiActionGateway::action_navigate_room(std::string text)
{
    if (!require_view())
        return false;
    auto id = core::RoomExitId::create(std::move(text));
    if (!id) {
        core::append_diagnostics(m_diagnostics, id.error());
        return false;
    }
    const auto* room = view()->room ? &*view()->room : nullptr;
    const bool enabled =
        room && std::any_of(room->exits.begin(), room->exits.end(), [&](const auto& exit) {
            return exit.exit == *id.value_if() && exit.enabled;
        });
    if (!enabled)
        return invalid("runtime_ui.invalid_room_exit", "Room exit is stale, unknown, or disabled");
    return dispatch_layout_input(
        core::RuntimeInputMessage{core::NavigateRoomInput{*id.value_if()}});
}

bool RuntimeUiActionGateway::action_toggle_subject(std::string kind, std::string text)
{
    if (!require_view())
        return false;
    std::optional<core::compiled::InteractionSubject> subject;
    bool available = false;
    if (kind == "interactable") {
        auto id = core::InteractableId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        subject = core::compiled::InteractableInteractionSubject{*id.value_if()};
        const auto available_in_room =
            view()->room &&
            std::any_of(view()->room->placements.begin(), view()->room->placements.end(),
                        [&](const auto& placement) {
                            return std::any_of(placement.occupants.begin(),
                                               placement.occupants.end(),
                                               [&](const auto& occupant) {
                                                   return occupant.subject == *subject &&
                                                          occupant.visible && occupant.enabled;
                                               });
                        });
        const auto available_in_inventory = std::any_of(
            view()->inventory.items.begin(), view()->inventory.items.end(), [&](const auto& item) {
                return item.interactable == *id.value_if() && item.visible && item.enabled;
            });
        available = available_in_room || available_in_inventory;
        if (!available)
            return invalid("runtime_ui.invalid_interactable",
                           "Interactable is stale, unknown, hidden, or disabled");
    } else if (kind == "character") {
        auto id = core::CharacterId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        subject = core::compiled::CharacterInteractionSubject{*id.value_if()};
        available = view()->room &&
                    std::any_of(view()->room->placements.begin(), view()->room->placements.end(),
                                [&](const auto& placement) {
                                    return std::any_of(placement.occupants.begin(),
                                                       placement.occupants.end(),
                                                       [&](const auto& occupant) {
                                                           return occupant.subject == *subject &&
                                                                  occupant.visible &&
                                                                  occupant.enabled;
                                                       });
                                });
        if (!available)
            return invalid("runtime_ui.invalid_character",
                           "Character is stale, unknown, hidden, or disabled");
    } else {
        return invalid("runtime_ui.invalid_subject_kind",
                       "Interaction subject kind must be character or interactable");
    }
    auto selection = view()->selected_subjects;
    const auto selected = std::find(selection.begin(), selection.end(), *subject);
    if (selected == selection.end())
        selection.push_back(*subject);
    else
        selection.erase(selected);
    return dispatch_layout_input(
        core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{std::move(selection)}});
}

bool RuntimeUiActionGateway::action_clear_selection()
{
    return dispatch_layout_input(
        core::RuntimeInputMessage{core::ClearInteractionSubjectSelectionInput{}});
}

bool RuntimeUiActionGateway::action_invoke_interaction(std::string text)
{
    if (!require_view())
        return false;
    auto id = core::VerbId::create(std::move(text));
    if (!id) {
        core::append_diagnostics(m_diagnostics, id.error());
        return false;
    }
    const auto* controls = view()->room ? &view()->room->controls : &view()->inventory.controls;
    const auto found = std::find_if(controls->begin(), controls->end(), [&](const auto& control) {
        return control.verb == *id.value_if();
    });
    if (found == controls->end() || !found->enabled)
        return invalid("runtime_ui.invalid_interaction",
                       "Interaction verb is stale, unknown, or disabled");
    return dispatch_layout_input(
        core::RuntimeInputMessage{core::InvokeInteractionInput{*id.value_if(), {}}});
}

bool RuntimeUiActionGateway::action_save_slot(std::uint64_t number)
{
    if (number > std::numeric_limits<std::uint32_t>::max())
        return invalid("runtime_ui.invalid_save_slot",
                       "Save slot number must be a valid manual slot");
    return dispatch_shell_command(core::RuntimeShellCommand{core::SaveShellSlotCommand{
        core::TypedSaveSlotId::manual(static_cast<std::uint32_t>(number))}});
}

bool RuntimeUiActionGateway::action_load_slot(std::string kind, std::uint64_t number)
{
    if (kind == "autosave") {
        if (number != 0)
            return invalid("runtime_ui.invalid_load_slot", "Autosave slot number must be zero");
        return dispatch_shell_command(core::RuntimeShellCommand{
            core::RequestLoadShellSlotCommand{core::TypedSaveSlotId::autosave()}});
    }
    if (kind == "manual") {
        if (number > std::numeric_limits<std::uint32_t>::max())
            return invalid("runtime_ui.invalid_load_slot",
                           "Load slot number must be a valid manual slot");
        return dispatch_shell_command(core::RuntimeShellCommand{core::RequestLoadShellSlotCommand{
            core::TypedSaveSlotId::manual(static_cast<std::uint32_t>(number))}});
    }
    return invalid("runtime_ui.invalid_load_slot_kind",
                   "Load slot kind must be autosave or manual");
}

void RuntimeUiActionGateway::install_lua_api()
{
    if (!m_lua_state || !m_input_sink)
        return;

    sol::state_view lua(m_lua_state);
    sol::table game;
    const sol::object existing = lua["Game"];
    if (existing.valid() && existing.get_type() == sol::type::table)
        game = existing.as<sol::table>();
    else {
        game = lua.create_table();
        lua["Game"] = game;
    }
    sol::table ui = lua.create_table();

    ui.set_function("continue", [this]() { return action_continue(); });
    ui.set_function("choose_scene",
                    [this](std::string text) { return action_choose("scene", std::move(text)); });
    ui.set_function("choose_dialogue", [this](std::string text) {
        return action_choose("dialogue", std::move(text));
    });
    ui.set_function("navigate_room",
                    [this](std::string text) { return action_navigate_room(std::move(text)); });

    auto require_view = [this]() { return this->require_view(); };
    ui.set_function("navigate_map_connection", [this, require_view](std::string text) {
        if (!require_view())
            return false;
        auto id = core::MapConnectionId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        const auto* map = view()->map ? &*view()->map : nullptr;
        const core::MapConnectionView* found = nullptr;
        if (map) {
            const auto it = std::find_if(
                map->connections.begin(), map->connections.end(),
                [&](const auto& connection) { return connection.connection == *id.value_if(); });
            if (it != map->connections.end() && it->selectable)
                found = &*it;
        }
        if (!found)
            return invalid("runtime_ui.invalid_map_connection",
                           "Map connection is stale, unknown, or disabled");
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::NavigateRoomInput{found->exit.exit_id}});
    });
    ui.set_function("toggle_interactable", [this](std::string text) {
        return action_toggle_subject("interactable", std::move(text));
    });
    ui.set_function("toggle_character", [this](std::string text) {
        return action_toggle_subject("character", std::move(text));
    });
    ui.set_function("clear_selection", [this]() { return action_clear_selection(); });
    ui.set_function("invoke_interaction", [this](std::string text) {
        return action_invoke_interaction(std::move(text));
    });
    ui.set_function("activate_hotspot", [this, require_view](std::string kind,
                                                             std::string owner_text,
                                                             std::string hotspot_text) {
        if (!require_view())
            return false;
        auto hotspot = core::HotspotId::create(std::move(hotspot_text));
        if (!hotspot) {
            core::append_diagnostics(m_diagnostics, hotspot.error());
            return false;
        }
        if (kind == "room-hotspot") {
            auto owner = core::RoomId::create(std::move(owner_text));
            if (!owner) {
                core::append_diagnostics(m_diagnostics, owner.error());
                return false;
            }
            return dispatch_layout_input(
                core::RuntimeInputMessage{core::ActivateHotspotInput{core::compiled::RoomHotspotRef{
                    std::move(*owner.value_if()), std::move(*hotspot.value_if())}}});
        }
        if (kind == "interactable-hotspot") {
            auto owner = core::InteractableId::create(std::move(owner_text));
            if (!owner) {
                core::append_diagnostics(m_diagnostics, owner.error());
                return false;
            }
            return dispatch_layout_input(core::RuntimeInputMessage{
                core::ActivateHotspotInput{core::compiled::InteractableHotspotRef{
                    std::move(*owner.value_if()), std::move(*hotspot.value_if())}}});
        }
        return invalid("runtime_ui.invalid_hotspot_kind", "Hotspot kind must be room-hotspot or "
                                                          "interactable-hotspot");
    });
    game["ui"] = std::move(ui);
}

void RuntimeUiActionGateway::remove_lua_api() noexcept
{
    if (!m_lua_state)
        return;
    sol::state_view lua(m_lua_state);
    const sol::object game_object = lua["Game"];
    if (game_object.valid() && game_object.get_type() == sol::type::table)
        game_object.as<sol::table>()["ui"] = sol::lua_nil;
}

} // namespace noveltea::ui::rmlui
