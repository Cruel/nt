#include "script/lua/script_runtime_internal.hpp"

#include <noveltea/script/runtime_script_api.hpp>

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

struct GameplayIdentityReference {
    RuntimeScriptApi* host = nullptr;
    core::PropertyOwnerRef owner;
    std::string kind;
    std::string id;
};

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
    NOVELTEA_PARSE_OWNER("character", core::CharacterId)
    NOVELTEA_PARSE_OWNER("interactable", core::InteractableInstanceId)
#undef NOVELTEA_PARSE_OWNER
    return Result::failure(core::Diagnostics{core::Diagnostic{
        .code = "script_host.invalid_owner_kind",
        .message = "Property owner kind is invalid",
    }});
}

core::Result<core::FeatureRef, core::Diagnostics>
feature_ref(std::string owner_kind, std::string owner_id, std::string feature_id)
{
    using Result = core::Result<core::FeatureRef, core::Diagnostics>;
    auto feature = parse_id<core::FeatureId>(std::move(feature_id));
    if (!feature)
        return Result::failure(feature.error());
    if (owner_kind == "room") {
        auto owner = parse_id<core::RoomId>(std::move(owner_id));
        return owner ? Result::success(core::FeatureRef{core::RoomFeatureRef{
                           std::move(*owner.value_if()), std::move(*feature.value_if())}})
                     : Result::failure(owner.error());
    }
    if (owner_kind == "interactable") {
        auto owner = parse_id<core::InteractableInstanceId>(std::move(owner_id));
        return owner ? Result::success(core::FeatureRef{core::InteractableFeatureRef{
                           std::move(*owner.value_if()), std::move(*feature.value_if())}})
                     : Result::failure(owner.error());
    }
    return Result::failure(core::Diagnostics{core::Diagnostic{
        .code = "script_host.invalid_feature_owner_kind",
        .message = "Feature owner kind must be room or interactable",
    }});
}

core::Result<core::compiled::InteractionSubject, core::Diagnostics>
interaction_subject(const sol::table& subject)
{
    using Result = core::Result<core::compiled::InteractionSubject, core::Diagnostics>;
    const sol::object kind_object = subject["kind"];
    if (!kind_object.is<std::string>())
        return Result::failure(core::Diagnostics{core::Diagnostic{
            .code = "runtime.invalid_interaction_operand",
            .message = "Interaction subjects require a string kind",
        }});
    const auto kind = kind_object.as<std::string>();
    if (kind == "feature") {
        const sol::object owner_kind = subject["ownerKind"];
        const sol::object owner_id = subject["ownerId"];
        const sol::object feature_id = subject["featureId"];
        if (!owner_kind.is<std::string>() || !owner_id.is<std::string>() ||
            !feature_id.is<std::string>())
            return Result::failure(core::Diagnostics{core::Diagnostic{
                .code = "runtime.invalid_interaction_operand",
                .message = "Feature subjects require ownerKind, ownerId, and featureId strings",
            }});
        auto feature = feature_ref(owner_kind.as<std::string>(), owner_id.as<std::string>(),
                                   feature_id.as<std::string>());
        return feature ? Result::success(core::compiled::FeatureInteractionSubject{
                             std::move(*feature.value_if())})
                       : Result::failure(feature.error());
    }
    const sol::object id_object = subject["id"];
    if (!id_object.is<std::string>())
        return Result::failure(core::Diagnostics{core::Diagnostic{
            .code = "runtime.invalid_interaction_operand",
            .message = "Character and Interactable subjects require a string id",
        }});
    const auto id = id_object.as<std::string>();
    if (kind == "character") {
        auto parsed = parse_id<core::CharacterId>(id);
        return parsed ? Result::success(core::compiled::CharacterInteractionSubject{
                            std::move(*parsed.value_if())})
                      : Result::failure(parsed.error());
    }
    if (kind == "interactable") {
        auto parsed = parse_id<core::InteractableInstanceId>(id);
        return parsed ? Result::success(core::compiled::InteractableInteractionSubject{
                            std::move(*parsed.value_if())})
                      : Result::failure(parsed.error());
    }
    return Result::failure(core::Diagnostics{core::Diagnostic{
        .code = "runtime.invalid_interaction_operand",
        .message = "Interaction subject kind must be character, interactable, or feature",
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

sol::object inventory_owner_object(sol::state_view lua,
                                   const core::compiled::InventoryOwnerRef& value)
{
    sol::table result = lua.create_table();
    std::visit(
        [&result](const auto& owner) {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, core::compiled::ProjectInventoryOwner>)
                result["kind"] = "project";
            else if constexpr (std::is_same_v<T, core::compiled::CharacterInventoryOwner>) {
                result["kind"] = "character";
                result["character"] = owner.character.text();
            } else if constexpr (std::is_same_v<T, core::compiled::InteractableInventoryOwner>) {
                result["kind"] = "interactable";
                result["interactable"] = owner.interactable.text();
            } else if constexpr (std::is_same_v<T, core::RoomFeatureRef>) {
                result["kind"] = "room-feature";
                result["room"] = owner.room.text();
                result["feature"] = owner.feature_id.text();
            } else {
                result["kind"] = "interactable-feature";
                result["interactable"] = owner.interactable.text();
                result["feature"] = owner.feature_id.text();
            }
        },
        value);
    return sol::make_object(lua, result);
}

sol::object inventory_ref_object(sol::state_view lua, const core::compiled::InventoryRef& value)
{
    sol::table result = lua.create_table();
    result["owner"] = inventory_owner_object(lua, value.owner);
    result["id"] = value.inventory_id.text();
    return sol::make_object(lua, result);
}

sol::object location_object(sol::state_view lua, const core::compiled::InteractableLocation& value)
{
    sol::table result = lua.create_table();
    std::visit(
        [&lua, &result](const auto& location) {
            using T = std::decay_t<decltype(location)>;
            if constexpr (std::is_same_v<T, core::compiled::InventoryLocation>) {
                result["kind"] = "inventory";
                result["inventory"] = inventory_ref_object(lua, location.inventory);
            } else if constexpr (std::is_same_v<T, core::compiled::UnplacedLocation>)
                result["kind"] = "unplaced";
            else {
                result["kind"] = "room";
                result["room"] = location.room.text();
            }
        },
        value);
    return sol::make_object(lua, result);
}

sol::object item_stack_object(sol::state_view lua, const core::ItemStackState& value)
{
    sol::table result = lua.create_table();
    result["id"] = value.id.text();
    result["definition"] = value.definition.text();
    result["quantity"] = value.quantity;
    result["location"] = location_object(lua, value.location);
    result["declared"] = value.declared;
    sol::table traits = lua.create_table();
    for (std::size_t index = 0; index < value.traits.size(); ++index)
        traits[index + 1] = value.traits[index].text();
    result["traits"] = std::move(traits);
    return sol::make_object(lua, result);
}

sol::object item_mutation_object(sol::state_view lua, const runtime::ItemStackMutation& value)
{
    sol::table result = lua.create_table();
    result["quantity"] = value.quantity;
    const auto ids = [&lua](const std::vector<core::ItemStackId>& values) {
        sol::table table = lua.create_table();
        for (std::size_t index = 0; index < values.size(); ++index)
            table[index + 1] = values[index].text();
        return table;
    };
    result["surviving"] = ids(value.surviving);
    result["changed"] = ids(value.changed);
    result["created"] = ids(value.created);
    result["ended"] = ids(value.ended);
    return sol::make_object(lua, result);
}

sol::object
interactable_quantity_mutation_object(sol::state_view lua,
                                      const runtime::InteractableQuantityMutation& value)
{
    sol::table result = lua.create_table();
    result["quantity"] = value.quantity;
    const auto ids = [&lua](const std::vector<core::InteractableInstanceId>& values) {
        sol::table table = lua.create_table();
        for (std::size_t index = 0; index < values.size(); ++index)
            table[index + 1] = values[index].text();
        return table;
    };
    result["surviving"] = ids(value.surviving);
    result["changed"] = ids(value.changed);
    result["created"] = ids(value.created);
    result["ended"] = ids(value.ended);
    return sol::make_object(lua, result);
}

sol::object character_location_object(sol::state_view lua,
                                      const core::CharacterWorldLocation& value)
{
    sol::table result = lua.create_table();
    std::visit(
        [&result](const auto& location) {
            using T = std::decay_t<decltype(location)>;
            if constexpr (std::is_same_v<T, core::compiled::UnplacedLocation>)
                result["kind"] = "unplaced";
            else {
                result["kind"] = "room";
                result["room"] = location.room.text();
            }
        },
        value);
    return sol::make_object(lua, result);
}

core::Diagnostics location_error(std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = "script_host.invalid_location", .message = std::move(message)}};
}

core::Result<core::compiled::InventoryOwnerRef, core::Diagnostics>
parse_inventory_owner(const sol::table& value)
{
    using Result = core::Result<core::compiled::InventoryOwnerRef, core::Diagnostics>;
    const sol::object kind_value = value["kind"];
    if (!kind_value.is<std::string>())
        return Result::failure(location_error("Inventory owner requires a string kind"));
    const auto kind = kind_value.as<std::string>();
    if (kind == "project")
        return Result::success(core::compiled::ProjectInventoryOwner{});
    if (kind == "character") {
        const sol::object id = value["character"];
        if (!id.is<std::string>())
            return Result::failure(location_error("Character Inventory owner requires character"));
        auto parsed = parse_id<core::CharacterId>(id.as<std::string>());
        return parsed ? Result::success(
                            core::compiled::CharacterInventoryOwner{std::move(*parsed.value_if())})
                      : Result::failure(parsed.error());
    }
    if (kind == "interactable") {
        const sol::object id = value["interactable"];
        if (!id.is<std::string>())
            return Result::failure(
                location_error("Interactable Inventory owner requires interactable"));
        auto parsed = parse_id<core::InteractableInstanceId>(id.as<std::string>());
        return parsed ? Result::success(core::compiled::InteractableInventoryOwner{
                            std::move(*parsed.value_if())})
                      : Result::failure(parsed.error());
    }
    if (kind == "room-feature") {
        const sol::object room = value["room"];
        const sol::object feature = value["feature"];
        if (!room.is<std::string>() || !feature.is<std::string>())
            return Result::failure(
                location_error("Room Feature Inventory owner requires room and feature"));
        auto room_id = parse_id<core::RoomId>(room.as<std::string>());
        auto feature_id = parse_id<core::FeatureId>(feature.as<std::string>());
        if (!room_id)
            return Result::failure(room_id.error());
        if (!feature_id)
            return Result::failure(feature_id.error());
        return Result::success(core::RoomFeatureRef{std::move(*room_id.value_if()),
                                                    std::move(*feature_id.value_if())});
    }
    if (kind == "interactable-feature") {
        const sol::object interactable = value["interactable"];
        const sol::object feature = value["feature"];
        if (!interactable.is<std::string>() || !feature.is<std::string>())
            return Result::failure(location_error(
                "Interactable Feature Inventory owner requires interactable and feature"));
        auto interactable_id =
            parse_id<core::InteractableInstanceId>(interactable.as<std::string>());
        auto feature_id = parse_id<core::FeatureId>(feature.as<std::string>());
        if (!interactable_id)
            return Result::failure(interactable_id.error());
        if (!feature_id)
            return Result::failure(feature_id.error());
        return Result::success(core::InteractableFeatureRef{std::move(*interactable_id.value_if()),
                                                            std::move(*feature_id.value_if())});
    }
    return Result::failure(location_error("Unknown Inventory owner kind '" + kind + "'"));
}

core::Result<core::compiled::InventoryRef, core::Diagnostics>
parse_inventory_ref(const sol::table& value)
{
    using Result = core::Result<core::compiled::InventoryRef, core::Diagnostics>;
    const sol::object owner = value["owner"];
    const sol::object id = value["id"];
    if (!owner.is<sol::table>() || !id.is<std::string>())
        return Result::failure(location_error("Inventory reference requires owner and string id"));
    auto parsed_owner = parse_inventory_owner(owner.as<sol::table>());
    auto parsed_id = parse_id<core::InventoryId>(id.as<std::string>());
    if (!parsed_owner)
        return Result::failure(parsed_owner.error());
    if (!parsed_id)
        return Result::failure(parsed_id.error());
    return Result::success(core::compiled::InventoryRef{std::move(*parsed_owner.value_if()),
                                                        std::move(*parsed_id.value_if())});
}

core::Result<core::compiled::InteractableLocation, core::Diagnostics>
parse_interactable_location(const sol::table& value)
{
    using Result = core::Result<core::compiled::InteractableLocation, core::Diagnostics>;
    const sol::object kind_value = value["kind"];
    if (!kind_value.is<std::string>())
        return Result::failure(location_error("Interactable Location requires a string kind"));
    const auto kind = kind_value.as<std::string>();
    if (kind == "unplaced")
        return Result::success(core::compiled::UnplacedLocation{});
    if (kind == "room") {
        const sol::object room = value["room"];
        if (!room.is<std::string>())
            return Result::failure(location_error("Room Location requires room"));
        auto parsed = parse_id<core::RoomId>(room.as<std::string>());
        return parsed ? Result::success(core::compiled::RoomLocation{std::move(*parsed.value_if())})
                      : Result::failure(parsed.error());
    }
    if (kind == "inventory") {
        const sol::object inventory = value["inventory"];
        if (!inventory.is<sol::table>())
            return Result::failure(location_error("Inventory Location requires inventory"));
        auto parsed = parse_inventory_ref(inventory.as<sol::table>());
        return parsed ? Result::success(
                            core::compiled::InventoryLocation{std::move(*parsed.value_if())})
                      : Result::failure(parsed.error());
    }
    return Result::failure(location_error("Unknown Interactable Location kind '" + kind + "'"));
}

core::Result<core::CharacterWorldLocation, core::Diagnostics>
parse_character_location(const sol::table& value)
{
    using Result = core::Result<core::CharacterWorldLocation, core::Diagnostics>;
    const sol::object kind_value = value["kind"];
    if (!kind_value.is<std::string>())
        return Result::failure(location_error("Character Location requires a string kind"));
    const auto kind = kind_value.as<std::string>();
    if (kind == "unplaced")
        return Result::success(core::compiled::UnplacedLocation{});
    if (kind == "room") {
        const sol::object room = value["room"];
        if (!room.is<std::string>())
            return Result::failure(location_error("Room Location requires room"));
        auto parsed = parse_id<core::RoomId>(room.as<std::string>());
        return parsed ? Result::success(core::compiled::RoomLocation{std::move(*parsed.value_if())})
                      : Result::failure(parsed.error());
    }
    return Result::failure(location_error("Character Location kind must be room or unplaced"));
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
                            RuntimeScriptApi* host)
{
    project.set_function(name, [host, kind](std::string id, sol::this_state state) -> ObjectResult {
        sol::state_view lua(state);
        auto value = host->definition(kind, std::move(id));
        const auto* summary = value.value_if();
        return summary ? ObjectResult{definition_object(lua, *summary), nil(lua)}
                       : failure(lua, value.error());
    });
}

template<class Id>
void bind_identity_reader(sol::table project, const char* name, core::ProjectDefinitionKind kind,
                          const char* identity_kind, RuntimeScriptApi* host)
{
    project.set_function(
        name, [host, kind, identity_kind](std::string id, sol::this_state state) -> ObjectResult {
            sol::state_view lua(state);
            auto parsed = parse_id<Id>(id);
            if (!parsed)
                return failure(lua, parsed.error());
            auto definition = host->definition(kind, id);
            if (!definition)
                return failure(lua, definition.error());
            return {
                sol::make_object(lua,
                                 GameplayIdentityReference{
                                     host, core::PropertyOwnerRef{std::move(*parsed.value_if())},
                                     identity_kind, std::move(id)}),
                nil(lua)};
        });
}

} // namespace

void bind_typed_script_host(lua_State* state, RuntimeScriptApi* host)
{
    sol::state_view lua(state);
    sol::table noveltea = lua["noveltea"].get_or_create<sol::table>();
    if (host == nullptr) {
        clear_typed_script_host(state);
        return;
    }

    lua.new_usertype<GameplayIdentityReference>(
        "__noveltea_gameplay_identity", sol::no_constructor, "kind",
        sol::property(
            [](const GameplayIdentityReference& self) -> const std::string& { return self.kind; }),
        "id", sol::property([](const GameplayIdentityReference& self) -> const std::string& {
            return self.id;
        }),
        "prop",
        [](GameplayIdentityReference& self, std::string property_id,
           sol::this_state state) -> std::tuple<sol::object, bool, sol::object> {
            sol::state_view view(state);
            auto property = parse_id<core::PropertyId>(std::move(property_id));
            if (!property)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(property.error()))};
            auto value = self.host->property(self.owner, *property.value_if());
            const auto* lookup = value.value_if();
            if (!lookup)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(value.error()))};
            if (const auto* present = std::get_if<core::RuntimeValue>(lookup))
                return {lua_value(view, *present), true, nil(view)};
            return {nil(view), false, nil(view)};
        },
        "set_prop",
        [](GameplayIdentityReference& self, std::string property_id, sol::object value,
           sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto property = parse_id<core::PropertyId>(std::move(property_id));
            auto parsed_value = runtime_value(value);
            if (!property)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(property.error()));
            if (!parsed_value)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(parsed_value.error()));
            return mutation(view, self.host->set_property(self.owner, *property.value_if(),
                                                          std::move(*parsed_value.value_if())));
        },
        "unset_prop",
        [](GameplayIdentityReference& self, std::string property_id,
           sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto property = parse_id<core::PropertyId>(std::move(property_id));
            if (!property)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(property.error()));
            return mutation(view, self.host->unset_property(self.owner, *property.value_if()));
        },
        "location",
        [](GameplayIdentityReference& self, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            if (const auto* character = std::get_if<core::CharacterId>(&self.owner)) {
                auto value = self.host->character_location(*character);
                return value ? ObjectResult{character_location_object(view, *value.value_if()),
                                            nil(view)}
                             : failure(view, value.error());
            }
            if (const auto* interactable = std::get_if<core::InteractableInstanceId>(&self.owner)) {
                auto value = self.host->interactable_location(*interactable);
                return value ? ObjectResult{location_object(view, *value.value_if()), nil(view)}
                             : failure(view, value.error());
            }
            return failure(view, location_error("This gameplay identity has no world Location"));
        },
        "set_location",
        [](GameplayIdentityReference& self, sol::table target,
           sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            if (const auto* character = std::get_if<core::CharacterId>(&self.owner)) {
                auto location = parse_character_location(target);
                return location ? mutation(view, self.host->request_character_location(
                                                     *character, std::move(*location.value_if())))
                                : mutation(view, core::Result<void, core::Diagnostics>::failure(
                                                     location.error()));
            }
            if (const auto* interactable = std::get_if<core::InteractableInstanceId>(&self.owner)) {
                auto location = parse_interactable_location(target);
                return location
                           ? mutation(view, self.host->request_interactable_location(
                                                *interactable, std::move(*location.value_if())))
                           : mutation(view, core::Result<void, core::Diagnostics>::failure(
                                                location.error()));
            }
            return mutation(view, core::Result<void, core::Diagnostics>::failure(location_error(
                                      "This gameplay identity has no mutable world Location")));
        });
    lua["__noveltea_gameplay_identity"] = sol::lua_nil;

    sol::table project = lua.create_table();
    bind_identity_reader<core::RoomId>(project, "room", core::ProjectDefinitionKind::Room, "room",
                                       host);
    bind_definition_reader(project, "scene", core::ProjectDefinitionKind::Scene, host);
    bind_definition_reader(project, "dialogue", core::ProjectDefinitionKind::Dialogue, host);
    bind_identity_reader<core::CharacterId>(
        project, "character", core::ProjectDefinitionKind::Character, "character", host);
    bind_identity_reader<core::InteractableInstanceId>(
        project, "interactable", core::ProjectDefinitionKind::Interactable, "interactable", host);
    project.set_function(
        "feature",
        [host](std::string owner_kind, std::string owner_id, std::string feature_id,
               sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            const std::string qualified_id = owner_kind + ":" + owner_id + "#" + feature_id;
            auto feature = feature_ref(owner_kind, owner_id, feature_id);
            if (!feature)
                return failure(view, feature.error());
            auto owner = std::visit(
                [](auto reference) { return core::PropertyOwnerRef{std::move(reference)}; },
                std::move(*feature.value_if()));
            return {sol::make_object(view, GameplayIdentityReference{host, std::move(owner),
                                                                     "feature", qualified_id}),
                    nil(view)};
        });
    bind_definition_reader(project, "verb", core::ProjectDefinitionKind::Verb, host);
    bind_definition_reader(project, "interaction", core::ProjectDefinitionKind::Interaction, host);
    bind_definition_reader(project, "map", core::ProjectDefinitionKind::Map, host);
    noveltea["project"] = project;

    sol::table game_properties = lua["Game"].get_or_create<sol::table>();
    game_properties.set_function(
        "prop",
        [host](std::string id,
               sol::this_state state) -> std::tuple<sol::object, bool, sol::object> {
            sol::state_view view(state);
            auto parsed = parse_id<core::PropertyId>(std::move(id));
            const auto* parsed_id = parsed.value_if();
            if (parsed_id == nullptr)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(parsed.error()))};
            auto value = host->global_property_lookup(*parsed_id);
            const auto* lookup = value.value_if();
            if (lookup == nullptr)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(value.error()))};
            if (const auto* present = std::get_if<core::RuntimeValue>(lookup))
                return {lua_value(view, *present), true, nil(view)};
            return {nil(view), false, nil(view)};
        });
    game_properties.set_function(
        "set_prop",
        [host](std::string id, sol::object value, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto parsed_id = parse_id<core::PropertyId>(std::move(id));
            auto parsed_value = runtime_value(value);
            auto* property_id = parsed_id.value_if();
            auto* runtime = parsed_value.value_if();
            if (property_id == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(parsed_id.error()));
            if (runtime == nullptr)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(parsed_value.error()));
            return mutation(
                view, host->set_global_property(std::move(*property_id), std::move(*runtime)));
        });
    game_properties.set_function(
        "unset_prop", [host](std::string id, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto parsed_id = parse_id<core::PropertyId>(std::move(id));
            auto* property_id = parsed_id.value_if();
            if (property_id == nullptr)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(parsed_id.error()));
            return mutation(view, host->unset_global_property(*property_id));
        });

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
    properties.set_function(
        "get_feature",
        [host](std::string owner_kind, std::string owner_id, std::string feature_id,
               std::string property_id,
               sol::this_state state) -> std::tuple<sol::object, bool, sol::object> {
            sol::state_view view(state);
            auto feature =
                feature_ref(std::move(owner_kind), std::move(owner_id), std::move(feature_id));
            auto property = parse_id<core::PropertyId>(std::move(property_id));
            if (!feature)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(feature.error()))};
            if (!property)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(property.error()))};
            auto owner =
                std::visit([](const auto& reference) { return core::PropertyOwnerRef{reference}; },
                           *feature.value_if());
            auto value = host->property(owner, *property.value_if());
            const auto* lookup = value.value_if();
            if (lookup == nullptr)
                return {nil(view), false,
                        sol::make_object(view, diagnostic_message(value.error()))};
            if (const auto* present = std::get_if<core::RuntimeValue>(lookup))
                return {lua_value(view, *present), true, nil(view)};
            return {nil(view), false, nil(view)};
        });
    properties.set_function(
        "set_feature",
        [host](std::string owner_kind, std::string owner_id, std::string feature_id,
               std::string property_id, sol::object value,
               sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto feature =
                feature_ref(std::move(owner_kind), std::move(owner_id), std::move(feature_id));
            auto property = parse_id<core::PropertyId>(std::move(property_id));
            auto parsed_value = runtime_value(value);
            if (!feature)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(feature.error()));
            if (!property)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(property.error()));
            if (!parsed_value)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(parsed_value.error()));
            auto owner =
                std::visit([](const auto& reference) { return core::PropertyOwnerRef{reference}; },
                           *feature.value_if());
            return mutation(view, host->set_property(std::move(owner), *property.value_if(),
                                                     std::move(*parsed_value.value_if())));
        });
    properties.set_function(
        "unset_feature",
        [host](std::string owner_kind, std::string owner_id, std::string feature_id,
               std::string property_id, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto feature =
                feature_ref(std::move(owner_kind), std::move(owner_id), std::move(feature_id));
            auto property = parse_id<core::PropertyId>(std::move(property_id));
            if (!feature)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(feature.error()));
            if (!property)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(property.error()));
            auto owner =
                std::visit([](const auto& reference) { return core::PropertyOwnerRef{reference}; },
                           *feature.value_if());
            return mutation(view, host->unset_property(owner, *property.value_if()));
        });
    noveltea["properties"] = properties;

    sol::table interactables = lua.create_table();
    interactables.set_function(
        "location", [host](std::string id, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableInstanceId>(std::move(id));
            const auto* interactable = parsed.value_if();
            if (interactable == nullptr)
                return failure(view, parsed.error());
            auto value = host->interactable_location(*interactable);
            const auto* location = value.value_if();
            return location ? ObjectResult{location_object(view, *location), nil(view)}
                            : failure(view, value.error());
        });
    interactables.set_function(
        "set_location",
        [host](std::string id, sol::table target, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto interactable = parse_id<core::InteractableInstanceId>(std::move(id));
            auto location = parse_interactable_location(target);
            if (!interactable)
                return mutation(
                    view, core::Result<void, core::Diagnostics>::failure(interactable.error()));
            if (!location)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(location.error()));
            return mutation(view,
                            host->request_interactable_location(std::move(*interactable.value_if()),
                                                                std::move(*location.value_if())));
        });
    interactables.set_function(
        "quantity", [host](std::string id, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableInstanceId>(std::move(id));
            if (!parsed)
                return failure(view, parsed.error());
            auto value = host->interactable_quantity(*parsed.value_if());
            return value ? ObjectResult{sol::make_object(view, *value.value_if()), nil(view)}
                         : failure(view, value.error());
        });
    interactables.set_function(
        "create_quantity",
        [host](std::string definition, std::uint64_t quantity, sol::table target,
               sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableDefinitionId>(std::move(definition));
            auto location = parse_interactable_location(target);
            if (!parsed)
                return failure(view, parsed.error());
            if (!location)
                return failure(view, location.error());
            auto value = host->create_interactable_quantity(std::move(*parsed.value_if()), quantity,
                                                            std::move(*location.value_if()));
            return value ? ObjectResult{interactable_quantity_mutation_object(view,
                                                                              *value.value_if()),
                                        nil(view)}
                         : failure(view, value.error());
        });
    interactables.set_function(
        "split",
        [host](std::string id, std::uint64_t quantity, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableInstanceId>(std::move(id));
            if (!parsed)
                return failure(view, parsed.error());
            auto value = host->split_interactable_quantity(std::move(*parsed.value_if()), quantity);
            return value ? ObjectResult{interactable_quantity_mutation_object(view,
                                                                              *value.value_if()),
                                        nil(view)}
                         : failure(view, value.error());
        });
    interactables.set_function(
        "merge",
        [host](std::string receiver, std::string donor, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto receiver_id = parse_id<core::InteractableInstanceId>(std::move(receiver));
            auto donor_id = parse_id<core::InteractableInstanceId>(std::move(donor));
            if (!receiver_id)
                return failure(view, receiver_id.error());
            if (!donor_id)
                return failure(view, donor_id.error());
            auto value = host->merge_interactable_quantities(std::move(*receiver_id.value_if()),
                                                             std::move(*donor_id.value_if()));
            return value ? ObjectResult{interactable_quantity_mutation_object(view,
                                                                              *value.value_if()),
                                        nil(view)}
                         : failure(view, value.error());
        });
    interactables.set_function(
        "transfer",
        [host](std::string id, std::uint64_t quantity, sol::table target,
               sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableInstanceId>(std::move(id));
            auto location = parse_interactable_location(target);
            if (!parsed)
                return failure(view, parsed.error());
            if (!location)
                return failure(view, location.error());
            auto value = host->transfer_interactable_quantity(
                std::move(*parsed.value_if()), quantity, std::move(*location.value_if()));
            return value ? ObjectResult{interactable_quantity_mutation_object(view,
                                                                              *value.value_if()),
                                        nil(view)}
                         : failure(view, value.error());
        });
    interactables.set_function(
        "add_quantity",
        [host](std::string definition, std::uint64_t quantity, sol::table target,
               sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableDefinitionId>(std::move(definition));
            auto location = parse_interactable_location(target);
            if (!parsed)
                return failure(view, parsed.error());
            if (!location)
                return failure(view, location.error());
            auto value = host->add_interactable_quantity(std::move(*parsed.value_if()), quantity,
                                                         std::move(*location.value_if()));
            return value ? ObjectResult{interactable_quantity_mutation_object(view,
                                                                              *value.value_if()),
                                        nil(view)}
                         : failure(view, value.error());
        });
    interactables.set_function(
        "consume",
        [host](std::string id, std::uint64_t quantity, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableInstanceId>(std::move(id));
            if (!parsed)
                return failure(view, parsed.error());
            auto value =
                host->consume_interactable_quantity(std::move(*parsed.value_if()), quantity);
            return value ? ObjectResult{interactable_quantity_mutation_object(view,
                                                                              *value.value_if()),
                                        nil(view)}
                         : failure(view, value.error());
        });
    interactables.set_function(
        "aggregate_definition",
        [host](std::string definition, sol::optional<sol::table> source,
               sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableDefinitionId>(std::move(definition));
            if (!parsed)
                return failure(view, parsed.error());
            std::optional<core::compiled::InteractableLocation> source_location;
            if (source) {
                auto location = parse_interactable_location(*source);
                if (!location)
                    return failure(view, location.error());
                source_location = std::move(*location.value_if());
            }
            auto value = host->aggregate_interactable_quantity(runtime::InteractableQuantityFilter{
                std::move(*parsed.value_if()), std::move(source_location)});
            return value ? ObjectResult{sol::make_object(view, *value.value_if()), nil(view)}
                         : failure(view, value.error());
        });
    interactables.set_function(
        "transfer_definition",
        [host](std::string definition, std::uint64_t quantity, sol::table source, sol::table target,
               sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableDefinitionId>(std::move(definition));
            auto source_location = parse_interactable_location(source);
            auto target_location = parse_interactable_location(target);
            if (!parsed)
                return failure(view, parsed.error());
            if (!source_location)
                return failure(view, source_location.error());
            if (!target_location)
                return failure(view, target_location.error());
            auto value = host->transfer_interactable_quantity(
                runtime::InteractableQuantityFilter{std::move(*parsed.value_if()),
                                                    std::move(*source_location.value_if())},
                quantity, std::move(*target_location.value_if()));
            return value ? ObjectResult{interactable_quantity_mutation_object(view,
                                                                              *value.value_if()),
                                        nil(view)}
                         : failure(view, value.error());
        });
    interactables.set_function(
        "consume_definition",
        [host](std::string definition, std::uint64_t quantity, sol::optional<sol::table> source,
               sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::InteractableDefinitionId>(std::move(definition));
            if (!parsed)
                return failure(view, parsed.error());
            std::optional<core::compiled::InteractableLocation> source_location;
            if (source) {
                auto location = parse_interactable_location(*source);
                if (!location)
                    return failure(view, location.error());
                source_location = std::move(*location.value_if());
            }
            auto value = host->consume_interactable_quantity(
                runtime::InteractableQuantityFilter{std::move(*parsed.value_if()),
                                                    std::move(source_location)},
                quantity);
            return value ? ObjectResult{interactable_quantity_mutation_object(view,
                                                                              *value.value_if()),
                                        nil(view)}
                         : failure(view, value.error());
        });
    noveltea["interactables"] = interactables;

    sol::table item_stacks = lua.create_table();
    item_stacks.set_function("get", [host](std::string id, sol::this_state state) -> ObjectResult {
        sol::state_view view(state);
        auto parsed = parse_id<core::ItemStackId>(std::move(id));
        if (!parsed)
            return failure(view, parsed.error());
        auto value = host->item_stack(*parsed.value_if());
        return value ? ObjectResult{item_stack_object(view, *value.value_if()), nil(view)}
                     : failure(view, value.error());
    });
    item_stacks.set_function(
        "split",
        [host](std::string id, std::uint64_t quantity, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::ItemStackId>(std::move(id));
            if (!parsed)
                return failure(view, parsed.error());
            auto value = host->split_item_stack(std::move(*parsed.value_if()), quantity);
            return value ? ObjectResult{item_mutation_object(view, *value.value_if()), nil(view)}
                         : failure(view, value.error());
        });
    item_stacks.set_function(
        "merge",
        [host](std::string receiver, std::string donor, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto receiver_id = parse_id<core::ItemStackId>(std::move(receiver));
            auto donor_id = parse_id<core::ItemStackId>(std::move(donor));
            if (!receiver_id)
                return failure(view, receiver_id.error());
            if (!donor_id)
                return failure(view, donor_id.error());
            auto value = host->merge_item_stacks(std::move(*receiver_id.value_if()),
                                                 std::move(*donor_id.value_if()));
            return value ? ObjectResult{item_mutation_object(view, *value.value_if()), nil(view)}
                         : failure(view, value.error());
        });
    item_stacks.set_function(
        "transfer",
        [host](std::string id, std::uint64_t quantity, sol::table target,
               sol::optional<bool> keep_separate, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::ItemStackId>(std::move(id));
            auto location = parse_interactable_location(target);
            if (!parsed)
                return failure(view, parsed.error());
            if (!location)
                return failure(view, location.error());
            auto value = host->transfer_item_quantity(
                std::move(*parsed.value_if()), quantity, std::move(*location.value_if()),
                keep_separate.value_or(false) ? runtime::ItemStackPlacementPolicy::KeepSeparate
                                              : runtime::ItemStackPlacementPolicy::Coalesce);
            return value ? ObjectResult{item_mutation_object(view, *value.value_if()), nil(view)}
                         : failure(view, value.error());
        });
    item_stacks.set_function(
        "grant",
        [host](std::string definition, std::uint64_t quantity, sol::table target,
               sol::optional<bool> keep_separate, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::ItemDefinitionId>(std::move(definition));
            auto location = parse_interactable_location(target);
            if (!parsed)
                return failure(view, parsed.error());
            if (!location)
                return failure(view, location.error());
            auto value = host->grant_item_quantity(
                std::move(*parsed.value_if()), quantity, std::move(*location.value_if()),
                keep_separate.value_or(false) ? runtime::ItemStackPlacementPolicy::KeepSeparate
                                              : runtime::ItemStackPlacementPolicy::Coalesce);
            return value ? ObjectResult{item_mutation_object(view, *value.value_if()), nil(view)}
                         : failure(view, value.error());
        });
    item_stacks.set_function(
        "consume",
        [host](std::string id, std::uint64_t quantity, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::ItemStackId>(std::move(id));
            if (!parsed)
                return failure(view, parsed.error());
            auto value = host->consume_item_quantity(std::move(*parsed.value_if()), quantity);
            return value ? ObjectResult{item_mutation_object(view, *value.value_if()), nil(view)}
                         : failure(view, value.error());
        });
    item_stacks.set_function(
        "aggregate_definition",
        [host](std::string definition, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::ItemDefinitionId>(std::move(definition));
            if (!parsed)
                return failure(view, parsed.error());
            auto value = host->aggregate_item_quantity(
                runtime::ItemStackFilter{std::move(*parsed.value_if()), std::nullopt});
            return value ? ObjectResult{sol::make_object(view, *value.value_if()), nil(view)}
                         : failure(view, value.error());
        });
    item_stacks.set_function(
        "consume_definition",
        [host](std::string definition, std::uint64_t quantity,
               sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::ItemDefinitionId>(std::move(definition));
            if (!parsed)
                return failure(view, parsed.error());
            auto value = host->consume_item_quantity(
                runtime::ItemStackFilter{std::move(*parsed.value_if()), std::nullopt}, quantity);
            return value ? ObjectResult{item_mutation_object(view, *value.value_if()), nil(view)}
                         : failure(view, value.error());
        });
    noveltea["item_stacks"] = item_stacks;

    sol::table characters = lua.create_table();
    characters.set_function(
        "location", [host](std::string id, sol::this_state state) -> ObjectResult {
            sol::state_view view(state);
            auto parsed = parse_id<core::CharacterId>(std::move(id));
            const auto* character = parsed.value_if();
            if (character == nullptr)
                return failure(view, parsed.error());
            auto value = host->character_location(*character);
            const auto* location = value.value_if();
            return location ? ObjectResult{character_location_object(view, *location), nil(view)}
                            : failure(view, value.error());
        });
    characters.set_function(
        "set_location",
        [host](std::string id, sol::table target, sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto character = parse_id<core::CharacterId>(std::move(id));
            auto location = parse_character_location(target);
            if (!character)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(character.error()));
            if (!location)
                return mutation(view,
                                core::Result<void, core::Diagnostics>::failure(location.error()));
            return mutation(view,
                            host->request_character_location(std::move(*character.value_if()),
                                                             std::move(*location.value_if())));
        });
    noveltea["characters"] = characters;

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

    sol::table game = lua["Game"].get_or_create<sol::table>();
    game.set_function("continue", [host](sol::this_state state) {
        return mutation(sol::state_view(state), host->continue_game());
    });
    game.set_function("choose", [host](std::int64_t index, sol::this_state state) {
        sol::state_view view(state);
        if (index < 0)
            return mutation(
                view,
                core::Result<void, core::Diagnostics>::failure(core::Diagnostics{core::Diagnostic{
                    .code = "runtime.script_index_out_of_range",
                    .message = "Game.choose uses zero-based non-negative indices"}}));
        return mutation(view, host->choose(static_cast<std::size_t>(index)));
    });
    game.set_function("navigate", [host](std::int64_t index, sol::this_state state) {
        sol::state_view view(state);
        if (index < 0)
            return mutation(
                view,
                core::Result<void, core::Diagnostics>::failure(core::Diagnostics{core::Diagnostic{
                    .code = "runtime.script_index_out_of_range",
                    .message = "Game.navigate uses zero-based non-negative indices"}}));
        return mutation(view, host->navigate(static_cast<std::size_t>(index)));
    });
    game.set_function("select_object", [host](std::string id, sol::this_state state) {
        sol::state_view view(state);
        auto parsed = parse_id<core::InteractableInstanceId>(std::move(id));
        auto* value = parsed.value_if();
        return value
                   ? mutation(view, host->select_interactable(std::move(*value)))
                   : mutation(view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
    });
    game.set_function("clear_selection", [host](sol::this_state state) {
        return mutation(sol::state_view(state), host->clear_selection());
    });
    game.set_function(
        "run_action",
        [host](std::string verb_id, sol::optional<sol::table> slot_bindings,
               sol::this_state state) -> MutationResult {
            sol::state_view view(state);
            auto verb = parse_id<core::VerbId>(std::move(verb_id));
            auto* verb_ref = verb.value_if();
            if (!verb_ref)
                return mutation(view, core::Result<void, core::Diagnostics>::failure(verb.error()));
            std::vector<core::InteractionSubjectBinding> bindings;
            if (slot_bindings) {
                for (const auto& [slot, object] : *slot_bindings) {
                    if (slot.get_type() != sol::type::string ||
                        object.get_type() != sol::type::table)
                        return mutation(
                            view,
                            core::Result<void, core::Diagnostics>::failure(core::Diagnostics{
                                core::Diagnostic{.code = "runtime.invalid_interaction_binding",
                                                 .message = "Game.run_action bindings must map "
                                                            "named Verb slots to {kind, id} "
                                                            "subject tables"}}));
                    auto slot_id = parse_id<core::VerbSlotId>(slot.as<std::string>());
                    if (!slot_id)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(slot_id.error()));
                    auto parsed = interaction_subject(object.as<sol::table>());
                    if (!parsed)
                        return mutation(
                            view, core::Result<void, core::Diagnostics>::failure(parsed.error()));
                    bindings.push_back(core::InteractionSubjectBinding{
                        std::move(*slot_id.value_if()), std::move(*parsed.value_if())});
                }
            }
            return mutation(view, host->run_interaction(std::move(*verb_ref), std::move(bindings)));
        });
    game.set_function("save", [host](std::uint32_t slot, sol::this_state state) {
        return mutation(sol::state_view(state), host->save(core::TypedSaveSlotId::manual(slot)));
    });
    game.set_function("load", [host](std::uint32_t slot, sol::this_state state) {
        return mutation(sol::state_view(state), host->load(core::TypedSaveSlotId::manual(slot)));
    });
    game.set_function("autosave", [host](sol::this_state state) {
        return mutation(sol::state_view(state), host->autosave());
    });
    bind_runtime_capabilities(state, host);
}

void clear_typed_script_host(lua_State* state)
{
    sol::state_view lua(state);
    sol::table noveltea = lua["noveltea"].get_or_create<sol::table>();
    noveltea["project"] = sol::lua_nil;
    noveltea["properties"] = sol::lua_nil;
    noveltea["interactables"] = sol::lua_nil;
    noveltea["item_stacks"] = sol::lua_nil;
    noveltea["characters"] = sol::lua_nil;
    noveltea["navigation"] = sol::lua_nil;
    noveltea["flow"] = sol::lua_nil;
    noveltea["notify"] = sol::lua_nil;
    sol::table game = lua["Game"].get_or_create<sol::table>();
    game["prop"] = sol::lua_nil;
    game["set_prop"] = sol::lua_nil;
    game["unset_prop"] = sol::lua_nil;
    game["continue"] = sol::lua_nil;
    game["choose"] = sol::lua_nil;
    game["navigate"] = sol::lua_nil;
    game["select_object"] = sol::lua_nil;
    game["clear_selection"] = sol::lua_nil;
    game["run_action"] = sol::lua_nil;
    game["save"] = sol::lua_nil;
    game["load"] = sol::lua_nil;
    game["autosave"] = sol::lua_nil;
    clear_runtime_capabilities(state);
}

} // namespace noveltea::script
