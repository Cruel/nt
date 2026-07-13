#include "noveltea/core/property_resolver.hpp"

#include <algorithm>
#include <string>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics property_error(std::string code, const PropertyOwnerRef& owner,
                           const PropertyId& property, std::string message)
{
    const std::string owner_id = std::visit([](const auto& id) { return id.text(); }, owner);
    return Diagnostics{Diagnostic{.code = std::move(code),
                                  .message = "Property '" + property.text() + "' on owner '" +
                                             owner_id + "' " + std::move(message)}};
}

template<class Id, class Definition, class FindDefinition, class FindParent>
Result<PropertyLookupResult, Diagnostics>
resolve_chain(const CompiledProject& project, const SessionState& state, Id current,
              const PropertyId& property, const PropertyDefinition& declaration,
              const std::vector<Definition>& definitions, FindDefinition find_definition,
              FindParent find_parent)
{
    const PropertyOwnerRef requested_owner{current};
    for (std::size_t depth = 0; depth <= definitions.size(); ++depth) {
        const auto* definition = (project.*find_definition)(current);
        if (definition == nullptr)
            return Result<PropertyLookupResult, Diagnostics>::failure(
                property_error("runtime.unknown_property_owner", PropertyOwnerRef{current},
                               property, "does not identify a compiled definition"));

        const PropertyOwnerRef current_owner{current};
        if (const auto* value = state.property_override(current_owner, property))
            return Result<PropertyLookupResult, Diagnostics>::success(*value);

        const auto assignment = std::find_if(definition->identity.property_assignments.begin(),
                                             definition->identity.property_assignments.end(),
                                             [&property](const PropertyAssignment& value) {
                                                 return value.property_id() == property;
                                             });
        if (assignment != definition->identity.property_assignments.end())
            return Result<PropertyLookupResult, Diagnostics>::success(assignment->value());

        if (!definition->identity.extends)
            return Result<PropertyLookupResult, Diagnostics>::success(
                declaration.default_value()
                    ? PropertyLookupResult{*declaration.default_value()}
                    : PropertyLookupResult{MissingPropertyValue{requested_owner, property}});

        const auto parent_index = (project.*find_parent)(current);
        if (!parent_index || *parent_index >= definitions.size())
            return Result<PropertyLookupResult, Diagnostics>::failure(
                property_error("runtime.invalid_property_inheritance", current_owner, property,
                               "has an invalid retained parent index"));
        current = definitions[*parent_index].identity.id;
    }

    return Result<PropertyLookupResult, Diagnostics>::failure(
        property_error("runtime.invalid_property_inheritance", requested_owner, property,
                       "exceeded the bounded inheritance depth"));
}

} // namespace

Result<const PropertyDefinition*, Diagnostics>
PropertyResolver::validate(const PropertyOwnerRef& owner, const PropertyId& property) const
{
    const auto* declaration = m_project.find_property(property);
    if (declaration == nullptr)
        return Result<const PropertyDefinition*, Diagnostics>::failure(
            property_error("runtime.unknown_property", owner, property, "is not declared"));

    if (!std::binary_search(declaration->allowed_owners().begin(),
                            declaration->allowed_owners().end(), property_owner_kind(owner)))
        return Result<const PropertyDefinition*, Diagnostics>::failure(
            property_error("runtime.property_owner_not_allowed", owner, property,
                           "is not allowed on that owner kind"));

    if (!owner_exists(owner))
        return Result<const PropertyDefinition*, Diagnostics>::failure(
            property_error("runtime.unknown_property_owner", owner, property,
                           "does not identify a compiled definition"));

    return Result<const PropertyDefinition*, Diagnostics>::success(declaration);
}

bool PropertyResolver::owner_exists(const PropertyOwnerRef& owner) const noexcept
{
    return std::visit(
        [this](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>)
                return m_project.find_room(id) != nullptr;
            else if constexpr (std::is_same_v<T, SceneId>)
                return m_project.find_scene(id) != nullptr;
            else if constexpr (std::is_same_v<T, DialogueId>)
                return m_project.find_dialogue(id) != nullptr;
            else if constexpr (std::is_same_v<T, CharacterId>)
                return m_project.find_character(id) != nullptr;
            else if constexpr (std::is_same_v<T, InteractableId>)
                return m_project.find_interactable(id) != nullptr;
            else if constexpr (std::is_same_v<T, VerbId>)
                return m_project.find_verb(id) != nullptr;
            else if constexpr (std::is_same_v<T, InteractionId>)
                return m_project.find_interaction(id) != nullptr;
            else if constexpr (std::is_same_v<T, MapId>)
                return m_project.find_map(id) != nullptr;
        },
        owner);
}

Result<PropertyLookupResult, Diagnostics> PropertyResolver::get(const PropertyOwnerRef& owner,
                                                                const PropertyId& property) const
{
    const auto validated = validate(owner, property);
    if (!validated)
        return Result<PropertyLookupResult, Diagnostics>::failure(validated.error());
    const auto* declaration_value = validated.value_if();
    if (declaration_value == nullptr)
        return Result<PropertyLookupResult, Diagnostics>::failure(property_error(
            "runtime.invalid_property_state", owner, property, "lost its validated declaration"));
    const auto* declaration = *declaration_value;

    return std::visit(
        [this, &property,
         declaration](const auto& id) -> Result<PropertyLookupResult, Diagnostics> {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>)
                return resolve_chain(m_project, m_state, id, property, *declaration,
                                     m_project.rooms(), &CompiledProject::find_room,
                                     &CompiledProject::room_parent_index);
            else if constexpr (std::is_same_v<T, SceneId>)
                return resolve_chain(m_project, m_state, id, property, *declaration,
                                     m_project.scenes(), &CompiledProject::find_scene,
                                     &CompiledProject::scene_parent_index);
            else if constexpr (std::is_same_v<T, DialogueId>)
                return resolve_chain(m_project, m_state, id, property, *declaration,
                                     m_project.dialogues(), &CompiledProject::find_dialogue,
                                     &CompiledProject::dialogue_parent_index);
            else if constexpr (std::is_same_v<T, CharacterId>)
                return resolve_chain(m_project, m_state, id, property, *declaration,
                                     m_project.characters(), &CompiledProject::find_character,
                                     &CompiledProject::character_parent_index);
            else if constexpr (std::is_same_v<T, InteractableId>)
                return resolve_chain(m_project, m_state, id, property, *declaration,
                                     m_project.interactables(), &CompiledProject::find_interactable,
                                     &CompiledProject::interactable_parent_index);
            else if constexpr (std::is_same_v<T, VerbId>)
                return resolve_chain(m_project, m_state, id, property, *declaration,
                                     m_project.verbs(), &CompiledProject::find_verb,
                                     &CompiledProject::verb_parent_index);
            else if constexpr (std::is_same_v<T, InteractionId>)
                return resolve_chain(m_project, m_state, id, property, *declaration,
                                     m_project.interactions(), &CompiledProject::find_interaction,
                                     &CompiledProject::interaction_parent_index);
            else if constexpr (std::is_same_v<T, MapId>)
                return resolve_chain(m_project, m_state, id, property, *declaration,
                                     m_project.maps(), &CompiledProject::find_map,
                                     &CompiledProject::map_parent_index);
        },
        owner);
}

Result<void, Diagnostics> PropertyResolver::set(PropertyOwnerRef owner, const PropertyId& property,
                                                RuntimeValue value)
{
    const auto validated = validate(owner, property);
    if (!validated)
        return Result<void, Diagnostics>::failure(validated.error());
    const auto* declaration = validated.value_if();
    if (declaration == nullptr)
        return Result<void, Diagnostics>::failure(property_error(
            "runtime.invalid_property_state", owner, property, "lost its validated declaration"));
    auto override = make_property_override(std::move(owner), **declaration, std::move(value));
    if (!override)
        return Result<void, Diagnostics>::failure(override.error());
    auto* override_value = override.value_if();
    if (override_value == nullptr)
        return Result<void, Diagnostics>::failure(Diagnostics{
            Diagnostic{.code = "runtime.invalid_property_state",
                       .message = "A validated property override did not publish a value"}});
    m_state.store_property_override(std::move(*override_value));
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> PropertyResolver::unset(const PropertyOwnerRef& owner,
                                                  const PropertyId& property)
{
    const auto validated = validate(owner, property);
    if (!validated)
        return Result<void, Diagnostics>::failure(validated.error());
    m_state.erase_property_override(owner, property);
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
