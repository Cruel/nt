#include "../compiled_project_wire.hpp"

#include "noveltea/core/compiled_project_codec.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <type_traits>
#include <unordered_map>
#include <utility>

namespace noveltea::core {
namespace {

void append(Diagnostics& destination, const Diagnostics& source, std::string_view source_path,
            std::string json_pointer = {})
{
    for (const auto& diagnostic : source) {
        auto linked = diagnostic;
        if (linked.source_path.empty())
            linked.source_path = source_path;
        if (linked.json_pointer.empty())
            linked.json_pointer = json_pointer;
        destination.push_back(std::move(linked));
    }
}

template<class Id> std::optional<PropertyOwnerRef> exact_owner_for_id(const Id& id)
{
    if constexpr (std::is_same_v<Id, RoomId> || std::is_same_v<Id, CharacterId> ||
                  std::is_same_v<Id, InteractableInstanceId>)
        return PropertyOwnerRef{id};
    else
        return std::nullopt;
}

template<class Id>
const PropertyDefinition*
find_property_for_identity(const std::vector<PropertyDefinition>& all_properties,
                           const Id& owner_id, const PropertyId& property_id)
{
    const auto exact_owner = exact_owner_for_id(owner_id);
    if (!exact_owner)
        return nullptr;
    const auto found = std::find_if(
        all_properties.begin(), all_properties.end(), [&](const PropertyDefinition& property) {
            return property.id() == property_id && property.exact_owner() == exact_owner;
        });
    return found == all_properties.end() ? nullptr : &*found;
}

template<class Id>
std::optional<compiled::PropertyBearingDefinition<Id>>
link_identity(compiled::wire::PropertyBearingDefinition<Id> identity, PropertyOwnerKind owner,
              const std::vector<PropertyDefinition>& all_properties,
              const std::vector<compiled::OwnerPropertyContract>* owner_properties,
              const std::unordered_map<TraitId, const compiled::TraitDefinition*>& traits,
              Diagnostics& diagnostics, std::string_view source_path, const std::string& path)
{
    const auto diagnostics_before = diagnostics.size();
    std::vector<PropertyAssignment> assignments;
    assignments.reserve(identity.property_assignments.size());
    for (std::size_t index = 0; index < identity.property_assignments.size(); ++index) {
        auto& assignment = identity.property_assignments[index];
        const auto* definition =
            find_property_for_identity(all_properties, identity.id, assignment.property_id);
        std::optional<PropertyDefinition> local_definition;
        if (!definition && owner_properties) {
            const auto local = std::find_if(
                owner_properties->begin(), owner_properties->end(), [&](const auto& contract) {
                    return contract.property_id == assignment.property_id;
                });
            if (local != owner_properties->end()) {
                auto resolved = make_property_definition(PropertyDefinitionInput{
                    .id = local->property_id,
                    .value_type = local->value_type,
                    .nullable = local->nullable,
                    .default_value = local->configured_value,
                    .scope = PropertyScope::Identity,
                    .allowed_owners = {owner},
                    .label = local->label,
                    .description = local->description,
                });
                if (resolved)
                    local_definition = *resolved.value_if();
                if (local_definition)
                    definition = &*local_definition;
            }
        }
        if (!definition) {
            diagnostics.push_back(Diagnostic{
                .code = "compiled_project.unresolved_reference",
                .message = "Unresolved Property reference '" + assignment.property_id.text() + "'.",
                .severity = ErrorSeverity::Error,
                .source_path = std::string(source_path),
                .json_pointer =
                    path + "/propertyAssignments/" + std::to_string(index) + "/propertyId"});
            continue;
        }
        auto linked = make_property_assignment(owner, *definition, std::move(assignment.value));
        if (!linked) {
            append(diagnostics, linked.error(), source_path,
                   path + "/propertyAssignments/" + std::to_string(index));
            continue;
        }
        (void)linked.transform([&assignments](const PropertyAssignment& assignment) {
            assignments.push_back(assignment);
            return true;
        });
    }
    if (assignments.size() != identity.property_assignments.size())
        return std::nullopt;

    std::vector<TraitId> attachments;
    attachments.reserve(identity.traits.size());
    std::unordered_map<PropertyId, RuntimeValue> configured_values;
    std::unordered_map<PropertyId, const compiled::TraitProperty*> contributed_properties;
    for (std::size_t index = 0; index < identity.traits.size(); ++index) {
        auto& trait_id = identity.traits[index];
        const auto found = traits.find(trait_id);
        if (found == traits.end()) {
            diagnostics.push_back(
                Diagnostic{.code = "compiled_project.unresolved_reference",
                           .message = "Unresolved Trait reference '" + trait_id.text() + "'.",
                           .severity = ErrorSeverity::Error,
                           .source_path = std::string(source_path),
                           .json_pointer = path + "/traits/" + std::to_string(index)});
            continue;
        }
        const auto& trait = *found->second;
        if (std::find(trait.allowed_owners.begin(), trait.allowed_owners.end(), owner) ==
            trait.allowed_owners.end()) {
            diagnostics.push_back(Diagnostic{
                .code = "compiled_project.invalid_trait_attachment",
                .message = "Trait '" + trait_id.text() + "' cannot be attached to this owner kind.",
                .severity = ErrorSeverity::Error,
                .source_path = std::string(source_path),
                .json_pointer = path + "/traits/" + std::to_string(index)});
            continue;
        }
        for (const auto& member : trait.properties) {
            const auto [contributed, contributed_inserted] =
                contributed_properties.emplace(member.property_id, &member);
            if (!contributed_inserted) {
                const auto* previous = contributed->second;
                const bool compatible = previous->value_type.index() == member.value_type.index() &&
                                        previous->nullable == member.nullable &&
                                        previous->enum_values == member.enum_values;
                if (!compatible) {
                    diagnostics.push_back(Diagnostic{
                        .code = "compiled_project.invalid_trait_property",
                        .message =
                            "Attached Traits contribute incompatible schemas for Property '" +
                            member.property_id.text() + "'.",
                        .severity = ErrorSeverity::Error,
                        .source_path = std::string(source_path),
                        .json_pointer = path + "/traits/" + std::to_string(index)});
                }
            }
            if (!member.configured_value)
                continue;
            const auto [configured, inserted] =
                configured_values.emplace(member.property_id, *member.configured_value);
            if (!inserted && configured->second != *member.configured_value) {
                diagnostics.push_back(
                    Diagnostic{.code = "compiled_project.conflicting_trait_configuration",
                               .message = "Attached Traits configure Property '" +
                                          member.property_id.text() + "' with conflicting values.",
                               .severity = ErrorSeverity::Error,
                               .source_path = std::string(source_path),
                               .json_pointer = path + "/traits/" + std::to_string(index)});
            }
        }
        attachments.push_back(trait_id);
    }
    if (attachments.size() != identity.traits.size())
        return std::nullopt;

    if constexpr (std::is_same_v<Id, RoomId> || std::is_same_v<Id, CharacterId>) {
        for (const auto& trait_id : attachments) {
            const auto found = traits.find(trait_id);
            if (found == traits.end())
                return std::nullopt;
            const auto* trait = found->second;
            for (const auto& member : trait->properties) {
                if (member.configured_value)
                    continue;
                const auto own =
                    std::find_if(assignments.begin(), assignments.end(), [&](const auto& value) {
                        return value.property_id() == member.property_id;
                    });
                if (own == assignments.end() &&
                    configured_values.find(member.property_id) == configured_values.end()) {
                    diagnostics.push_back(Diagnostic{
                        .code = "compiled_project.missing_trait_requirement",
                        .message = "Trait '" + trait_id.text() + "' requires Property '" +
                                   member.property_id.text() + "' to have an authored value.",
                        .severity = ErrorSeverity::Error,
                        .source_path = std::string(source_path),
                        .json_pointer = path + "/traits"});
                }
            }
        }
    }
    if (diagnostics.size() != diagnostics_before)
        return std::nullopt;
    return compiled::PropertyBearingDefinition<Id>{std::move(identity.id), std::move(attachments),
                                                   std::move(assignments)};
}

std::optional<std::vector<compiled::OwnerPropertyContract>>
link_owner_property_contracts(std::vector<compiled::wire::OwnerPropertyContract> contracts,
                              PropertyOwnerKind owner, Diagnostics& diagnostics,
                              std::string_view source_path, const std::string& path)
{
    const auto before = diagnostics.size();
    std::vector<compiled::OwnerPropertyContract> result;
    result.reserve(contracts.size());
    for (std::size_t index = 0; index < contracts.size(); ++index) {
        auto& contract = contracts[index];
        auto validated = make_property_definition(PropertyDefinitionInput{
            .id = contract.property_id,
            .value_type = contract.value_type,
            .nullable = contract.nullable,
            .default_value = contract.configured_value,
            .scope = PropertyScope::Identity,
            .allowed_owners = {owner},
            .label = contract.label,
            .description = contract.description,
        });
        if (!validated) {
            append(diagnostics, validated.error(), source_path, path + "/" + std::to_string(index));
            continue;
        }
        result.push_back(compiled::OwnerPropertyContract{
            std::move(contract.property_id), std::move(contract.value_type), contract.nullable,
            std::move(contract.enum_values), std::move(contract.configured_value),
            std::move(contract.label), std::move(contract.description)});
    }
    return diagnostics.size() == before ? std::optional{std::move(result)} : std::nullopt;
}

Result<CompiledProject, Diagnostics> link(compiled::wire::SharedProject wire,
                                          std::string source_path)
{
    Diagnostics diagnostics;
    std::vector<PropertyDefinition> properties;
    properties.reserve(wire.properties.size());
    for (std::size_t index = 0; index < wire.properties.size(); ++index) {
        auto& declaration = wire.properties[index];
        auto linked = make_property_definition(PropertyDefinitionInput{
            .id = std::move(declaration.id),
            .value_type = std::move(declaration.value_type),
            .nullable = declaration.nullable,
            .default_value = std::move(declaration.default_value),
            .scope = declaration.scope,
            .allowed_owners = {},
            .exact_owner = std::move(declaration.exact_owner),
            .label = std::move(declaration.label),
            .description = std::move(declaration.description),
        });
        if (!linked) {
            append(diagnostics, linked.error(), source_path,
                   "/properties/" + std::to_string(index));
            continue;
        }
        (void)linked.transform([&properties](const PropertyDefinition& property) {
            properties.push_back(property);
            return true;
        });
    }
    if (properties.size() != wire.properties.size())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

    std::vector<compiled::TraitDefinition> traits;
    traits.reserve(wire.traits.size());
    for (std::size_t index = 0; index < wire.traits.size(); ++index) {
        auto& declaration = wire.traits[index];
        const auto diagnostic_count = diagnostics.size();
        std::vector<compiled::TraitProperty> members;
        members.reserve(declaration.properties.size());
        for (std::size_t member_index = 0; member_index < declaration.properties.size();
             ++member_index) {
            auto& member = declaration.properties[member_index];
            const auto member_path =
                "/traits/" + std::to_string(index) + "/properties/" + std::to_string(member_index);
            auto contract = make_property_definition(PropertyDefinitionInput{
                .id = member.property_id,
                .value_type = member.value_type,
                .nullable = member.nullable,
                .default_value = member.configured_value,
                .scope = PropertyScope::Identity,
                .allowed_owners = declaration.allowed_owners,
                .label = member.label,
                .description = member.description,
            });
            if (!contract) {
                diagnostics.push_back(
                    Diagnostic{.code = "compiled_project.invalid_trait_property",
                               .message = "Trait Property '" + member.property_id.text() +
                                          "' has an invalid typed contract or Default.",
                               .severity = ErrorSeverity::Error,
                               .source_path = source_path,
                               .json_pointer = member_path});
                continue;
            }
            members.push_back(compiled::TraitProperty{
                std::move(member.property_id), std::move(member.value_type), member.nullable,
                std::move(member.enum_values), std::move(member.configured_value),
                std::move(member.label), std::move(member.description)});
        }
        if (diagnostics.size() != diagnostic_count)
            continue;
        std::sort(declaration.allowed_owners.begin(), declaration.allowed_owners.end());
        traits.push_back(
            compiled::TraitDefinition{std::move(declaration.id), std::move(declaration.label),
                                      std::move(declaration.description),
                                      std::move(declaration.allowed_owners), std::move(members)});
    }
    if (traits.size() != wire.traits.size())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

    std::unordered_map<TraitId, const compiled::TraitDefinition*> trait_index;
    trait_index.reserve(traits.size());
    for (const auto& trait : traits)
        trait_index.emplace(trait.id, &trait);

    auto link_features = [&](std::vector<compiled::wire::FeatureDefinition> values,
                             const std::string& path) {
        std::vector<compiled::FeatureDefinition> linked;
        linked.reserve(values.size());
        for (std::size_t index = 0; index < values.size(); ++index) {
            auto& value = values[index];
            const auto feature_path = path + "/" + std::to_string(index);
            auto property_contracts = link_owner_property_contracts(
                std::move(value.properties), PropertyOwnerKind::Feature, diagnostics, source_path,
                feature_path + "/properties");
            if (!property_contracts)
                continue;
            auto identity = link_identity(std::move(value.identity), PropertyOwnerKind::Feature,
                                          properties, &*property_contracts, trait_index,
                                          diagnostics, source_path, feature_path);
            if (!identity)
                continue;
            linked.push_back(compiled::FeatureDefinition{
                std::move(*identity), std::move(value.label), std::move(*property_contracts),
                std::move(value.inventories)});
        }
        return linked;
    };

#define LINK_DEFINITIONS(wire_member, output_member, output_type, id_type, body)                   \
    std::vector<compiled::output_type> output_member;                                              \
    output_member.reserve(wire.wire_member.size());                                                \
    for (auto& value : wire.wire_member) {                                                         \
        compiled::DefinitionIdentity<id_type> identity{std::move(value.identity.id)};              \
        output_member.push_back(body);                                                             \
    }

    std::vector<compiled::CharacterDefinition> characters;
    characters.reserve(wire.characters.size());
    for (std::size_t index = 0; index < wire.characters.size(); ++index) {
        auto& value = wire.characters[index];
        const auto path = "/definitions/characters/" + std::to_string(index);
        auto property_contracts =
            link_owner_property_contracts(std::move(value.properties), PropertyOwnerKind::Character,
                                          diagnostics, source_path, path + "/properties");
        if (!property_contracts)
            continue;
        auto identity =
            link_identity(std::move(value.identity), PropertyOwnerKind::Character, properties,
                          &*property_contracts, trait_index, diagnostics, source_path, path);
        if (!identity)
            continue;
        characters.push_back(compiled::CharacterDefinition{
            std::move(*identity), std::move(value.display_name), std::move(*property_contracts),
            std::move(value.dialogue), std::move(value.defaults), std::move(value.profiles),
            std::move(value.expressions), std::move(value.appearances), std::move(value.gestures),
            std::move(value.idles), std::move(value.inventories),
            std::move(value.initial_world_state)});
    }

    std::vector<compiled::RoomDefinition> rooms;
    rooms.reserve(wire.rooms.size());
    for (std::size_t index = 0; index < wire.rooms.size(); ++index) {
        auto& value = wire.rooms[index];
        const auto path = "/definitions/rooms/" + std::to_string(index);
        auto property_contracts =
            link_owner_property_contracts(std::move(value.properties), PropertyOwnerKind::Room,
                                          diagnostics, source_path, path + "/properties");
        if (!property_contracts)
            continue;
        auto identity =
            link_identity(std::move(value.identity), PropertyOwnerKind::Room, properties,
                          &*property_contracts, trait_index, diagnostics, source_path, path);
        if (!identity)
            continue;
        rooms.push_back(compiled::RoomDefinition{
            std::move(*identity), std::move(value.display_name), std::move(*property_contracts),
            std::move(value.description), std::move(value.background),
            std::move(value.presentation_space), std::move(value.anchors),
            compiled::RoomLifecycle{std::move(value.lifecycle.can_enter),
                                    std::move(value.lifecycle.can_leave)},
            std::move(value.overlays), std::move(value.cast), std::move(value.interactables),
            std::move(value.props), std::move(value.environments), std::move(value.script_hooks),
            std::move(value.placements), std::move(value.exits),
            link_features(std::move(value.features), path + "/features"),
            std::move(value.hotspots)});
    }

    std::vector<compiled::InteractableDefinition> interactables;
    interactables.reserve(wire.interactables.size());
    for (std::size_t index = 0; index < wire.interactables.size(); ++index) {
        auto& value = wire.interactables[index];
        const auto path = "/definitions/interactables/" + std::to_string(index);
        auto property_contracts = link_owner_property_contracts(
            std::move(value.properties), PropertyOwnerKind::Interactable, diagnostics, source_path,
            path + "/properties");
        if (!property_contracts)
            continue;
        auto identity =
            link_identity(std::move(value.identity), PropertyOwnerKind::Interactable, properties,
                          &*property_contracts, trait_index, diagnostics, source_path, path);
        if (!identity)
            continue;
        interactables.push_back(compiled::InteractableDefinition{
            std::move(*identity), std::move(value.display_name), value.stackable,
            std::move(value.stack_limit), std::move(*property_contracts),
            link_features(std::move(value.features), path + "/features"),
            std::move(value.inventories), std::move(value.presentation)});
    }

    std::vector<compiled::InteractableInstanceDeclaration> interactable_instances;
    interactable_instances.reserve(wire.interactable_instances.size());
    for (std::size_t index = 0; index < wire.interactable_instances.size(); ++index) {
        auto& value = wire.interactable_instances[index];
        std::vector<PropertyAssignment> property_overrides;
        property_overrides.reserve(value.property_overrides.size());
        for (std::size_t assignment_index = 0; assignment_index < value.property_overrides.size();
             ++assignment_index) {
            auto& assignment = value.property_overrides[assignment_index];
            const auto* definition =
                find_property_for_identity(properties, value.id, assignment.property_id);
            const auto path = "/interactableInstances/" + std::to_string(index) +
                              "/propertyOverrides/" + std::to_string(assignment_index);
            if (definition == nullptr) {
                diagnostics.push_back(Diagnostic{.code = "compiled_project.unresolved_reference",
                                                 .message = "Unresolved Property reference '" +
                                                            assignment.property_id.text() + "'.",
                                                 .severity = ErrorSeverity::Error,
                                                 .source_path = std::string(source_path),
                                                 .json_pointer = path + "/propertyId"});
                continue;
            }
            auto linked = make_property_assignment(PropertyOwnerKind::Interactable, *definition,
                                                   std::move(assignment.value));
            if (!linked) {
                append(diagnostics, linked.error(), source_path, path);
                continue;
            }
            (void)linked.transform([&property_overrides](const PropertyAssignment& assignment) {
                property_overrides.push_back(assignment);
                return true;
            });
        }
        if (property_overrides.size() != value.property_overrides.size())
            continue;
        std::vector<compiled::InstanceLocalProperty> local_properties;
        local_properties.reserve(value.local_properties.size());
        for (std::size_t property_index_value = 0;
             property_index_value < value.local_properties.size(); ++property_index_value) {
            auto& local = value.local_properties[property_index_value];
            auto exact = make_property_definition(PropertyDefinitionInput{
                .id = local.contract.property_id,
                .value_type = local.contract.value_type,
                .nullable = local.contract.nullable,
                .default_value = std::nullopt,
                .scope = PropertyScope::Identity,
                .allowed_owners = {},
                .exact_owner = PropertyOwnerRef{value.id},
                .label = local.contract.label,
                .description = local.contract.description,
            });
            const auto path = "/interactableInstances/" + std::to_string(index) +
                              "/localProperties/" + std::to_string(property_index_value);
            if (!exact || !property_value_matches(*exact.value_if(), local.value)) {
                diagnostics.push_back(
                    Diagnostic{.code = "compiled_project.invalid_interactable_property",
                               .message = "Instance-local Property has an invalid typed Value.",
                               .severity = ErrorSeverity::Error,
                               .source_path = source_path,
                               .json_pointer = path});
                continue;
            }
            local_properties.push_back(compiled::InstanceLocalProperty{
                compiled::OwnerPropertyContract{
                    std::move(local.contract.property_id), std::move(local.contract.value_type),
                    local.contract.nullable, std::move(local.contract.enum_values), std::nullopt,
                    std::move(local.contract.label), std::move(local.contract.description)},
                std::move(local.value)});
        }
        if (local_properties.size() != value.local_properties.size())
            continue;
        interactable_instances.push_back(compiled::InteractableInstanceDeclaration{
            std::move(value.id), std::move(value.definition), std::move(value.location),
            value.enabled, value.visible, value.quantity, std::move(value.trait_adds),
            std::move(value.trait_removes), std::move(property_overrides),
            std::move(local_properties)});
    }

    std::vector<compiled::ArchetypeDefinition> archetypes;
    archetypes.reserve(wire.archetypes.size());
    for (std::size_t index = 0; index < wire.archetypes.size(); ++index) {
        auto& archetype = wire.archetypes[index];
        const auto path = "/archetypes/" + std::to_string(index) + "/configuration";
        std::optional<compiled::ArchetypeConfiguration> configuration;
        if (auto* room = std::get_if<compiled::wire::RoomDefinition>(&archetype.configuration)) {
            auto property_contracts =
                link_owner_property_contracts(std::move(room->properties), PropertyOwnerKind::Room,
                                              diagnostics, source_path, path + "/properties");
            auto identity = property_contracts
                                ? link_identity(std::move(room->identity), PropertyOwnerKind::Room,
                                                properties, &*property_contracts, trait_index,
                                                diagnostics, source_path, path)
                                : std::nullopt;
            if (identity && property_contracts)
                configuration = compiled::RoomDefinition{
                    std::move(*identity),
                    std::move(room->display_name),
                    std::move(*property_contracts),
                    std::move(room->description),
                    std::move(room->background),
                    std::move(room->presentation_space),
                    std::move(room->anchors),
                    compiled::RoomLifecycle{std::move(room->lifecycle.can_enter),
                                            std::move(room->lifecycle.can_leave)},
                    std::move(room->overlays),
                    std::move(room->cast),
                    std::move(room->interactables),
                    std::move(room->props),
                    std::move(room->environments),
                    std::move(room->script_hooks),
                    std::move(room->placements),
                    std::move(room->exits),
                    link_features(std::move(room->features), path + "/features"),
                    std::move(room->hotspots)};
        } else if (auto* character =
                       std::get_if<compiled::wire::CharacterDefinition>(&archetype.configuration)) {
            auto property_contracts = link_owner_property_contracts(
                std::move(character->properties), PropertyOwnerKind::Character, diagnostics,
                source_path, path + "/properties");
            auto identity =
                property_contracts
                    ? link_identity(std::move(character->identity), PropertyOwnerKind::Character,
                                    properties, &*property_contracts, trait_index, diagnostics,
                                    source_path, path)
                    : std::nullopt;
            if (identity && property_contracts)
                configuration =
                    compiled::CharacterDefinition{std::move(*identity),
                                                  std::move(character->display_name),
                                                  std::move(*property_contracts),
                                                  std::move(character->dialogue),
                                                  std::move(character->defaults),
                                                  std::move(character->profiles),
                                                  std::move(character->expressions),
                                                  std::move(character->appearances),
                                                  std::move(character->gestures),
                                                  std::move(character->idles),
                                                  std::move(character->inventories),
                                                  std::move(character->initial_world_state)};
        } else if (auto* interactable = std::get_if<compiled::wire::InteractableDefinition>(
                       &archetype.configuration)) {
            auto property_contracts = link_owner_property_contracts(
                std::move(interactable->properties), PropertyOwnerKind::Interactable, diagnostics,
                source_path, path + "/properties");
            auto identity = property_contracts
                                ? link_identity(std::move(interactable->identity),
                                                PropertyOwnerKind::Interactable, properties,
                                                &*property_contracts, trait_index, diagnostics,
                                                source_path, path)
                                : std::nullopt;
            if (identity && property_contracts)
                configuration = compiled::InteractableDefinition{
                    std::move(*identity),
                    std::move(interactable->display_name),
                    interactable->stackable,
                    std::move(interactable->stack_limit),
                    std::move(*property_contracts),
                    link_features(std::move(interactable->features), path + "/features"),
                    std::move(interactable->inventories),
                    std::move(interactable->presentation)};
        }
        if (configuration)
            archetypes.push_back(compiled::ArchetypeDefinition{
                std::move(archetype.id), archetype.kind, std::move(*configuration)});
    }
    LINK_DEFINITIONS(verbs, verbs, VerbDefinition, VerbId,
                     (compiled::VerbDefinition{
                         std::move(identity), std::move(value.action_text),
                         std::move(value.completed_command_text), std::move(value.slots),
                         std::move(value.binding_order), std::move(value.offers),
                         std::move(value.availability), std::move(value.default_program)}));
    LINK_DEFINITIONS(
        interactions, interactions, InteractionDefinition, InteractionId,
        (compiled::InteractionDefinition{std::move(identity), std::move(value.rules)}));
    LINK_DEFINITIONS(scenes, scenes, SceneDefinition, SceneId,
                     (compiled::SceneDefinition{std::move(identity), std::move(value.display_name),
                                                std::move(value.stage), std::move(value.inputs),
                                                std::move(value.outcomes), std::move(value.program),
                                                std::move(value.terminal)}));
    LINK_DEFINITIONS(
        dialogues, dialogues, DialogueDefinition, DialogueId,
        (compiled::DialogueDefinition{
            std::move(identity), std::move(value.display_name), std::move(value.default_speaker),
            std::move(value.stage_slots), std::move(value.media_slots), std::move(value.program),
            std::move(value.settings), std::move(value.completion)}));
    LINK_DEFINITIONS(
        maps, maps, MapDefinition, MapId,
        (compiled::MapDefinition{std::move(identity), std::move(value.connections),
                                 std::move(value.locations), std::move(value.presentation)}));
#undef LINK_DEFINITIONS
    if (!diagnostics.empty())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

    auto result = CompiledProject::create(compiled::CompiledProjectInput{
        .identity = std::move(wire.identity),
        .settings = std::move(wire.settings),
        .entrypoint = std::move(wire.entrypoint),
        .bootstrap_module = std::move(wire.bootstrap_module),
        .save_contract = std::move(wire.save_contract),
        .localization = std::move(wire.localization),
        .properties = std::move(properties),
        .traits = std::move(traits),
        .archetypes = std::move(archetypes),
        .inventories = std::move(wire.inventories),
        .assets = std::move(wire.assets),
        .layouts = std::move(wire.layouts),
        .material_interfaces = std::move(wire.material_interfaces),
        .scripts = std::move(wire.scripts),
        .characters = std::move(characters),
        .rooms = std::move(rooms),
        .interactables = std::move(interactables),
        .interactable_instances = std::move(interactable_instances),
        .verbs = std::move(verbs),
        .interactions = std::move(interactions),
        .undefined_interaction_program = std::move(wire.undefined_interaction_program),
        .scenes = std::move(scenes),
        .dialogues = std::move(dialogues),
        .maps = std::move(maps),
    });
    if (result)
        return result;
    append(diagnostics, result.error(), source_path);
    return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));
}

} // namespace

Result<CompiledProject, Diagnostics> decode_compiled_project(const nlohmann::json& document,
                                                             std::string source_path)
{
    auto decoded = compiled::wire::decode_shared_project(document, source_path);
    if (!decoded)
        return Result<CompiledProject, Diagnostics>::failure(decoded.error());
    std::optional<compiled::wire::SharedProject> wire;
    (void)decoded.transform([&wire](const compiled::wire::SharedProject& project) {
        wire = project;
        return true;
    });
    return link(std::move(*wire), std::move(source_path));
}

} // namespace noveltea::core
