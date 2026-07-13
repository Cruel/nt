#include "script/lua/script_runtime_internal.hpp"

#include <noveltea/core/script_host_services.hpp>

#include <lua.hpp>
#include <sol/sol.hpp>

#include <cmath>
#include <cstdint>
#include <string>
#include <tuple>
#include <type_traits>
#include <utility>

namespace noveltea::script {
namespace {

using ObjectResult = std::tuple<sol::object, sol::object>;
using MutationResult = std::tuple<bool, sol::object>;

std::string diagnostic_message(const core::Diagnostics& diagnostics)
{
    return diagnostics.empty() ? "typed host request failed" : diagnostics.front().message;
}

sol::object nil(sol::state_view lua) { return sol::make_object(lua, sol::lua_nil); }

ObjectResult failure(sol::state_view lua, const core::Diagnostics& diagnostics)
{
    return {nil(lua), sol::make_object(lua, diagnostic_message(diagnostics))};
}

MutationResult mutation(sol::state_view lua, const core::Result<void, core::Diagnostics>& result)
{
    return result
               ? MutationResult{true, nil(lua)}
               : MutationResult{false, sol::make_object(lua, diagnostic_message(result.error()))};
}

core::Result<core::RuntimeValue, core::Diagnostics> runtime_value(const sol::object& object)
{
    using Result = core::Result<core::RuntimeValue, core::Diagnostics>;
    if (!object.valid() || object == sol::lua_nil)
        return Result::success(std::monostate{});
    switch (object.get_type()) {
    case sol::type::boolean:
        return Result::success(object.as<bool>());
    case sol::type::number:
        if (object.is<std::int64_t>())
            return Result::success(object.as<std::int64_t>());
        if (const double value = object.as<double>(); std::isfinite(value))
            return Result::success(value);
        break;
    case sol::type::string:
        return Result::success(object.as<std::string>());
    default:
        break;
    }
    return Result::failure(core::Diagnostics{core::Diagnostic{
        .code = "script_host.invalid_runtime_value",
        .message = "Host values must be nil, boolean, finite number, integer, or string",
    }});
}

sol::object lua_value(sol::state_view lua, const core::RuntimeValue& value)
{
    return std::visit(
        [&lua](const auto& item) -> sol::object {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, std::monostate>)
                return nil(lua);
            else
                return sol::make_object(lua, item);
        },
        value);
}

template<class Id> core::Result<Id, core::Diagnostics> parse_id(std::string value)
{
    return Id::create(std::move(value));
}

core::Result<core::PropertyOwnerRef, core::Diagnostics> property_owner(std::string kind,
                                                                       std::string id)
{
    using Result = core::Result<core::PropertyOwnerRef, core::Diagnostics>;
#define NOVELTEA_PARSE_OWNER(text, type)                                                           \
    if (kind == text) {                                                                            \
        auto parsed = type::create(std::move(id));                                                 \
        auto* value = parsed.value_if();                                                           \
        return value ? Result::success(core::PropertyOwnerRef{std::move(*value)})                  \
                     : Result::failure(parsed.error());                                            \
    }
    NOVELTEA_PARSE_OWNER("room", core::RoomId)
    NOVELTEA_PARSE_OWNER("scene", core::SceneId)
    NOVELTEA_PARSE_OWNER("dialogue", core::DialogueId)
    NOVELTEA_PARSE_OWNER("character", core::CharacterId)
    NOVELTEA_PARSE_OWNER("interactable", core::InteractableId)
    NOVELTEA_PARSE_OWNER("verb", core::VerbId)
    NOVELTEA_PARSE_OWNER("interaction", core::InteractionId)
    NOVELTEA_PARSE_OWNER("map", core::MapId)
#undef NOVELTEA_PARSE_OWNER
    return Result::failure(core::Diagnostics{core::Diagnostic{
        .code = "script_host.invalid_owner_kind",
        .message = "Property owner kind is invalid",
    }});
}

sol::object definition_object(sol::state_view lua, const core::ProjectDefinitionSummary& value)
{
    sol::table result = lua.create_table();
    result["id"] = value.id;
    if (value.display_name)
        result["display_name"] = *value.display_name;
    return sol::make_object(lua, result);
}

sol::object location_object(sol::state_view lua, const core::compiled::InteractableLocation& value)
{
    sol::table result = lua.create_table();
    std::visit(
        [&result](const auto& location) {
            using T = std::decay_t<decltype(location)>;
            if constexpr (std::is_same_v<T, core::compiled::InventoryLocation>)
                result["kind"] = "inventory";
            else if constexpr (std::is_same_v<T, core::compiled::NowhereLocation>)
                result["kind"] = "nowhere";
            else {
                result["kind"] = "room-placement";
                result["room"] = location.room.text();
                result["placement"] = location.placement_id.text();
            }
        },
        value);
    return sol::make_object(lua, result);
}

template<class Id, class Operation>
MutationResult id_mutation(sol::state_view lua, std::string value, Operation operation)
{
    auto parsed = parse_id<Id>(std::move(value));
    auto* parsed_id = parsed.value_if();
    if (parsed_id == nullptr)
        return mutation(lua, core::Result<void, core::Diagnostics>::failure(parsed.error()));
    return mutation(lua, operation(std::move(*parsed_id)));
}

void bind_definition_reader(sol::table project, const char* name, core::ProjectDefinitionKind kind,
                            core::ScriptHostServices* host)
{
    project.set_function(name, [host, kind](std::string id, sol::this_state state) -> ObjectResult {
        sol::state_view lua(state);
        auto value = host->definition(kind, std::move(id));
        const auto* summary = value.value_if();
        return summary ? ObjectResult{definition_object(lua, *summary), nil(lua)}
                       : failure(lua, value.error());
    });
}

} // namespace

void bind_typed_script_host(lua_State* state, core::ScriptHostServices* host)
{
    sol::state_view lua(state);
    sol::table noveltea = lua["noveltea"].get_or_create<sol::table>();
    if (host == nullptr) {
        clear_typed_script_host(state);
        return;
    }

    sol::table project = lua.create_table();
    bind_definition_reader(project, "room", core::ProjectDefinitionKind::Room, host);
    bind_definition_reader(project, "scene", core::ProjectDefinitionKind::Scene, host);
    bind_definition_reader(project, "dialogue", core::ProjectDefinitionKind::Dialogue, host);
    bind_definition_reader(project, "character", core::ProjectDefinitionKind::Character, host);
    bind_definition_reader(project, "interactable", core::ProjectDefinitionKind::Interactable,
                           host);
    bind_definition_reader(project, "verb", core::ProjectDefinitionKind::Verb, host);
    bind_definition_reader(project, "interaction", core::ProjectDefinitionKind::Interaction, host);
    bind_definition_reader(project, "map", core::ProjectDefinitionKind::Map, host);
    noveltea["project"] = project;

    sol::table variables = lua.create_table();
    variables.set_function("get", [host](std::string id, sol::this_state state) -> ObjectResult {
        sol::state_view view(state);
        auto parsed = parse_id<core::VariableId>(std::move(id));
        const auto* parsed_id = parsed.value_if();
        if (parsed_id == nullptr)
            return failure(view, parsed.error());
        auto value = host->variable(*parsed_id);
        const auto* runtime = value.value_if();
        return runtime ? ObjectResult{lua_value(view, *runtime), nil(view)}
                       : failure(view, value.error());
    });
    variables.set_function(
        "set", [host](std::string id, sol::object value, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto parsed_id = parse_id<core::VariableId>(std::move(id));
            auto parsed_value = runtime_value(value);
            auto* variable_id = parsed_id.value_if();
            auto* runtime = parsed_value.value_if();
            if (variable_id == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(parsed_id.error()));
            if (runtime == nullptr)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(parsed_value.error()));
            return mutation(view, host->set_variable(std::move(*variable_id), std::move(*runtime)));
        });
    noveltea["variables"] = variables;

    sol::table properties = lua.create_table();
    properties.set_function(
        "get",
        [host](std::string kind, std::string owner_id, std::string property_id,
               sol::this_state state) -> std::tuple<sol::object, bool, sol::object> {
            sol::state_view view(state);
            auto owner = property_owner(std::move(kind), std::move(owner_id));
            auto property = parse_id<core::PropertyId>(std::move(property_id));
            const auto* owner_ref = owner.value_if();
            const auto* property_ref = property.value_if();
            if (owner_ref == nullptr)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(owner.error()))};
            if (property_ref == nullptr)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(property.error()))};
            auto value = host->property(*owner_ref, *property_ref);
            const auto* lookup = value.value_if();
            if (lookup == nullptr)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(value.error()))};
            if (const auto* present = std::get_if<core::RuntimeValue>(lookup))
                return {lua_value(view, *present), true, nil(view)};
            return {nil(view), false, nil(view)};
        });
    properties.set_function(
        "set",
        [host](std::string kind, std::string owner_id, std::string property_id, sol::object value,
               sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto owner = property_owner(std::move(kind), std::move(owner_id));
            auto property = parse_id<core::PropertyId>(std::move(property_id));
            auto parsed_value = runtime_value(value);
            auto* owner_ref = owner.value_if();
            const auto* property_ref = property.value_if();
            auto* runtime = parsed_value.value_if();
            if (owner_ref == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            if (property_ref == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(property.error()));
            if (runtime == nullptr)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(parsed_value.error()));
            return mutation(view, host->set_property(std::move(*owner_ref), *property_ref,
                                                     std::move(*runtime)));
        });
    properties.set_function(
        "unset",
        [host](std::string kind, std::string owner_id, std::string property_id,
               sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto owner = property_owner(std::move(kind), std::move(owner_id));
            auto property = parse_id<core::PropertyId>(std::move(property_id));
            const auto* owner_ref = owner.value_if();
            const auto* property_ref = property.value_if();
            if (owner_ref == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(owner.error()));
            if (property_ref == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(property.error()));
            return mutation(view, host->unset_property(*owner_ref, *property_ref));
        });
    noveltea["properties"] = properties;

    sol::table interactables = lua.create_table();
    interactables.set_function(
        "initial_location", [host](std::string id, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableId>(std::move(id));
            const auto* interactable = parsed.value_if();
            if (interactable == nullptr)
                return failure(view, parsed.error());
            auto value = host->initial_interactable_location(*interactable);
            const auto* location = value.value_if();
            return location ? ObjectResult{location_object(view, *location), nil(view)}
                            : failure(view, value.error());
        });
    interactables.set_function("move_to_inventory", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        return id_mutation<core::InteractableId>(
            view, std::move(id), [host](core::InteractableId parsed) {
                return host->request_interactable_location(std::move(parsed),
                                                           core::compiled::InventoryLocation{});
            });
    });
    interactables.set_function("move_to_nowhere", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        return id_mutation<core::InteractableId>(
            view, std::move(id), [host](core::InteractableId parsed) {
                return host->request_interactable_location(std::move(parsed),
                                                           core::compiled::NowhereLocation{});
            });
    });
    interactables.set_function(
        "move_to_placement",
        [host](std::string id, std::string room, std::string placement,
               sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto interactable = parse_id<core::InteractableId>(std::move(id));
            auto room_id = parse_id<core::RoomId>(std::move(room));
            auto placement_id = parse_id<core::RoomPlacementId>(std::move(placement));
            auto* interactable_ref = interactable.value_if();
            auto* room_ref = room_id.value_if();
            auto* placement_ref = placement_id.value_if();
            if (interactable_ref == nullptr)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(interactable.error()));
            if (room_ref == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(room_id.error()));
            if (placement_ref == nullptr)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(placement_id.error()));
            return mutation(view, host->request_interactable_location(
                                      std::move(*interactable_ref),
                                      core::compiled::RoomPlacementRef{std::move(*room_ref),
                                                                       std::move(*placement_ref)}));
        });
    noveltea["interactables"] = interactables;

    sol::table navigation = lua.create_table();
    navigation.set_function(
        "via_exit",
        [host](std::string room, std::string exit, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto room_id = parse_id<core::RoomId>(std::move(room));
            auto exit_id = parse_id<core::RoomExitId>(std::move(exit));
            auto* room_ref = room_id.value_if();
            auto* exit_ref = exit_id.value_if();
            if (room_ref == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(room_id.error()));
            if (exit_ref == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(exit_id.error()));
            return mutation(view, host->request_navigation(core::compiled::RoomExitRef{
                                      std::move(*room_ref), std::move(*exit_ref)}));
        });
    noveltea["navigation"] = navigation;

    sol::table flow = lua.create_table();
    flow.set_function("start_transient_scene", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        return id_mutation<core::SceneId>(view, std::move(id), [host](core::SceneId parsed) {
            return host->request_transient(std::move(parsed));
        });
    });
    flow.set_function("start_transient_dialogue", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        return id_mutation<core::DialogueId>(view, std::move(id), [host](core::DialogueId parsed) {
            return host->request_transient(std::move(parsed));
        });
    });
    flow.set_function("call_scene", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        return id_mutation<core::SceneId>(view, std::move(id), [host](core::SceneId parsed) {
            return host->request_child(std::move(parsed));
        });
    });
    flow.set_function("call_dialogue", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        return id_mutation<core::DialogueId>(view, std::move(id), [host](core::DialogueId parsed) {
            return host->request_child(std::move(parsed));
        });
    });
    flow.set_function("replace_scene", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        return id_mutation<core::SceneId>(view, std::move(id), [host](core::SceneId parsed) {
            return host->request_tail_replacement(std::move(parsed));
        });
    });
    flow.set_function("replace_dialogue", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        return id_mutation<core::DialogueId>(view, std::move(id), [host](core::DialogueId parsed) {
            return host->request_tail_replacement(std::move(parsed));
        });
    });
    flow.set_function("replace_room", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        return id_mutation<core::RoomId>(view, std::move(id), [host](core::RoomId parsed) {
            return host->request_tail_replacement(std::move(parsed));
        });
    });
    flow.set_function("return_to_caller", [host](sol::this_state state) {
        sol::state_view view(state);
        return mutation(view, host->request_tail_replacement(core::ReturnFlow{}));
    });
    flow.set_function("end_flow", [host](sol::this_state state) {
        sol::state_view view(state);
        return mutation(view, host->request_tail_replacement(core::EndFlow{}));
    });
    noveltea["flow"] = flow;

    noveltea.set_function("notify", [host](std::string message, sol::this_state state) {
        sol::state_view view(state);
        return mutation(view, host->request_notification(std::move(message)));
    });
}

void clear_typed_script_host(lua_State* state)
{
    sol::state_view lua(state);
    sol::table noveltea = lua["noveltea"].get_or_create<sol::table>();
    noveltea["project"] = sol::lua_nil;
    noveltea["variables"] = sol::lua_nil;
    noveltea["properties"] = sol::lua_nil;
    noveltea["interactables"] = sol::lua_nil;
    noveltea["navigation"] = sol::lua_nil;
    noveltea["flow"] = sol::lua_nil;
    noveltea["notify"] = sol::lua_nil;
}

} // namespace noveltea::script
