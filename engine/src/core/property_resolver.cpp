#include "noveltea/core/property_resolver.hpp"

#include <algorithm>
#include <string>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

std::string property_target_text(const PropertyTargetRef& target)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, GlobalPropertyTarget>)
                return std::string{"global"};
            else
                return value.text();
        },
        target);
}

Diagnostics property_error(std::string code, const PropertyTargetRef& target,
                           const PropertyId& property, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code),
                                  .message = "Property '" + property.text() + "' on target '" +
                                             property_target_text(target) + "' " +
                                             std::move(message)}};
}

Diagnostics property_error(std::string code, const PropertyOwnerRef& owner,
                           const PropertyId& property, std::string message)
{
    return property_error(std::move(code), property_target(owner), property, std::move(message));
}

template<class Id, class FindDefinition>
Result<PropertyLookupResult, Diagnostics>
resolve_definition(const CompiledProject& project, const SessionState& state, const Id& id,
                   const PropertyId& property, const PropertyDefinition& declaration,
                   FindDefinition find_definition)
{
    const PropertyTargetRef target{id};
    const auto* definition = (project.*find_definition)(id);
    if (definition == nullptr)
        return Result<PropertyLookupResult, Diagnostics>::failure(
            property_error("runtime.unknown_property_owner", target, property,
                           "does not identify a compiled definition"));

    if (const auto* value = state.property_override(target, property))
        return Result<PropertyLookupResult, Diagnostics>::success(*value);

    const auto assignment = std::find_if(
        definition->identity.property_assignments.begin(),
        definition->identity.property_assignments.end(),
        [&property](const PropertyAssignment& value) { return value.property_id() == property; });
    if (assignment != definition->identity.property_assignments.end())
        return Result<PropertyLookupResult, Diagnostics>::success(assignment->value());

    for (const auto& trait_id : definition->identity.traits) {
        const auto* trait = project.find_trait(trait_id);
        if (trait == nullptr)
            return Result<PropertyLookupResult, Diagnostics>::failure(
                property_error("runtime.invalid_trait_attachment", target, property,
                               "references a missing compiled Trait"));
        const auto configured = std::find_if(trait->properties.begin(), trait->properties.end(),
                                             [&](const compiled::TraitProperty& member) {
                                                 return member.property_id == property &&
                                                        member.configured_value.has_value();
                                             });
        if (configured != trait->properties.end())
            return Result<PropertyLookupResult, Diagnostics>::success(
                *configured->configured_value);
    }

    return Result<PropertyLookupResult, Diagnostics>::success(
        declaration.default_value() ? PropertyLookupResult{*declaration.default_value()}
                                    : PropertyLookupResult{MissingPropertyValue{target, property}});
}

} // namespace

Result<const PropertyDefinition*, Diagnostics>
PropertyResolver::validate_global(const PropertyId& property) const
{
    const PropertyTargetRef target{GlobalPropertyTarget{}};
    const auto* declaration = m_project.find_property(property);
    if (declaration == nullptr)
        return Result<const PropertyDefinition*, Diagnostics>::failure(
            property_error("runtime.unknown_property", target, property, "is not declared"));
    if (!declaration->is_global())
        return Result<const PropertyDefinition*, Diagnostics>::failure(property_error(
            "runtime.property_scope_mismatch", target, property, "is not a Global Property"));
    return Result<const PropertyDefinition*, Diagnostics>::success(declaration);
}

Result<const PropertyDefinition*, Diagnostics>
PropertyResolver::validate_identity(const PropertyOwnerRef& owner, const PropertyId& property) const
{
    const auto* declaration = m_project.find_property(property);
    if (declaration == nullptr)
        return Result<const PropertyDefinition*, Diagnostics>::failure(
            property_error("runtime.unknown_property", owner, property, "is not declared"));

    if (declaration->is_global())
        return Result<const PropertyDefinition*, Diagnostics>::failure(
            property_error("runtime.property_scope_mismatch", owner, property,
                           "is Global and cannot be read through an identity"));

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

Result<PropertyLookupResult, Diagnostics>
PropertyResolver::get_global(const PropertyId& property) const
{
    const auto validated = validate_global(property);
    if (!validated)
        return Result<PropertyLookupResult, Diagnostics>::failure(validated.error());
    const auto* declaration_value = validated.value_if();
    if (declaration_value == nullptr)
        return Result<PropertyLookupResult, Diagnostics>::failure(property_error(
            "runtime.invalid_property_state", PropertyTargetRef{GlobalPropertyTarget{}}, property,
            "lost its validated declaration"));
    const auto* declaration = *declaration_value;
    const PropertyTargetRef target{GlobalPropertyTarget{}};
    if (const auto* value = m_state.property_override(target, property))
        return Result<PropertyLookupResult, Diagnostics>::success(*value);
    if (!declaration->default_value())
        return Result<PropertyLookupResult, Diagnostics>::failure(property_error(
            "runtime.invalid_property_state", target, property, "has no authored global default"));
    return Result<PropertyLookupResult, Diagnostics>::success(*declaration->default_value());
}

Result<void, Diagnostics> PropertyResolver::set_global(const PropertyId& property,
                                                       RuntimeValue value)
{
    const auto validated = validate_global(property);
    if (!validated)
        return Result<void, Diagnostics>::failure(validated.error());
    const auto* declaration = validated.value_if();
    if (declaration == nullptr)
        return Result<void, Diagnostics>::failure(property_error(
            "runtime.invalid_property_state", PropertyTargetRef{GlobalPropertyTarget{}}, property,
            "lost its validated declaration"));
    auto override = make_property_override(PropertyTargetRef{GlobalPropertyTarget{}}, **declaration,
                                           std::move(value));
    if (!override)
        return Result<void, Diagnostics>::failure(override.error());
    m_state.store_property_override(std::move(*override.value_if()));
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> PropertyResolver::unset_global(const PropertyId& property)
{
    const auto validated = validate_global(property);
    if (!validated)
        return Result<void, Diagnostics>::failure(validated.error());
    m_state.erase_property_override(PropertyTargetRef{GlobalPropertyTarget{}}, property);
    return Result<void, Diagnostics>::success();
}

Result<PropertyLookupResult, Diagnostics> PropertyResolver::get(const PropertyOwnerRef& owner,
                                                                const PropertyId& property) const
{
    const auto validated = validate_identity(owner, property);
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
                return resolve_definition(m_project, m_state, id, property, *declaration,
                                          &CompiledProject::find_room);
            else if constexpr (std::is_same_v<T, SceneId>)
                return resolve_definition(m_project, m_state, id, property, *declaration,
                                          &CompiledProject::find_scene);
            else if constexpr (std::is_same_v<T, DialogueId>)
                return resolve_definition(m_project, m_state, id, property, *declaration,
                                          &CompiledProject::find_dialogue);
            else if constexpr (std::is_same_v<T, CharacterId>)
                return resolve_definition(m_project, m_state, id, property, *declaration,
                                          &CompiledProject::find_character);
            else if constexpr (std::is_same_v<T, InteractableId>)
                return resolve_definition(m_project, m_state, id, property, *declaration,
                                          &CompiledProject::find_interactable);
            else if constexpr (std::is_same_v<T, VerbId>)
                return resolve_definition(m_project, m_state, id, property, *declaration,
                                          &CompiledProject::find_verb);
            else if constexpr (std::is_same_v<T, InteractionId>)
                return resolve_definition(m_project, m_state, id, property, *declaration,
                                          &CompiledProject::find_interaction);
            else if constexpr (std::is_same_v<T, MapId>)
                return resolve_definition(m_project, m_state, id, property, *declaration,
                                          &CompiledProject::find_map);
        },
        owner);
}

Result<void, Diagnostics> PropertyResolver::set(PropertyOwnerRef owner, const PropertyId& property,
                                                RuntimeValue value)
{
    const auto validated = validate_identity(owner, property);
    if (!validated)
        return Result<void, Diagnostics>::failure(validated.error());
    const auto* declaration = validated.value_if();
    if (declaration == nullptr)
        return Result<void, Diagnostics>::failure(property_error(
            "runtime.invalid_property_state", owner, property, "lost its validated declaration"));
    auto override = make_property_override(property_target(owner), **declaration, std::move(value));
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
    const auto validated = validate_identity(owner, property);
    if (!validated)
        return Result<void, Diagnostics>::failure(validated.error());
    m_state.erase_property_override(property_target(owner), property);
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
