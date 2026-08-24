#include "noveltea/runtime/runtime_executor.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace noveltea::runtime {
namespace {

core::Diagnostics map_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

core::Diagnostics map_script_error(const ScriptInvocationError& error)
{
    return map_error("execution.map_script_failed", error.message);
}

const core::compiled::RoomExit* find_exit(const RuntimeWorld& world,
                                          const core::compiled::RoomExitRef& reference)
{
    const auto* room = world.resolved_configuration(reference.room);
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

core::Result<core::MapView, RuntimeExecutionError>
RuntimeExecutor::map_view(const core::MapId& map, std::string_view runtime_locale)
{
    const auto* definition = m_project.find_map(map);
    if (definition == nullptr)
        return core::Result<core::MapView, RuntimeExecutionError>::failure(
            map_error("execution.invalid_map", "Map projection references a missing Map"));

    std::optional<std::string> title;
    if (definition->presentation.title) {
        auto resolved = resolve(definition->presentation.title->source, runtime_locale);
        auto* value = resolved.value_if();
        if (value == nullptr)
            return core::Result<core::MapView, RuntimeExecutionError>::failure(resolved.error());
        title = std::move(*value);
    }

    const auto* room_mode = std::get_if<core::RoomMode>(&m_state.mode());
    core::MapView view{.map = definition->identity.id,
                       .initial_mode = definition->presentation.initial_mode,
                       .current_room =
                           room_mode ? std::optional<core::RoomId>{room_mode->room} : std::nullopt,
                       .title = std::move(title),
                       .background = definition->presentation.background,
                       .layout = definition->presentation.layout,
                       .locations = {},
                       .connections = {}};
    view.locations.reserve(definition->locations.size());
    for (const auto& location : definition->locations) {
        std::optional<std::string> label;
        if (location.label) {
            auto resolved = resolve(location.label->source, runtime_locale);
            auto* value = resolved.value_if();
            if (value == nullptr)
                return core::Result<core::MapView, RuntimeExecutionError>::failure(
                    resolved.error());
            label = std::move(*value);
        } else if (const auto* room = m_project.find_room(location.room)) {
            label = room->display_name;
        }
        auto visible_result = evaluate(location.visibility);
        const auto* visible = visible_result.value_if();
        if (visible == nullptr)
            return core::Result<core::MapView, RuntimeExecutionError>::failure(
                visible_result.error());
        view.locations.push_back(
            {.location = location.id,
             .room = location.room,
             .regions = location.regions,
             .label = std::move(label),
             .icon = location.icon,
             .style = location.style,
             .label_anchor = location.label_anchor,
             .connection_anchor = location.connection_anchor,
             .pick_order = location.pick_order,
             .logical_order = location.logical_order,
             .current = room_mode != nullptr && room_mode->room == location.room,
             .visible = *visible,
             .actionable = false,
             .convenience_exit = std::nullopt});
    }

    const auto hook_guard =
        [this](ProjectHookKind hook, const core::RoomId& room,
               const core::compiled::RoomExitRef& exit,
               const core::RoomId& target) -> core::Result<bool, RuntimeExecutionError> {
        ProjectHookInvocationRequest request{
            .semantic_kind = ProjectHookSemanticKind::Room,
            .hook = hook,
            .target = room.text(),
            .room_transition = core::RoomTransitionContext{exit.room, target, exit,
                                                           core::RoomEntryCause::NavigationAttempt,
                                                           m_state.room_visit()},
            .active_room_context = m_state.room_visit(),
            .rejection_stage = std::nullopt,
            .result_kind = ScriptInvocationResultKind::Boolean,
        };
        auto invoked = m_scripts.invoke_project_hook(request, m_expression_capabilities);
        if (!invoked)
            return core::Result<bool, RuntimeExecutionError>::failure(
                map_script_error(invoked.error()));
        const auto* value = invoked.value_if();
        if (value == nullptr || !value->invoked)
            return core::Result<bool, RuntimeExecutionError>::success(true);
        const auto* allowed = std::get_if<bool>(&value->value);
        return allowed != nullptr ? core::Result<bool, RuntimeExecutionError>::success(*allowed)
                                  : core::Result<bool, RuntimeExecutionError>::failure(map_error(
                                        "execution.invalid_room_hook_result",
                                        "Room guard hook did not return a boolean value"));
    };

    view.connections.reserve(definition->connections.size());
    for (const auto& connection : definition->connections) {
        auto visibility_result = evaluate(connection.visibility);
        const auto* condition_visible = visibility_result.value_if();
        if (condition_visible == nullptr)
            return core::Result<core::MapView, RuntimeExecutionError>::failure(
                visibility_result.error());

        const auto source =
            std::find_if(view.locations.begin(), view.locations.end(),
                         [&connection](const core::MapLocationView& location) {
                             return location.location == connection.source_location_id;
                         });
        const auto target =
            std::find_if(view.locations.begin(), view.locations.end(),
                         [&connection](const core::MapLocationView& location) {
                             return location.location == connection.target_location_id;
                         });
        if (source == view.locations.end() || target == view.locations.end())
            return core::Result<core::MapView, RuntimeExecutionError>::failure(
                map_error("execution.invalid_map_topology",
                          "Map connection references a missing Map Location"));

        std::optional<core::compiled::RoomExitRef> active_exit;
        const core::compiled::RoomExit* linked_exit = nullptr;
        if (room_mode != nullptr) {
            for (const auto& reference : connection.exits) {
                if (reference.room != room_mode->room)
                    continue;
                if (active_exit)
                    return core::Result<core::MapView, RuntimeExecutionError>::failure(map_error(
                        "execution.invalid_map_topology", "Map connection resolves more than one "
                                                          "outgoing Exit from the active Room"));
                active_exit = reference;
                linked_exit = find_exit(m_world, reference);
            }
        }
        for (const auto& reference : connection.exits) {
            if (find_exit(m_world, reference) == nullptr)
                return core::Result<core::MapView, RuntimeExecutionError>::failure(
                    map_error("execution.invalid_map_topology",
                              "Map connection references a missing Room Exit"));
        }

        bool actionable = false;
        if (active_exit && linked_exit && m_state.flow_stack().empty()) {
            const auto* source_room = m_world.resolved_configuration(active_exit->room);
            const auto* target_room = m_world.resolved_configuration(linked_exit->target);
            if (source_room != nullptr && target_room != nullptr) {
                auto can_leave = evaluate(source_room->lifecycle.can_leave);
                if (!can_leave)
                    return core::Result<core::MapView, RuntimeExecutionError>::failure(
                        can_leave.error());
                bool leave_allowed = *can_leave.value_if();
                if (leave_allowed) {
                    auto scripted = hook_guard(ProjectHookKind::RoomCanLeave, active_exit->room,
                                               *active_exit, linked_exit->target);
                    if (!scripted)
                        return core::Result<core::MapView, RuntimeExecutionError>::failure(
                            scripted.error());
                    leave_allowed = *scripted.value_if();
                }
                auto exit_enabled = evaluate(linked_exit->condition);
                if (!exit_enabled)
                    return core::Result<core::MapView, RuntimeExecutionError>::failure(
                        exit_enabled.error());
                auto can_enter = evaluate(target_room->lifecycle.can_enter);
                if (!can_enter)
                    return core::Result<core::MapView, RuntimeExecutionError>::failure(
                        can_enter.error());
                bool enter_allowed = *can_enter.value_if();
                if (enter_allowed) {
                    auto scripted = hook_guard(ProjectHookKind::RoomCanEnter, linked_exit->target,
                                               *active_exit, linked_exit->target);
                    if (!scripted)
                        return core::Result<core::MapView, RuntimeExecutionError>::failure(
                            scripted.error());
                    enter_allowed = *scripted.value_if();
                }
                actionable = leave_allowed && *exit_enabled.value_if() && enter_allowed;
            }
        }
        const bool visible = *condition_visible && source->visible && target->visible;
        actionable = visible && actionable;

        std::optional<std::string> label;
        if (connection.label) {
            auto resolved = resolve(connection.label->source, runtime_locale);
            auto* value = resolved.value_if();
            if (value == nullptr)
                return core::Result<core::MapView, RuntimeExecutionError>::failure(
                    resolved.error());
            label = std::move(*value);
        } else {
            const auto& fallback_ref = active_exit ? *active_exit : connection.exits.front();
            if (const auto* fallback_exit = find_exit(m_world, fallback_ref)) {
                auto resolved = resolve(fallback_exit->label.source, runtime_locale);
                auto* value = resolved.value_if();
                if (value == nullptr)
                    return core::Result<core::MapView, RuntimeExecutionError>::failure(
                        resolved.error());
                label = std::move(*value);
            }
        }
        view.connections.push_back({.connection = connection.id,
                                    .exits = connection.exits,
                                    .source = connection.source_location_id,
                                    .target = connection.target_location_id,
                                    .active_exit = active_exit,
                                    .label = std::move(label),
                                    .icon = connection.icon,
                                    .style = connection.style,
                                    .logical_order = connection.logical_order,
                                    .path = connection.path,
                                    .hit_regions = connection.hit_regions,
                                    .visible = visible,
                                    .actionable = actionable});
    }

    for (auto& location : view.locations) {
        if (!location.visible || !room_mode || location.current)
            continue;
        const core::MapConnectionView* unique = nullptr;
        bool ambiguous = false;
        for (const auto& connection : view.connections) {
            if (!connection.visible || !connection.actionable || !connection.active_exit)
                continue;
            const auto* exit = find_exit(m_world, *connection.active_exit);
            if (exit == nullptr || exit->target != location.room)
                continue;
            if (unique != nullptr) {
                ambiguous = true;
                break;
            }
            unique = &connection;
        }
        if (!ambiguous && unique != nullptr) {
            location.actionable = true;
            location.convenience_exit = unique->active_exit;
        }
    }

    std::ranges::sort(view.locations, {}, [](const core::MapLocationView& location) {
        return std::pair{location.logical_order, location.location.text()};
    });
    std::ranges::sort(view.connections, {}, [](const core::MapConnectionView& connection) {
        return std::pair{connection.logical_order, connection.connection.text()};
    });
    return core::Result<core::MapView, RuntimeExecutionError>::success(std::move(view));
}

core::Result<void, RuntimeExecutionError>
RuntimeExecutor::activate_map_connection(const core::MapId& map,
                                         const core::MapConnectionId& connection,
                                         std::string_view runtime_locale)
{
    auto view_result = map_view(map, runtime_locale);
    auto* view = view_result.value_if();
    if (view == nullptr)
        return core::Result<void, RuntimeExecutionError>::failure(view_result.error());
    if (!view->current_room)
        return core::Result<void, RuntimeExecutionError>::failure(map_error(
            "execution.map_navigation_unavailable", "Map navigation requires completed Room mode"));

    const auto selected = std::find_if(view->connections.begin(), view->connections.end(),
                                       [&connection](const core::MapConnectionView& candidate) {
                                           return candidate.connection == connection;
                                       });
    if (selected == view->connections.end() || !selected->actionable || !selected->active_exit)
        return core::Result<void, RuntimeExecutionError>::failure(
            map_error("execution.map_connection_unavailable",
                      "Selected Map connection is not an actionable Exit from the active Room"));
    auto navigation = navigate(selected->active_exit->exit_id);
    if (!navigation)
        return core::Result<void, RuntimeExecutionError>::failure(navigation.error());
    return core::Result<void, RuntimeExecutionError>::success();
}

core::Result<core::TypedRuntimeUIViewState, RuntimeExecutionError>
RuntimeExecutor::runtime_ui_view(std::string_view runtime_locale)
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
                                       .maps = {},
                                       .selected_subjects = {},
                                       .verb_offers = {},
                                       .verb_menu_open = false,
                                       .command_builder = {},
                                       .can_continue = false};
    auto inventory = inventory_view(runtime_locale);
    auto* inventory_value = inventory.value_if();
    if (inventory_value == nullptr)
        return core::Result<core::TypedRuntimeUIViewState, RuntimeExecutionError>::failure(
            inventory.error());
    view.inventory = std::move(*inventory_value);

    if (has_current_room_context()) {
        auto room = room_view(runtime_locale);
        auto* value = room.value_if();
        if (value == nullptr)
            return core::Result<core::TypedRuntimeUIViewState, RuntimeExecutionError>::failure(
                room.error());
        view.room = std::move(*value);
    }
    if (!m_state.flow_stack().empty()) {
        if (std::holds_alternative<core::SceneFrame>(m_state.flow_stack().back())) {
            auto scene = scene_view();
            auto* value = scene.value_if();
            if (value == nullptr)
                return core::Result<core::TypedRuntimeUIViewState, RuntimeExecutionError>::failure(
                    scene.error());
            view.scene = std::move(*value);
        } else if (std::holds_alternative<core::DialogueFrame>(m_state.flow_stack().back())) {
            auto dialogue = dialogue_view();
            auto* value = dialogue.value_if();
            if (value == nullptr)
                return core::Result<core::TypedRuntimeUIViewState, RuntimeExecutionError>::failure(
                    dialogue.error());
            view.dialogue = std::move(*value);
        } else if (std::holds_alternative<core::InteractionFrame>(m_state.flow_stack().back())) {
            auto interaction = interaction_view(runtime_locale);
            auto* value = interaction.value_if();
            if (value == nullptr)
                return core::Result<core::TypedRuntimeUIViewState, RuntimeExecutionError>::failure(
                    interaction.error());
            view.interaction = std::move(*value);
        }
    }

    view.maps.reserve(m_project.maps().size());
    for (const auto& definition : m_project.maps()) {
        auto map = map_view(definition.identity.id, runtime_locale);
        auto* value = map.value_if();
        if (value == nullptr)
            return core::Result<core::TypedRuntimeUIViewState, RuntimeExecutionError>::failure(
                map.error());
        view.maps.push_back(std::move(*value));
    }
    return core::Result<core::TypedRuntimeUIViewState, RuntimeExecutionError>::success(
        std::move(view));
}

} // namespace noveltea::runtime
