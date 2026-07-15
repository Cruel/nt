#include "noveltea/script/typed_execution_kernel.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace noveltea::script {
namespace {

core::Diagnostics map_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

const core::compiled::MapLocation* find_location(const core::compiled::MapDefinition& map,
                                                 const core::MapLocationId& location)
{
    const auto found = std::find_if(map.locations.begin(), map.locations.end(),
                                    [&location](const core::compiled::MapLocation& candidate) {
                                        return candidate.id == location;
                                    });
    return found == map.locations.end() ? nullptr : &*found;
}

const core::compiled::RoomExit* find_exit(const core::CompiledProject& project,
                                          const core::compiled::RoomExitRef& reference)
{
    const auto* room = project.find_room(reference.room);
    if (room == nullptr)
        return nullptr;
    const auto found = std::find_if(room->exits.begin(), room->exits.end(),
                                    [&reference](const core::compiled::RoomExit& candidate) {
                                        return candidate.id == reference.exit_id;
                                    });
    return found == room->exits.end() ? nullptr : &*found;
}

std::string runtime_mode_name(const core::SessionState& state)
{
    if (std::holds_alternative<core::RoomMode>(state.mode()))
        return "room";
    if (std::holds_alternative<core::EndedMode>(state.mode()))
        return "ended";
    if (state.flow_stack().empty())
        return "flow";
    return std::visit(
        [](const auto& frame) {
            using Frame = std::decay_t<decltype(frame)>;
            if constexpr (std::is_same_v<Frame, core::SceneFrame>)
                return std::string{"scene"};
            if constexpr (std::is_same_v<Frame, core::DialogueFrame>)
                return std::string{"dialogue"};
            if constexpr (std::is_same_v<Frame, core::InteractionFrame>)
                return std::string{"interaction"};
            return std::string{"room-transition"};
        },
        state.flow_stack().back());
}

} // namespace

core::Result<void, core::Diagnostics>
TypedExecutionKernel::present_map(const core::MapId& map,
                                  std::optional<core::compiled::InitialMapMode> mode, bool visible,
                                  std::optional<core::MapLocationId> focused_location)
{
    const auto* definition = m_project.find_map(map);
    if (definition == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            map_error("execution.invalid_map", "Map presentation references a missing Map"));
    return m_state.set_map_presentation(
        m_project,
        core::MapPresentationState{map, mode.value_or(definition->presentation.initial_mode),
                                   visible, std::move(focused_location)});
}

core::Result<void, core::Diagnostics> TypedExecutionKernel::hide_map()
{
    if (!m_state.map_presentation())
        return core::Result<void, core::Diagnostics>::failure(
            map_error("execution.map_not_presented", "No typed Map presentation is active"));
    auto state = *m_state.map_presentation();
    state.visible = false;
    return m_state.set_map_presentation(m_project, std::move(state));
}

core::Result<core::MapView, TypedExecutionError>
TypedExecutionKernel::map_view(std::string_view runtime_locale)
{
    const auto* presentation = m_state.map_presentation() ? &*m_state.map_presentation() : nullptr;
    const auto* definition =
        presentation == nullptr ? nullptr : m_project.find_map(presentation->map);
    if (presentation == nullptr || definition == nullptr)
        return core::Result<core::MapView, TypedExecutionError>::failure(
            map_error("execution.map_view_unavailable", "No typed Map presentation is active"));

    std::optional<std::string> title;
    if (definition->presentation.title) {
        auto resolved = resolve(definition->presentation.title->source, runtime_locale);
        auto* value = resolved.value_if();
        if (value == nullptr)
            return core::Result<core::MapView, TypedExecutionError>::failure(resolved.error());
        title = std::move(*value);
    }

    const auto* room_mode = std::get_if<core::RoomMode>(&m_state.mode());
    core::MapView view{.map = definition->identity.id,
                       .mode = presentation->mode,
                       .visible = presentation->visible,
                       .current_room =
                           room_mode ? std::optional<core::RoomId>{room_mode->room} : std::nullopt,
                       .title = std::move(title),
                       .background = definition->presentation.background,
                       .layout = definition->presentation.layout,
                       .locations = {},
                       .connections = {}};
    for (const auto& location : definition->locations) {
        std::optional<std::string> label;
        if (location.label) {
            auto resolved = resolve(location.label->source, runtime_locale);
            auto* value = resolved.value_if();
            if (value == nullptr)
                return core::Result<core::MapView, TypedExecutionError>::failure(resolved.error());
            label = std::move(*value);
        }
        view.locations.push_back({location.id, location.room, location.position, location.shape,
                                  std::move(label), presentation->focused_location == location.id});
    }
    for (const auto& connection : definition->connections) {
        const auto* exit = find_exit(m_project, connection.exit);
        if (exit == nullptr)
            return core::Result<core::MapView, TypedExecutionError>::failure(map_error(
                "execution.invalid_map_topology", "Map connection references a missing Room exit"));
        bool selectable = false;
        if (presentation->visible && room_mode != nullptr &&
            connection.exit.room == room_mode->room) {
            auto enabled = evaluate(exit->condition);
            const auto* value = enabled.value_if();
            if (value == nullptr)
                return core::Result<core::MapView, TypedExecutionError>::failure(enabled.error());
            selectable = *value;
        }
        view.connections.push_back({connection.id, connection.exit, connection.source_location_id,
                                    connection.target_location_id, selectable});
    }
    return core::Result<core::MapView, TypedExecutionError>::success(std::move(view));
}

core::Result<void, TypedExecutionError>
TypedExecutionKernel::select_map_location(const core::MapLocationId& location,
                                          std::string_view runtime_locale)
{
    auto view_result = map_view(runtime_locale);
    auto* view = view_result.value_if();
    if (view == nullptr)
        return core::Result<void, TypedExecutionError>::failure(view_result.error());
    if (!view->visible)
        return core::Result<void, TypedExecutionError>::failure(
            map_error("execution.map_selection_unavailable",
                      "Map selection requires a visible typed Map presentation"));
    const auto* definition = m_project.find_map(view->map);
    const auto* selected = definition == nullptr ? nullptr : find_location(*definition, location);
    if (selected == nullptr)
        return core::Result<void, TypedExecutionError>::failure(
            map_error("execution.invalid_map_location", "Selected Map location is missing"));

    auto next_state = *m_state.map_presentation();
    next_state.focused_location = location;
    auto stored = m_state.set_map_presentation(m_project, std::move(next_state));
    return stored ? core::Result<void, TypedExecutionError>::success()
                  : core::Result<void, TypedExecutionError>::failure(stored.error());
}

core::Result<void, TypedExecutionError>
TypedExecutionKernel::activate_map_connection(const core::MapConnectionId& connection,
                                              std::string_view runtime_locale)
{
    auto view_result = map_view(runtime_locale);
    auto* view = view_result.value_if();
    if (view == nullptr)
        return core::Result<void, TypedExecutionError>::failure(view_result.error());
    if (!view->visible || !view->current_room)
        return core::Result<void, TypedExecutionError>::failure(
            map_error("execution.map_navigation_unavailable",
                      "Map navigation requires a visible Map in completed Room mode"));

    const auto selected = std::find_if(view->connections.begin(), view->connections.end(),
                                       [&connection](const core::MapConnectionView& candidate) {
                                           return candidate.connection == connection;
                                       });
    if (selected == view->connections.end() || !selected->selectable)
        return core::Result<void, TypedExecutionError>::failure(
            map_error("execution.map_connection_unavailable",
                      "Selected Map connection is not an enabled exit from the active Room"));
    auto navigation = navigate(selected->exit.exit_id);
    if (!navigation)
        return core::Result<void, TypedExecutionError>::failure(navigation.error());
    return core::Result<void, TypedExecutionError>::success();
}

core::Result<core::TypedRuntimeUIViewState, TypedExecutionError>
TypedExecutionKernel::runtime_ui_view(std::string_view runtime_locale)
{
    core::TypedRuntimeUIViewState view{.mode = runtime_mode_name(m_state),
                                       .gameplay_paused = m_state.gameplay_paused(),
                                       .effective_gameplay_pause = {},
                                       .scene = std::nullopt,
                                       .dialogue = std::nullopt,
                                       .room = std::nullopt,
                                       .interaction = std::nullopt,
                                       .inventory = {},
                                       .text_log = {m_state.text_log()},
                                       .map = std::nullopt,
                                       .selected_interactables = {},
                                       .can_continue = false};
    auto inventory = inventory_view(runtime_locale);
    auto* inventory_value = inventory.value_if();
    if (inventory_value == nullptr)
        return core::Result<core::TypedRuntimeUIViewState, TypedExecutionError>::failure(
            inventory.error());
    view.inventory = std::move(*inventory_value);

    if (std::holds_alternative<core::RoomMode>(m_state.mode()) && m_state.flow_stack().empty()) {
        auto room = room_view(runtime_locale);
        auto* value = room.value_if();
        if (value == nullptr)
            return core::Result<core::TypedRuntimeUIViewState, TypedExecutionError>::failure(
                room.error());
        view.room = std::move(*value);
    } else if (!m_state.flow_stack().empty()) {
        if (std::holds_alternative<core::SceneFrame>(m_state.flow_stack().back())) {
            auto scene = scene_view();
            auto* value = scene.value_if();
            if (value == nullptr)
                return core::Result<core::TypedRuntimeUIViewState, TypedExecutionError>::failure(
                    scene.error());
            view.scene = std::move(*value);
        } else if (std::holds_alternative<core::DialogueFrame>(m_state.flow_stack().back())) {
            auto dialogue = dialogue_view();
            auto* value = dialogue.value_if();
            if (value == nullptr)
                return core::Result<core::TypedRuntimeUIViewState, TypedExecutionError>::failure(
                    dialogue.error());
            view.dialogue = std::move(*value);
        } else if (std::holds_alternative<core::InteractionFrame>(m_state.flow_stack().back())) {
            auto interaction = interaction_view(runtime_locale);
            auto* value = interaction.value_if();
            if (value == nullptr)
                return core::Result<core::TypedRuntimeUIViewState, TypedExecutionError>::failure(
                    interaction.error());
            view.interaction = std::move(*value);
        }
    }
    if (m_state.map_presentation()) {
        auto map = map_view(runtime_locale);
        auto* value = map.value_if();
        if (value == nullptr)
            return core::Result<core::TypedRuntimeUIViewState, TypedExecutionError>::failure(
                map.error());
        view.map = std::move(*value);
    }
    return core::Result<core::TypedRuntimeUIViewState, TypedExecutionError>::success(
        std::move(view));
}

} // namespace noveltea::script
