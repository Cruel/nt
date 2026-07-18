#include "ui/rmlui/runtime_ui_binder.hpp"

#include <algorithm>
#include <string>
#include <utility>

#include <sol/sol.hpp>

namespace noveltea::ui::rmlui {

RuntimeUiBinder::RuntimeUiBinder(core::Diagnostics& diagnostics) : m_diagnostics(diagnostics) {}

RuntimeUiBinder::~RuntimeUiBinder() { remove_lua_api(); }

void RuntimeUiBinder::set_lua_state(lua_State* state) noexcept
{
    if (m_lua_state == state)
        return;
    remove_lua_api();
    m_lua_state = state;
    if (m_input_sink)
        install_lua_api();
}

void RuntimeUiBinder::bind_input_sink(RuntimeUiInputSink* sink) noexcept
{
    m_input_sink = sink;
    if (sink)
        install_lua_api();
    else
        remove_lua_api();
}

void RuntimeUiBinder::bind_asset_service(const RuntimeUiAssetService* service) noexcept
{
    m_asset_service = service;
}

void RuntimeUiBinder::bind_layout_gameplay_admission(std::function<bool()> admission)
{
    m_layout_gameplay_admission = std::move(admission);
}

bool RuntimeUiBinder::apply(const RuntimeUiGameplayValues& values)
{
    if (values.revision == 0)
        return false;
    if (revision() > values.revision) {
        m_diagnostics.push_back(core::Diagnostic{
            .code = "runtime_ui.stale_gameplay_values",
            .message = "Gameplay UI revision " + std::to_string(values.revision) +
                       " is older than applied revision " + std::to_string(revision())});
        return false;
    }
    m_values = values;
    return true;
}

void RuntimeUiBinder::clear_gameplay_values() { m_values.reset(); }

const core::TypedRuntimeUIViewState* RuntimeUiBinder::view() const noexcept
{
    return m_values ? &m_values->view : nullptr;
}

std::uint64_t RuntimeUiBinder::revision() const noexcept
{
    return m_values ? m_values->revision : 0;
}

void RuntimeUiBinder::bind_document(Rml::ElementDocument& document, std::string_view notification)
{
    if (const auto* current = view())
        m_document_binder.bind(document, *current, m_asset_service, notification);
}

bool RuntimeUiBinder::dispatch_input(const core::RuntimeInputMessage& input)
{
    if (!m_input_sink) {
        m_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.input_sink_unavailable",
                             .message = "Typed runtime UI input requires a bound input sink"});
        return false;
    }
    return m_input_sink->submit_gameplay_input(input);
}

bool RuntimeUiBinder::dispatch_layout_input(const core::RuntimeInputMessage& input)
{
    return (!m_layout_gameplay_admission || m_layout_gameplay_admission()) && dispatch_input(input);
}

bool RuntimeUiBinder::dispatch_shell_command(const core::RuntimeShellCommand& command)
{
    if (!m_input_sink) {
        m_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.input_sink_unavailable",
                             .message = "Runtime shell command requires a bound input sink"});
        return false;
    }
    return m_input_sink->submit_shell_command(command);
}

bool RuntimeUiBinder::dispatch_layout_event(core::MountedLayoutOwner owner,
                                            const std::function<bool()>& dispatch)
{
    if (!m_input_sink) {
        m_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.layout_event_sink_unavailable",
                             .message = "Runtime UI layout event requires a bound input sink"});
        return false;
    }
    return m_input_sink->dispatch_layout_event(owner, dispatch);
}

bool RuntimeUiBinder::invalid(std::string code, std::string message)
{
    m_diagnostics.push_back(
        core::Diagnostic{.code = std::move(code), .message = std::move(message)});
    return false;
}

void RuntimeUiBinder::install_lua_api()
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

    auto require_view = [this]() {
        return view() != nullptr ||
               invalid("runtime_ui.view_unavailable", "Typed runtime view is unavailable");
    };

    ui.set_function("continue", [this, require_view]() {
        if (!require_view())
            return false;
        if (!view()->can_continue)
            return invalid("runtime_ui.continue_unavailable", "Continue is not currently enabled");
        return dispatch_layout_input(core::RuntimeInputMessage{core::ContinueInput{}});
    });
    ui.set_function("choose_scene", [this, require_view](std::string text) {
        if (!require_view())
            return false;
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
    });
    ui.set_function("choose_dialogue", [this, require_view](std::string text) {
        if (!require_view())
            return false;
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
    });
    ui.set_function("navigate_room", [this, require_view](std::string text) {
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
            return invalid("runtime_ui.invalid_room_exit",
                           "Room exit is stale, unknown, or disabled");
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::NavigateRoomInput{*id.value_if()}});
    });
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
    ui.set_function("toggle_interactable", [this, require_view](std::string text) {
        if (!require_view())
            return false;
        auto id = core::InteractableId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        const auto available_in_room =
            view()->room &&
            std::any_of(view()->room->placements.begin(), view()->room->placements.end(),
                        [&](const auto& placement) {
                            return std::any_of(
                                placement.occupants.begin(), placement.occupants.end(),
                                [&](const auto& occupant) {
                                    const auto* subject =
                                        std::get_if<core::compiled::InteractableInteractionSubject>(
                                            &occupant.subject);
                                    return subject != nullptr &&
                                           subject->interactable == *id.value_if() &&
                                           occupant.visible && occupant.enabled;
                                });
                        });
        const auto available_in_inventory = std::any_of(
            view()->inventory.items.begin(), view()->inventory.items.end(), [&](const auto& item) {
                return item.interactable == *id.value_if() && item.visible && item.enabled;
            });
        if (!available_in_room && !available_in_inventory)
            return invalid("runtime_ui.invalid_interactable",
                           "Interactable is stale, unknown, hidden, or disabled");
        auto selection = view()->selected_subjects;
        const core::compiled::InteractionSubject subject =
            core::compiled::InteractableInteractionSubject{*id.value_if()};
        const auto selected = std::find(selection.begin(), selection.end(), subject);
        if (selected == selection.end())
            selection.push_back(subject);
        else
            selection.erase(selected);
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{std::move(selection)}});
    });
    ui.set_function("toggle_character", [this, require_view](std::string text) {
        if (!require_view())
            return false;
        auto id = core::CharacterId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        const core::compiled::InteractionSubject subject =
            core::compiled::CharacterInteractionSubject{*id.value_if()};
        const bool available =
            view()->room &&
            std::any_of(view()->room->placements.begin(), view()->room->placements.end(),
                        [&](const auto& placement) {
                            return std::any_of(placement.occupants.begin(),
                                               placement.occupants.end(),
                                               [&](const auto& occupant) {
                                                   return occupant.subject == subject &&
                                                          occupant.visible && occupant.enabled;
                                               });
                        });
        if (!available)
            return invalid("runtime_ui.invalid_character",
                           "Character is stale, unknown, hidden, or disabled");
        auto selection = view()->selected_subjects;
        const auto selected = std::find(selection.begin(), selection.end(), subject);
        if (selected == selection.end())
            selection.push_back(subject);
        else
            selection.erase(selected);
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{std::move(selection)}});
    });
    ui.set_function("clear_selection", [this]() {
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::ClearInteractionSubjectSelectionInput{}});
    });
    ui.set_function("invoke_interaction", [this, require_view](std::string text) {
        if (!require_view())
            return false;
        auto id = core::VerbId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        const auto* controls = view()->room ? &view()->room->controls : &view()->inventory.controls;
        const auto found =
            std::find_if(controls->begin(), controls->end(),
                         [&](const auto& control) { return control.verb == *id.value_if(); });
        if (found == controls->end() || !found->enabled)
            return invalid("runtime_ui.invalid_interaction",
                           "Interaction verb is stale, unknown, or disabled");
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::InvokeInteractionInput{*id.value_if(), {}}});
    });
    game["ui"] = std::move(ui);
}

void RuntimeUiBinder::remove_lua_api() noexcept
{
    if (!m_lua_state)
        return;
    sol::state_view lua(m_lua_state);
    const sol::object game_object = lua["Game"];
    if (game_object.valid() && game_object.get_type() == sol::type::table)
        game_object.as<sol::table>()["ui"] = sol::lua_nil;
}

} // namespace noveltea::ui::rmlui
