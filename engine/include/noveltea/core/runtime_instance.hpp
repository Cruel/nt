#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <algorithm>
#include <optional>
#include <variant>

namespace noveltea::core {

struct CompiledRoomConfigurationSource {
    RoomId room;
    auto operator<=>(const CompiledRoomConfigurationSource&) const = default;
};
struct CompiledCharacterConfigurationSource {
    CharacterId character;
    auto operator<=>(const CompiledCharacterConfigurationSource&) const = default;
};
struct CompiledInteractableConfigurationSource {
    InteractableDefinitionId definition;
    auto operator<=>(const CompiledInteractableConfigurationSource&) const = default;
};
struct ArchetypeConfigurationSource {
    ArchetypeId archetype;
    auto operator<=>(const ArchetypeConfigurationSource&) const = default;
};
using RuntimeConfigurationSource =
    std::variant<CompiledRoomConfigurationSource, CompiledCharacterConfigurationSource,
                 CompiledInteractableConfigurationSource, ArchetypeConfigurationSource>;

using GameplayInstanceRef = std::variant<RoomId, CharacterId, InteractableInstanceId>;

enum class RuntimeInstanceProvenanceKind : std::uint8_t {
    Declared,
    Archetype,
    CompiledDefinition,
    Clone,
};

struct RuntimeInstanceProvenance {
    RuntimeInstanceProvenanceKind kind = RuntimeInstanceProvenanceKind::Declared;
    std::optional<ArchetypeId> archetype;
    std::optional<GameplayInstanceRef> source_instance;
    bool operator==(const RuntimeInstanceProvenance&) const = default;
};

template<class Id, class Definition> struct RuntimeInstanceConfiguration {
    Id id;
    bool declared = false;
    RuntimeConfigurationSource birth_source;
    std::optional<RuntimeConfigurationSource> structural_override_source;
    RuntimeInstanceProvenance provenance;
    Definition birth_configuration;
    std::optional<Definition> structural_override;

    [[nodiscard]] const Definition& effective_configuration() const noexcept
    {
        return structural_override ? *structural_override : birth_configuration;
    }
};

struct RuntimeRoomExitTargetOverride {
    RoomExitId exit;
    RoomId target;
    bool operator==(const RuntimeRoomExitTargetOverride&) const = default;
};

struct RuntimeRoomConfiguration {
    RoomId id;
    bool declared = false;
    RuntimeConfigurationSource birth_source;
    std::optional<RuntimeConfigurationSource> structural_override_source;
    RuntimeInstanceProvenance provenance;
    compiled::RoomDefinition birth_configuration;
    std::optional<compiled::RoomDefinition> structural_override;
    std::vector<RuntimeRoomExitTargetOverride> birth_exit_target_overrides;
    std::vector<RuntimeRoomExitTargetOverride> structural_override_exit_target_overrides;
    std::vector<RuntimeRoomExitTargetOverride> exit_target_overrides;

    [[nodiscard]] const compiled::RoomDefinition& effective_configuration() const noexcept
    {
        return structural_override ? *structural_override : birth_configuration;
    }
};
using RuntimeCharacterConfiguration =
    RuntimeInstanceConfiguration<CharacterId, compiled::CharacterDefinition>;
using RuntimeInteractableConfiguration =
    RuntimeInstanceConfiguration<InteractableInstanceId, compiled::InteractableDefinition>;

[[nodiscard]] inline compiled::InteractableDefinition realize_declared_interactable_configuration(
    const compiled::InteractableDefinition& definition,
    const compiled::InteractableInstanceDeclaration& declaration)
{
    auto effective = definition;
    auto& traits = effective.identity.traits;
    for (const auto& removed : declaration.trait_removes)
        std::erase(traits, removed);
    for (const auto& added : declaration.trait_adds)
        if (std::find(traits.begin(), traits.end(), added) == traits.end())
            traits.push_back(added);
    std::ranges::sort(traits, {}, [](const auto& id) { return id.text(); });

    auto& assignments = effective.identity.property_assignments;
    for (const auto& local : declaration.local_properties) {
        const auto contract = std::find_if(
            effective.properties.begin(), effective.properties.end(),
            [&](const auto& value) { return value.property_id == local.contract.property_id; });
        if (contract == effective.properties.end())
            effective.properties.push_back(local.contract);
        const auto assignment =
            std::find_if(assignments.begin(), assignments.end(), [&](const auto& value) {
                return value.property_id() == local.contract.property_id;
            });
        auto local_value = make_property_definition(PropertyDefinitionInput{
            .id = local.contract.property_id,
            .value_type = local.contract.value_type,
            .nullable = local.contract.nullable,
            .default_value = std::nullopt,
            .scope = PropertyScope::Identity,
            .allowed_owners = {PropertyOwnerKind::Interactable},
            .exact_owner = std::nullopt,
            .label = local.contract.label,
            .description = local.contract.description,
        });
        if (!local_value)
            continue;
        auto value = make_property_assignment(PropertyOwnerKind::Interactable,
                                              *local_value.value_if(), local.value);
        if (!value)
            continue;
        if (assignment == assignments.end())
            assignments.push_back(*value.value_if());
        else
            *assignment = *value.value_if();
    }
    for (const auto& override : declaration.property_overrides) {
        const auto found =
            std::find_if(assignments.begin(), assignments.end(), [&](const auto& value) {
                return value.property_id() == override.property_id();
            });
        if (found == assignments.end())
            assignments.push_back(override);
        else
            *found = override;
    }
    std::ranges::sort(assignments, {},
                      [](const auto& value) { return value.property_id().text(); });

    for (const auto& override : declaration.feature_overrides) {
        const auto feature = std::ranges::find_if(
            effective.features, [&](const compiled::FeatureDefinition& candidate) {
                return candidate.identity.id == override.feature_id;
            });
        if (feature == effective.features.end())
            continue;
        auto& feature_traits = feature->identity.traits;
        for (const auto& removed : override.trait_removes)
            std::erase(feature_traits, removed);
        for (const auto& added : override.trait_adds)
            if (std::find(feature_traits.begin(), feature_traits.end(), added) ==
                feature_traits.end())
                feature_traits.push_back(added);
        std::ranges::sort(feature_traits, {}, [](const auto& id) { return id.text(); });

        auto& feature_assignments = feature->identity.property_assignments;
        for (const auto& property_override : override.property_overrides) {
            const auto found = std::find_if(
                feature_assignments.begin(), feature_assignments.end(), [&](const auto& value) {
                    return value.property_id() == property_override.property_id();
                });
            if (found == feature_assignments.end())
                feature_assignments.push_back(property_override);
            else
                *found = property_override;
        }
        std::ranges::sort(feature_assignments, {},
                          [](const auto& value) { return value.property_id().text(); });
    }
    return effective;
}

} // namespace noveltea::core
