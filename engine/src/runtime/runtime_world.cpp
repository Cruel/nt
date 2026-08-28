#include "noveltea/runtime/runtime_world.hpp"

#include "noveltea/core/property_resolver.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <utility>

namespace noveltea::runtime {
namespace {

core::Diagnostics world_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

core::Result<void, core::Diagnostics>
validate_override_against_contract(const core::PropertyOwnerRef& owner,
                                   const core::PropertyOverride& override,
                                   const core::compiled::OwnerPropertyContract& contract)
{
    auto declaration = core::make_property_definition(core::PropertyDefinitionInput{
        .id = contract.property_id,
        .value_type = contract.value_type,
        .nullable = contract.nullable,
        .default_value = contract.configured_value,
        .scope = core::PropertyScope::Identity,
        .allowed_owners = {},
        .exact_owner = owner,
        .label = contract.label,
        .description = contract.description,
    });
    if (!declaration || !core::make_property_override(override.target(), *declaration.value_if(),
                                                      override.override_value()))
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.invalid_structural_edit",
            "Structural configuration would introduce a Property schema incompatible with live "
            "dynamic Property state"));
    return core::Result<void, core::Diagnostics>::success();
}

template<class Id>
const core::compiled::OwnerPropertyContract* find_configuration_property_contract(
    const core::CompiledProject& project,
    const core::compiled::PropertyBearingDefinition<Id>& identity,
    const std::vector<core::compiled::OwnerPropertyContract>& properties,
    const core::PropertyId& property)
{
    const auto own = std::ranges::find_if(
        properties, [&](const auto& value) { return value.property_id == property; });
    if (own != properties.end())
        return &*own;
    for (const auto& trait_id : identity.traits) {
        const auto* trait = project.find_trait(trait_id);
        if (trait == nullptr)
            continue;
        const auto member = std::ranges::find_if(
            trait->properties, [&](const auto& value) { return value.property_id == property; });
        if (member != trait->properties.end())
            return &*member;
    }
    return nullptr;
}

template<class Id>
core::Result<void, core::Diagnostics> validate_configuration_property_overrides(
    const core::CompiledProject& project, const std::vector<core::PropertyOverride>& overrides,
    const core::PropertyOwnerRef& owner,
    const core::compiled::PropertyBearingDefinition<Id>& identity,
    const std::vector<core::compiled::OwnerPropertyContract>& properties)
{
    const auto target = core::property_target(owner);
    for (const auto& override : overrides) {
        if (override.target() != target)
            continue;
        const auto* contract = find_configuration_property_contract(project, identity, properties,
                                                                    override.property_id());
        if (contract == nullptr)
            continue;
        auto valid = validate_override_against_contract(owner, override, *contract);
        if (!valid)
            return valid;
    }
    return core::Result<void, core::Diagnostics>::success();
}

template<class Id>
core::Result<void, core::Diagnostics>
validate_property_requirements(const core::CompiledProject& project,
                               const core::compiled::PropertyBearingDefinition<Id>& identity,
                               const std::vector<core::compiled::OwnerPropertyContract>& properties,
                               std::string_view owner_label)
{
    const auto has_assignment = [&](const core::PropertyId& property) {
        return std::ranges::any_of(identity.property_assignments, [&](const auto& assignment) {
            return assignment.property_id() == property;
        });
    };
    const auto has_trait_default = [&](const core::PropertyId& property) {
        for (const auto& trait_id : identity.traits) {
            const auto* trait = project.find_trait(trait_id);
            if (trait == nullptr)
                continue;
            if (std::ranges::any_of(trait->properties, [&](const auto& member) {
                    return member.property_id == property && member.configured_value.has_value();
                }))
                return true;
        }
        return false;
    };
    const auto has_value = [&](const core::compiled::OwnerPropertyContract& contract) {
        return has_assignment(contract.property_id) || contract.configured_value.has_value() ||
               has_trait_default(contract.property_id);
    };

    for (const auto& contract : properties) {
        if (!has_value(contract))
            return core::Result<void, core::Diagnostics>::failure(
                world_error("runtime.missing_required_property",
                            std::string(owner_label) + " requires Property '" +
                                contract.property_id.text() + "' to have a Value before creation"));
    }
    for (const auto& trait_id : identity.traits) {
        const auto* trait = project.find_trait(trait_id);
        if (trait == nullptr)
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_trait_attachment",
                std::string(owner_label) + " references missing Trait '" + trait_id.text() + "'"));
        for (const auto& member : trait->properties) {
            const auto own = std::ranges::find_if(properties, [&](const auto& value) {
                return value.property_id == member.property_id;
            });
            if (own != properties.end())
                continue;
            if (!has_assignment(member.property_id) && !has_trait_default(member.property_id))
                return core::Result<void, core::Diagnostics>::failure(world_error(
                    "runtime.missing_required_property",
                    std::string(owner_label) + " requires Trait Property '" +
                        member.property_id.text() + "' to have a Value before creation"));
        }
    }
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> validate_feature_property_requirements(
    const core::CompiledProject& project,
    const std::vector<core::compiled::FeatureDefinition>& features, std::string_view owner_label)
{
    for (const auto& feature : features) {
        auto result = validate_property_requirements(project, feature.identity, feature.properties,
                                                     std::string(owner_label) + " Feature '" +
                                                         feature.identity.id.text() + "'");
        if (!result)
            return result;
    }
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
validate_room_property_requirements(const core::CompiledProject& project,
                                    const core::compiled::RoomDefinition& configuration)
{
    auto result = validate_property_requirements(project, configuration.identity,
                                                 configuration.properties, "Room configuration");
    if (!result)
        return result;
    return validate_feature_property_requirements(project, configuration.features,
                                                  "Room configuration");
}

core::Result<void, core::Diagnostics>
validate_character_property_requirements(const core::CompiledProject& project,
                                         const core::compiled::CharacterDefinition& configuration)
{
    return validate_property_requirements(project, configuration.identity, configuration.properties,
                                          "Character configuration");
}

core::Result<void, core::Diagnostics> validate_interactable_property_requirements(
    const core::CompiledProject& project,
    const core::compiled::InteractableDefinition& configuration)
{
    auto result = validate_property_requirements(
        project, configuration.identity, configuration.properties, "Interactable configuration");
    if (!result)
        return result;
    return validate_feature_property_requirements(project, configuration.features,
                                                  "Interactable configuration");
}

template<class Record, class Id>
Record* find_record(std::vector<Record>& records, const Id& id) noexcept
{
    const auto found = std::find_if(records.begin(), records.end(),
                                    [&id](const Record& record) { return record.id == id; });
    return found == records.end() ? nullptr : &*found;
}

template<class Record, class Id>
const Record* find_record(const std::vector<Record>& records, const Id& id) noexcept
{
    const auto found = std::find_if(records.begin(), records.end(),
                                    [&id](const Record& record) { return record.id == id; });
    return found == records.end() ? nullptr : &*found;
}

template<class Definition> void replace_definition_identity(Definition& definition, const auto& id)
{
    definition.identity.id = id;
}

bool has_inventory_id(const std::vector<core::compiled::InventoryDefinition>& inventories,
                      const core::InventoryId& id) noexcept
{
    return std::any_of(
        inventories.begin(), inventories.end(),
        [&id](const core::compiled::InventoryDefinition& inventory) { return inventory.id == id; });
}

bool property_target_owned_by(const core::PropertyTargetRef& target,
                              const core::GameplayInstanceRef& instance) noexcept
{
    if (const auto* room = std::get_if<core::RoomId>(&instance)) {
        if (const auto* value = std::get_if<core::RoomId>(&target))
            return *value == *room;
        if (const auto* value = std::get_if<core::RoomFeatureRef>(&target))
            return value->room == *room;
        return false;
    }
    if (const auto* character = std::get_if<core::CharacterId>(&instance)) {
        const auto* value = std::get_if<core::CharacterId>(&target);
        return value != nullptr && *value == *character;
    }
    const auto* interactable = std::get_if<core::InteractableInstanceId>(&instance);
    if (interactable == nullptr)
        return false;
    if (const auto* value = std::get_if<core::InteractableInstanceId>(&target))
        return *value == *interactable;
    if (const auto* value = std::get_if<core::InteractableFeatureRef>(&target))
        return value->interactable == *interactable;
    return false;
}

template<class Id>
bool instance_is(const core::GameplayInstanceRef& instance, const Id& id) noexcept
{
    const auto* value = std::get_if<Id>(&instance);
    return value != nullptr && *value == id;
}

bool interaction_subject_references(const core::compiled::InteractionSubject& subject,
                                    const core::GameplayInstanceRef& instance) noexcept
{
    return std::visit(
        [&](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>)
                return instance_is(instance, value.character);
            else if constexpr (std::is_same_v<T, core::compiled::InteractableInteractionSubject>)
                return instance_is(instance, value.interactable);
            else if constexpr (std::is_same_v<T, core::compiled::FeatureInteractionSubject>)
                return std::visit(
                    [&](const auto& feature) {
                        using F = std::decay_t<decltype(feature)>;
                        if constexpr (std::is_same_v<F, core::RoomFeatureRef>)
                            return instance_is(instance, feature.room);
                        else
                            return instance_is(instance, feature.interactable);
                    },
                    value.feature);
            else
                return false;
        },
        subject);
}

bool presentation_owner_references(const core::PresentationOwner& owner,
                                   const core::RoomId& room) noexcept
{
    return std::visit(
        [&](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::CurrentRoomPresentationOwner> ||
                          std::is_same_v<T, core::RoomPresentationOwner>)
                return value.room == room;
            else
                return false;
        },
        owner);
}

bool return_destination_references(const core::ReturnDestination& destination,
                                   const core::RoomId& room) noexcept
{
    const auto* resume = std::get_if<core::ResumeRoomDestination>(&destination);
    return resume != nullptr && resume->room == room;
}

bool flow_frame_references(const core::FlowFrame& frame,
                           const core::GameplayInstanceRef& instance) noexcept
{
    return std::visit(
        [&](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::InteractionFrame>) {
                if (const auto* room = std::get_if<core::RoomId>(&instance);
                    room != nullptr && value.invocation.room == *room)
                    return true;
                if (std::any_of(value.invocation.bindings.begin(), value.invocation.bindings.end(),
                                [&](const auto& binding) {
                                    return interaction_subject_references(binding.subject,
                                                                          instance);
                                }))
                    return true;
            } else if constexpr (std::is_same_v<T, core::RoomTransitionFrame>) {
                if (const auto* room = std::get_if<core::RoomId>(&instance)) {
                    if (value.target_room == *room || value.source_room == *room ||
                        (value.selected_exit && value.selected_exit->room == *room))
                        return true;
                }
            }
            if (const auto* room = std::get_if<core::RoomId>(&instance))
                return return_destination_references(value.destination, *room);
            return false;
        },
        frame);
}

void upsert_exit_override(std::vector<core::RuntimeRoomExitTargetOverride>& values,
                          core::RuntimeRoomExitTargetOverride edit)
{
    const auto found = std::find_if(values.begin(), values.end(),
                                    [&](const auto& value) { return value.exit == edit.exit; });
    if (found == values.end())
        values.push_back(std::move(edit));
    else
        found->target = std::move(edit.target);
}

std::optional<core::InteractableInstanceId>
inventory_interactable_owner(const core::compiled::InventoryRef& inventory) noexcept
{
    return std::visit(
        [](const auto& owner) -> std::optional<core::InteractableInstanceId> {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, core::compiled::InteractableInventoryOwner>)
                return owner.interactable;
            else if constexpr (std::is_same_v<T, core::InteractableFeatureRef>)
                return owner.interactable;
            else
                return std::nullopt;
        },
        inventory.owner);
}

std::vector<core::RuntimeRoomExitTargetOverride>
effective_source_exit_overrides(const core::RuntimeRoomConfiguration& record)
{
    std::vector<core::RuntimeRoomExitTargetOverride> result =
        record.structural_override_source ? record.structural_override_exit_target_overrides
                                          : record.birth_exit_target_overrides;
    for (const auto& edit : record.exit_target_overrides)
        upsert_exit_override(result, edit);
    return result;
}

struct ResolvedRoomRequest {
    core::compiled::RoomDefinition configuration;
    core::RuntimeConfigurationSource source;
    core::RuntimeInstanceProvenance provenance;
    std::vector<core::RuntimeRoomExitTargetOverride> source_exit_overrides;
};

core::Result<ResolvedRoomRequest, core::Diagnostics>
resolve_room_request(const core::CompiledProject& project, const core::SessionState& state,
                     const RuntimeWorld& world, const RuntimeInstanceConfigurationRequest& request)
{
    std::optional<ResolvedRoomRequest> resolved;
    std::visit(
        [&](const auto& source) {
            using T = std::decay_t<decltype(source)>;
            if constexpr (std::is_same_v<T, ArchetypeInstanceConfiguration>) {
                const auto* archetype = project.find_archetype(source.archetype);
                const auto* definition =
                    archetype != nullptr &&
                            archetype->kind == core::compiled::GameplayInstanceKind::Room
                        ? std::get_if<core::compiled::RoomDefinition>(&archetype->configuration)
                        : nullptr;
                if (definition != nullptr)
                    resolved =
                        ResolvedRoomRequest{*definition,
                                            core::ArchetypeConfigurationSource{source.archetype},
                                            core::RuntimeInstanceProvenance{
                                                core::RuntimeInstanceProvenanceKind::Archetype,
                                                source.archetype, std::nullopt},
                                            {}};
            } else {
                const auto* id = std::get_if<core::RoomId>(&source.instance);
                if (id == nullptr)
                    return;
                if constexpr (std::is_same_v<T, CompiledInstanceConfiguration>) {
                    const auto* definition = project.find_room(*id);
                    if (definition != nullptr)
                        resolved = ResolvedRoomRequest{
                            *definition,
                            core::CompiledRoomConfigurationSource{*id},
                            core::RuntimeInstanceProvenance{
                                core::RuntimeInstanceProvenanceKind::CompiledDefinition,
                                std::nullopt, source.instance},
                            {}};
                } else {
                    const auto* definition = world.resolved_configuration(*id);
                    const auto* record = find_record(state.runtime_rooms(), *id);
                    if (definition != nullptr && record != nullptr)
                        resolved = ResolvedRoomRequest{
                            *definition,
                            record->structural_override_source.value_or(record->birth_source),
                            core::RuntimeInstanceProvenance{
                                core::RuntimeInstanceProvenanceKind::Clone, std::nullopt,
                                source.instance},
                            effective_source_exit_overrides(*record)};
                }
            }
        },
        request);
    return resolved
               ? core::Result<ResolvedRoomRequest, core::Diagnostics>::success(std::move(*resolved))
               : core::Result<ResolvedRoomRequest, core::Diagnostics>::failure(world_error(
                     "runtime.invalid_instance_configuration_source",
                     "Room configuration source does not resolve to compiled Room vocabulary"));
}

struct ResolvedCharacterRequest {
    core::compiled::CharacterDefinition configuration;
    core::RuntimeConfigurationSource source;
    core::RuntimeInstanceProvenance provenance;
};

core::Result<ResolvedCharacterRequest, core::Diagnostics>
resolve_character_request(const core::CompiledProject& project, const core::SessionState& state,
                          const RuntimeWorld& world,
                          const RuntimeInstanceConfigurationRequest& request)
{
    std::optional<ResolvedCharacterRequest> resolved;
    std::visit(
        [&](const auto& source) {
            using T = std::decay_t<decltype(source)>;
            if constexpr (std::is_same_v<T, ArchetypeInstanceConfiguration>) {
                const auto* archetype = project.find_archetype(source.archetype);
                const auto* definition =
                    archetype != nullptr &&
                            archetype->kind == core::compiled::GameplayInstanceKind::Character
                        ? std::get_if<core::compiled::CharacterDefinition>(
                              &archetype->configuration)
                        : nullptr;
                if (definition != nullptr)
                    resolved = ResolvedCharacterRequest{
                        *definition, core::ArchetypeConfigurationSource{source.archetype},
                        core::RuntimeInstanceProvenance{
                            core::RuntimeInstanceProvenanceKind::Archetype, source.archetype,
                            std::nullopt}};
            } else {
                const auto* id = std::get_if<core::CharacterId>(&source.instance);
                if (id == nullptr)
                    return;
                if constexpr (std::is_same_v<T, CompiledInstanceConfiguration>) {
                    const auto* definition = project.find_character(*id);
                    if (definition != nullptr)
                        resolved = ResolvedCharacterRequest{
                            *definition, core::CompiledCharacterConfigurationSource{*id},
                            core::RuntimeInstanceProvenance{
                                core::RuntimeInstanceProvenanceKind::CompiledDefinition,
                                std::nullopt, source.instance}};
                } else {
                    const auto* definition = world.resolved_configuration(*id);
                    const auto* record = find_record(state.runtime_characters(), *id);
                    if (definition != nullptr && record != nullptr)
                        resolved = ResolvedCharacterRequest{
                            *definition,
                            record->structural_override_source.value_or(record->birth_source),
                            core::RuntimeInstanceProvenance{
                                core::RuntimeInstanceProvenanceKind::Clone, std::nullopt,
                                source.instance}};
                }
            }
        },
        request);
    return resolved ? core::Result<ResolvedCharacterRequest, core::Diagnostics>::success(
                          std::move(*resolved))
                    : core::Result<ResolvedCharacterRequest, core::Diagnostics>::failure(
                          world_error("runtime.invalid_instance_configuration_source",
                                      "Character configuration source does not resolve to compiled "
                                      "Character vocabulary"));
}

struct ResolvedInteractableRequest {
    core::compiled::InteractableDefinition configuration;
    core::RuntimeConfigurationSource source;
    core::RuntimeInstanceProvenance provenance;
};

core::Result<ResolvedInteractableRequest, core::Diagnostics>
resolve_interactable_request(const core::CompiledProject& project, const core::SessionState& state,
                             const RuntimeWorld& world,
                             const RuntimeInstanceConfigurationRequest& request)
{
    std::optional<ResolvedInteractableRequest> resolved;
    std::visit(
        [&](const auto& source) {
            using T = std::decay_t<decltype(source)>;
            if constexpr (std::is_same_v<T, ArchetypeInstanceConfiguration>) {
                const auto* archetype = project.find_archetype(source.archetype);
                const auto* definition =
                    archetype != nullptr &&
                            archetype->kind == core::compiled::GameplayInstanceKind::Interactable
                        ? std::get_if<core::compiled::InteractableDefinition>(
                              &archetype->configuration)
                        : nullptr;
                if (definition != nullptr)
                    resolved = ResolvedInteractableRequest{
                        *definition, core::ArchetypeConfigurationSource{source.archetype},
                        core::RuntimeInstanceProvenance{
                            core::RuntimeInstanceProvenanceKind::Archetype, source.archetype,
                            std::nullopt}};
            } else {
                const auto* id = std::get_if<core::InteractableInstanceId>(&source.instance);
                if (id == nullptr)
                    return;
                if constexpr (std::is_same_v<T, CompiledInstanceConfiguration>) {
                    const auto* declaration = project.find_interactable_instance(*id);
                    const auto* definition =
                        declaration != nullptr
                            ? project.find_interactable_definition(declaration->definition)
                            : nullptr;
                    if (definition != nullptr && declaration != nullptr)
                        resolved = ResolvedInteractableRequest{
                            *definition,
                            core::CompiledInteractableConfigurationSource{declaration->definition},
                            core::RuntimeInstanceProvenance{
                                core::RuntimeInstanceProvenanceKind::CompiledDefinition,
                                std::nullopt, source.instance}};
                } else {
                    const auto* definition = world.resolved_configuration(*id);
                    const auto* record = find_record(state.runtime_interactables(), *id);
                    if (definition != nullptr && record != nullptr)
                        resolved = ResolvedInteractableRequest{
                            *definition,
                            record->structural_override_source.value_or(record->birth_source),
                            core::RuntimeInstanceProvenance{
                                core::RuntimeInstanceProvenanceKind::Clone, std::nullopt,
                                source.instance}};
                }
            }
        },
        request);
    return resolved ? core::Result<ResolvedInteractableRequest, core::Diagnostics>::success(
                          std::move(*resolved))
                    : core::Result<ResolvedInteractableRequest, core::Diagnostics>::failure(
                          world_error("runtime.invalid_instance_configuration_source",
                                      "Interactable configuration source does not resolve to "
                                      "compiled Interactable vocabulary"));
}

} // namespace

const core::compiled::RoomDefinition*
RuntimeWorld::resolved_configuration(const core::RoomId& id) const noexcept
{
    const auto* record = find_record(m_state.m_runtime_rooms, id);
    return record != nullptr ? &record->effective_configuration() : nullptr;
}

const core::compiled::CharacterDefinition*
RuntimeWorld::resolved_configuration(const core::CharacterId& id) const noexcept
{
    const auto* record = find_record(m_state.m_runtime_characters, id);
    return record != nullptr ? &record->effective_configuration() : nullptr;
}

const core::compiled::InteractableDefinition*
RuntimeWorld::resolved_configuration(const core::InteractableInstanceId& id) const noexcept
{
    const auto* record = find_record(m_state.m_runtime_interactables, id);
    return record != nullptr ? &record->effective_configuration() : nullptr;
}

const core::RuntimeInstanceProvenance*
RuntimeWorld::provenance(const core::GameplayInstanceRef& instance) const noexcept
{
    return std::visit(
        [&](const auto& id) -> const core::RuntimeInstanceProvenance* {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, core::RoomId>) {
                const auto* record = find_record(m_state.m_runtime_rooms, id);
                return record != nullptr ? &record->provenance : nullptr;
            } else if constexpr (std::is_same_v<T, core::CharacterId>) {
                const auto* record = find_record(m_state.m_runtime_characters, id);
                return record != nullptr ? &record->provenance : nullptr;
            } else {
                const auto* record = find_record(m_state.m_runtime_interactables, id);
                return record != nullptr ? &record->provenance : nullptr;
            }
        },
        instance);
}

bool RuntimeWorld::runtime_created(const core::GameplayInstanceRef& instance) const noexcept
{
    return std::visit(
        [&](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, core::RoomId>) {
                const auto* record = find_record(m_state.m_runtime_rooms, id);
                return record != nullptr && !record->declared;
            } else if constexpr (std::is_same_v<T, core::CharacterId>) {
                const auto* record = find_record(m_state.m_runtime_characters, id);
                return record != nullptr && !record->declared;
            } else {
                const auto* record = find_record(m_state.m_runtime_interactables, id);
                return record != nullptr && !record->declared;
            }
        },
        instance);
}

core::Result<core::RoomId, core::Diagnostics>
RuntimeWorld::create_room(RuntimeInstanceConfigurationRequest source)
{
    auto resolved = resolve_room_request(m_project, m_state, *this, source);
    auto* request = resolved.value_if();
    if (request == nullptr)
        return core::Result<core::RoomId, core::Diagnostics>::failure(resolved.error());
    auto property_requirements =
        validate_room_property_requirements(m_project, request->configuration);
    if (!property_requirements)
        return core::Result<core::RoomId, core::Diagnostics>::failure(
            property_requirements.error());

    for (;;) {
        const auto ordinal = m_state.m_next_runtime_instance_id;
        if (ordinal == std::numeric_limits<std::uint64_t>::max())
            return core::Result<core::RoomId, core::Diagnostics>::failure(
                world_error("runtime.instance_identity_exhausted",
                            "Runtime Gameplay Instance identity allocator is exhausted"));
        auto candidate = core::RoomId::create("runtime-room-" + std::to_string(ordinal));
        const auto* id = candidate.value_if();
        if (id == nullptr)
            return core::Result<core::RoomId, core::Diagnostics>::failure(candidate.error());
        if (resolved_configuration(*id) != nullptr) {
            ++m_state.m_next_runtime_instance_id;
            continue;
        }
        auto birth = request->configuration;
        replace_definition_identity(birth, *id);
        m_state.m_runtime_rooms.push_back(
            core::RuntimeRoomConfiguration{*id,
                                           false,
                                           request->source,
                                           std::nullopt,
                                           request->provenance,
                                           std::move(birth),
                                           std::nullopt,
                                           request->source_exit_overrides,
                                           {},
                                           {}});
        ++m_state.m_next_runtime_instance_id;
        return core::Result<core::RoomId, core::Diagnostics>::success(*id);
    }
}

core::Result<core::CharacterId, core::Diagnostics>
RuntimeWorld::create_character(RuntimeInstanceConfigurationRequest source,
                               core::CharacterWorldLocation location, bool enabled, bool visible)
{
    if (const auto* room = std::get_if<core::compiled::RoomLocation>(&location);
        room != nullptr && resolved_configuration(room->room) == nullptr)
        return core::Result<core::CharacterId, core::Diagnostics>::failure(world_error(
            "runtime.invalid_character_location", "Character Room Location is unresolved"));

    auto resolved = resolve_character_request(m_project, m_state, *this, source);
    auto* request = resolved.value_if();
    if (request == nullptr)
        return core::Result<core::CharacterId, core::Diagnostics>::failure(resolved.error());
    auto property_requirements =
        validate_character_property_requirements(m_project, request->configuration);
    if (!property_requirements)
        return core::Result<core::CharacterId, core::Diagnostics>::failure(
            property_requirements.error());

    for (;;) {
        const auto ordinal = m_state.m_next_runtime_instance_id;
        if (ordinal == std::numeric_limits<std::uint64_t>::max())
            return core::Result<core::CharacterId, core::Diagnostics>::failure(
                world_error("runtime.instance_identity_exhausted",
                            "Runtime Gameplay Instance identity allocator is exhausted"));
        auto candidate = core::CharacterId::create("runtime-character-" + std::to_string(ordinal));
        const auto* id = candidate.value_if();
        if (id == nullptr)
            return core::Result<core::CharacterId, core::Diagnostics>::failure(candidate.error());
        if (resolved_configuration(*id) != nullptr) {
            ++m_state.m_next_runtime_instance_id;
            continue;
        }
        auto birth = request->configuration;
        replace_definition_identity(birth, *id);
        birth.initial_world_state = {location, enabled, visible};
        m_state.m_runtime_characters.push_back(core::RuntimeCharacterConfiguration{
            *id, false, request->source, std::nullopt, request->provenance, birth, std::nullopt});
        m_state.m_character_world.push_back(
            core::CharacterWorldState{*id, std::move(location), enabled, visible});
        ++m_state.m_next_runtime_instance_id;
        return core::Result<core::CharacterId, core::Diagnostics>::success(*id);
    }
}

core::Result<core::InteractableInstanceId, core::Diagnostics>
RuntimeWorld::create_interactable(RuntimeInstanceConfigurationRequest source,
                                  core::compiled::InteractableLocation location, bool enabled,
                                  bool visible)
{
    if (const auto* room = std::get_if<core::compiled::RoomLocation>(&location);
        room != nullptr && resolved_configuration(room->room) == nullptr)
        return core::Result<core::InteractableInstanceId, core::Diagnostics>::failure(world_error(
            "runtime.invalid_interactable_location", "Interactable Room Location is unresolved"));
    if (const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&location);
        inventory != nullptr && !has_inventory(inventory->inventory))
        return core::Result<core::InteractableInstanceId, core::Diagnostics>::failure(
            world_error("runtime.invalid_interactable_location",
                        "Interactable Inventory Location is unresolved"));

    auto resolved = resolve_interactable_request(m_project, m_state, *this, source);
    auto* request = resolved.value_if();
    if (request == nullptr)
        return core::Result<core::InteractableInstanceId, core::Diagnostics>::failure(
            resolved.error());
    auto property_requirements =
        validate_interactable_property_requirements(m_project, request->configuration);
    if (!property_requirements)
        return core::Result<core::InteractableInstanceId, core::Diagnostics>::failure(
            property_requirements.error());

    for (;;) {
        const auto ordinal = m_state.m_next_runtime_instance_id;
        if (ordinal == std::numeric_limits<std::uint64_t>::max())
            return core::Result<core::InteractableInstanceId, core::Diagnostics>::failure(
                world_error("runtime.instance_identity_exhausted",
                            "Runtime Gameplay Instance identity allocator is exhausted"));
        auto candidate =
            core::InteractableInstanceId::create("runtime-interactable-" + std::to_string(ordinal));
        const auto* id = candidate.value_if();
        if (id == nullptr)
            return core::Result<core::InteractableInstanceId, core::Diagnostics>::failure(
                candidate.error());
        if (resolved_configuration(*id) != nullptr) {
            ++m_state.m_next_runtime_instance_id;
            continue;
        }
        auto birth = request->configuration;
        m_state.m_runtime_interactables.push_back(core::RuntimeInteractableConfiguration{
            *id, false, request->source, std::nullopt, request->provenance, birth, std::nullopt});
        m_state.m_interactables.push_back(
            core::InteractableState{*id, std::move(location), enabled, visible});
        ++m_state.m_next_runtime_instance_id;
        return core::Result<core::InteractableInstanceId, core::Diagnostics>::success(*id);
    }
}

core::Result<void, core::Diagnostics> RuntimeWorld::validate_room_configuration_change(
    const core::RoomId& id, const core::compiled::RoomDefinition& configuration) const
{
    auto property_state = validate_configuration_property_overrides(
        m_project, m_state.m_property_overrides, core::PropertyOwnerRef{id}, configuration.identity,
        configuration.properties);
    if (!property_state)
        return property_state;
    for (const auto& feature : configuration.features) {
        const core::PropertyOwnerRef owner{core::RoomFeatureRef{id, feature.identity.id}};
        property_state = validate_configuration_property_overrides(
            m_project, m_state.m_property_overrides, owner, feature.identity, feature.properties);
        if (!property_state)
            return property_state;
    }

    for (const auto& frame : m_state.m_flow_stack) {
        const auto* transition = std::get_if<core::RoomTransitionFrame>(&frame);
        if (transition != nullptr &&
            (transition->target_room == id || transition->source_room == id))
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.lifecycle_critical_structural_edit",
                "Room configuration cannot change while an active Room transition references it"));
        const auto* interaction = std::get_if<core::InteractionFrame>(&frame);
        if (interaction == nullptr)
            continue;
        for (const auto& binding : interaction->invocation.bindings) {
            const auto* feature_subject =
                std::get_if<core::compiled::FeatureInteractionSubject>(&binding.subject);
            if (feature_subject == nullptr)
                continue;
            const auto* feature = std::get_if<core::RoomFeatureRef>(&feature_subject->feature);
            if (feature != nullptr && feature->room == id &&
                std::none_of(
                    configuration.features.begin(), configuration.features.end(),
                    [&](const auto& value) { return value.identity.id == feature->feature_id; }))
                return core::Result<void, core::Diagnostics>::failure(world_error(
                    "runtime.invalid_structural_edit",
                    "Room configuration change would invalidate an active Feature subject"));
        }
    }
    for (const auto& state : m_state.m_interactables) {
        const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&state.location);
        const auto* owner = inventory == nullptr
                                ? nullptr
                                : std::get_if<core::RoomFeatureRef>(&inventory->inventory.owner);
        if (owner == nullptr || owner->room != id)
            continue;
        const auto feature =
            std::find_if(configuration.features.begin(), configuration.features.end(),
                         [&](const auto& value) { return value.identity.id == owner->feature_id; });
        if (feature == configuration.features.end() ||
            !has_inventory_id(feature->inventories, inventory->inventory.inventory_id))
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Room configuration change would invalidate a live Feature Inventory membership"));
    }
    for (const auto& property : m_state.m_property_overrides) {
        const auto* feature = std::get_if<core::RoomFeatureRef>(&property.target());
        if (feature != nullptr && feature->room == id &&
            std::none_of(
                configuration.features.begin(), configuration.features.end(),
                [&](const auto& value) { return value.identity.id == feature->feature_id; }))
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Room configuration change would invalidate a live Feature Property override"));
    }
    for (const auto& actor : m_state.m_actors) {
        const auto* key = std::get_if<core::RoomCastActorKey>(&actor.key);
        if (key == nullptr || key->room != id)
            continue;
        const auto cast = std::find_if(configuration.cast.begin(), configuration.cast.end(),
                                       [&](const auto& value) { return value.id == key->entry; });
        if (cast == configuration.cast.end() || cast->character != actor.character)
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Room configuration change would invalidate live cast presentation state"));
    }
    for (const auto& prop : m_state.m_presentation_props) {
        if (!prop.placement || prop.placement->room != id)
            continue;
        if (std::none_of(
                configuration.placements.begin(), configuration.placements.end(),
                [&](const auto& value) { return value.id == prop.placement->placement_id; }))
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Room configuration change would invalidate live presentation placement state"));
    }
    for (const auto& layout : m_state.m_mounted_layouts) {
        const auto* key = std::get_if<core::RoomOverlayLayoutMountKey>(&layout.key);
        if (key == nullptr || key->room != id)
            continue;
        const auto overlay =
            std::find_if(configuration.overlays.begin(), configuration.overlays.end(),
                         [&](const auto& value) { return value.id == key->overlay; });
        if (overlay == configuration.overlays.end() || overlay->layout != layout.layout)
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Room configuration change would invalidate live overlay presentation state"));
    }
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeWorld::validate_character_configuration_change(
    const core::CharacterId& id, const core::compiled::CharacterDefinition& configuration) const
{
    auto property_state = validate_configuration_property_overrides(
        m_project, m_state.m_property_overrides, core::PropertyOwnerRef{id}, configuration.identity,
        configuration.properties);
    if (!property_state)
        return property_state;

    for (const auto& state : m_state.m_interactables) {
        const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&state.location);
        if (inventory == nullptr)
            continue;
        const auto* owner =
            std::get_if<core::compiled::CharacterInventoryOwner>(&inventory->inventory.owner);
        if (owner != nullptr && owner->character == id &&
            !has_inventory_id(configuration.inventories, inventory->inventory.inventory_id))
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Character configuration change would invalidate a live Inventory membership"));
    }
    for (const auto& actor : m_state.m_actors) {
        if (actor.character != id)
            continue;
        const auto profile =
            std::find_if(configuration.profiles.begin(), configuration.profiles.end(),
                         [&](const auto& value) { return value.id == actor.profile; });
        const bool pose = profile != configuration.profiles.end() &&
                          std::any_of(profile->poses.begin(), profile->poses.end(),
                                      [&](const auto& value) { return value.id == actor.pose; });
        const auto expression =
            std::find_if(configuration.expressions.begin(), configuration.expressions.end(),
                         [&](const auto& value) { return value.id == actor.expression; });
        const bool appearance =
            !actor.appearance ||
            std::any_of(configuration.appearances.begin(), configuration.appearances.end(),
                        [&](const auto& value) { return value.id == *actor.appearance; });
        const bool idle =
            !actor.idle || std::any_of(configuration.idles.begin(), configuration.idles.end(),
                                       [&](const auto& value) { return value.id == *actor.idle; });
        if (!pose || expression == configuration.expressions.end() || !appearance || !idle)
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Character configuration change would invalidate live actor presentation state"));
    }
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeWorld::validate_interactable_configuration_change(
    const core::InteractableInstanceId& id,
    const core::compiled::InteractableDefinition& configuration) const
{
    auto property_state = validate_configuration_property_overrides(
        m_project, m_state.m_property_overrides, core::PropertyOwnerRef{id}, configuration.identity,
        configuration.properties);
    if (!property_state)
        return property_state;
    for (const auto& feature : configuration.features) {
        const core::PropertyOwnerRef owner{core::InteractableFeatureRef{id, feature.identity.id}};
        property_state = validate_configuration_property_overrides(
            m_project, m_state.m_property_overrides, owner, feature.identity, feature.properties);
        if (!property_state)
            return property_state;
    }

    for (const auto& frame : m_state.m_flow_stack) {
        const auto* interaction = std::get_if<core::InteractionFrame>(&frame);
        if (interaction == nullptr)
            continue;
        for (const auto& binding : interaction->invocation.bindings) {
            const auto* feature_subject =
                std::get_if<core::compiled::FeatureInteractionSubject>(&binding.subject);
            if (feature_subject == nullptr)
                continue;
            const auto* feature =
                std::get_if<core::InteractableFeatureRef>(&feature_subject->feature);
            if (feature != nullptr && feature->interactable == id &&
                std::none_of(
                    configuration.features.begin(), configuration.features.end(),
                    [&](const auto& value) { return value.identity.id == feature->feature_id; }))
                return core::Result<void, core::Diagnostics>::failure(world_error(
                    "runtime.invalid_structural_edit", "Interactable configuration change would "
                                                       "invalidate an active Feature subject"));
        }
    }
    for (const auto& state : m_state.m_interactables) {
        const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&state.location);
        if (inventory == nullptr)
            continue;
        bool owned = false;
        bool valid = true;
        std::visit(
            [&](const auto& owner) {
                using T = std::decay_t<decltype(owner)>;
                if constexpr (std::is_same_v<T, core::compiled::InteractableInventoryOwner>) {
                    if (owner.interactable == id) {
                        owned = true;
                        valid = has_inventory_id(configuration.inventories,
                                                 inventory->inventory.inventory_id);
                    }
                } else if constexpr (std::is_same_v<T, core::InteractableFeatureRef>) {
                    if (owner.interactable == id) {
                        owned = true;
                        const auto feature =
                            std::find_if(configuration.features.begin(),
                                         configuration.features.end(), [&](const auto& value) {
                                             return value.identity.id == owner.feature_id;
                                         });
                        valid = feature != configuration.features.end() &&
                                has_inventory_id(feature->inventories,
                                                 inventory->inventory.inventory_id);
                    }
                }
            },
            inventory->inventory.owner);
        if (owned && !valid)
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Interactable configuration change would invalidate a live Inventory membership"));
    }
    for (const auto& property : m_state.m_property_overrides) {
        const auto* feature = std::get_if<core::InteractableFeatureRef>(&property.target());
        if (feature == nullptr || feature->interactable != id)
            continue;
        if (std::none_of(
                configuration.features.begin(), configuration.features.end(),
                [&](const auto& value) { return value.identity.id == feature->feature_id; }))
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit", "Interactable configuration change would "
                                                   "invalidate a live Feature Property override"));
    }
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::replace_structural_configuration(const core::RoomId& id,
                                               RuntimeInstanceConfigurationRequest source)
{
    auto* target = find_record(m_state.m_runtime_rooms, id);
    if (target == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.unknown_room", "Room Gameplay Instance is not live"));
    auto resolved = resolve_room_request(m_project, m_state, *this, source);
    const auto* request = resolved.value_if();
    if (request == nullptr)
        return core::Result<void, core::Diagnostics>::failure(resolved.error());

    auto configuration = request->configuration;
    replace_definition_identity(configuration, id);
    for (const auto& edit : target->exit_target_overrides) {
        const auto found = std::find_if(configuration.exits.begin(), configuration.exits.end(),
                                        [&](const auto& exit) { return exit.id == edit.exit; });
        if (found == configuration.exits.end() || resolved_configuration(edit.target) == nullptr)
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Existing Room structural edit is incompatible with replacement configuration"));
        found->target = edit.target;
    }
    for (const auto& state : m_state.m_interactables) {
        const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&state.location);
        const auto* owner = inventory == nullptr
                                ? nullptr
                                : std::get_if<core::RoomFeatureRef>(&inventory->inventory.owner);
        if (owner == nullptr || owner->room != id)
            continue;
        const auto feature =
            std::find_if(configuration.features.begin(), configuration.features.end(),
                         [&](const auto& value) { return value.identity.id == owner->feature_id; });
        if (feature == configuration.features.end() ||
            !has_inventory_id(feature->inventories, inventory->inventory.inventory_id))
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Room replacement would invalidate a live Feature Inventory membership"));
    }
    for (const auto& property : m_state.m_property_overrides) {
        const auto* feature = std::get_if<core::RoomFeatureRef>(&property.target());
        if (feature != nullptr && feature->room == id &&
            std::none_of(
                configuration.features.begin(), configuration.features.end(),
                [&](const auto& value) { return value.identity.id == feature->feature_id; }))
            return core::Result<void, core::Diagnostics>::failure(
                world_error("runtime.invalid_structural_edit",
                            "Room replacement would invalidate a live Feature Property override"));
    }
    for (const auto& actor : m_state.m_actors) {
        const auto* key = std::get_if<core::RoomCastActorKey>(&actor.key);
        if (key == nullptr || key->room != id)
            continue;
        const auto cast = std::find_if(configuration.cast.begin(), configuration.cast.end(),
                                       [&](const auto& value) { return value.id == key->entry; });
        if (cast == configuration.cast.end() || cast->character != actor.character)
            return core::Result<void, core::Diagnostics>::failure(
                world_error("runtime.invalid_structural_edit",
                            "Room replacement would invalidate live cast presentation state"));
    }
    for (const auto& prop : m_state.m_presentation_props) {
        if (!prop.placement || prop.placement->room != id)
            continue;
        if (std::none_of(
                configuration.placements.begin(), configuration.placements.end(),
                [&](const auto& value) { return value.id == prop.placement->placement_id; }))
            return core::Result<void, core::Diagnostics>::failure(
                world_error("runtime.invalid_structural_edit",
                            "Room replacement would invalidate live presentation placement state"));
    }
    for (const auto& layout : m_state.m_mounted_layouts) {
        const auto* key = std::get_if<core::RoomOverlayLayoutMountKey>(&layout.key);
        if (key == nullptr || key->room != id)
            continue;
        const auto overlay =
            std::find_if(configuration.overlays.begin(), configuration.overlays.end(),
                         [&](const auto& value) { return value.id == key->overlay; });
        if (overlay == configuration.overlays.end() || overlay->layout != layout.layout)
            return core::Result<void, core::Diagnostics>::failure(
                world_error("runtime.invalid_structural_edit",
                            "Room replacement would invalidate live overlay presentation state"));
    }

    auto valid = validate_room_configuration_change(id, configuration);
    if (!valid)
        return valid;
    target->structural_override_source = request->source;
    target->structural_override = std::move(configuration);
    target->structural_override_exit_target_overrides = request->source_exit_overrides;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::replace_structural_configuration(const core::CharacterId& id,
                                               RuntimeInstanceConfigurationRequest source)
{
    auto* target = find_record(m_state.m_runtime_characters, id);
    if (target == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.unknown_character", "Character Gameplay Instance is not live"));
    auto resolved = resolve_character_request(m_project, m_state, *this, source);
    const auto* request = resolved.value_if();
    if (request == nullptr)
        return core::Result<void, core::Diagnostics>::failure(resolved.error());

    auto configuration = request->configuration;
    for (const auto& state : m_state.m_interactables) {
        const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&state.location);
        if (inventory == nullptr)
            continue;
        const auto* owner =
            std::get_if<core::compiled::CharacterInventoryOwner>(&inventory->inventory.owner);
        if (owner != nullptr && owner->character == id &&
            !has_inventory_id(configuration.inventories, inventory->inventory.inventory_id))
            return core::Result<void, core::Diagnostics>::failure(
                world_error("runtime.invalid_structural_edit",
                            "Character replacement would invalidate a live Inventory membership"));
    }
    for (const auto& actor : m_state.actors()) {
        if (actor.character != id)
            continue;
        const auto profile =
            std::find_if(configuration.profiles.begin(), configuration.profiles.end(),
                         [&](const auto& value) { return value.id == actor.profile; });
        const bool pose = profile != configuration.profiles.end() &&
                          std::any_of(profile->poses.begin(), profile->poses.end(),
                                      [&](const auto& value) { return value.id == actor.pose; });
        const auto expression =
            std::find_if(configuration.expressions.begin(), configuration.expressions.end(),
                         [&](const auto& value) { return value.id == actor.expression; });
        const bool appearance =
            !actor.appearance ||
            std::any_of(configuration.appearances.begin(), configuration.appearances.end(),
                        [&](const auto& value) { return value.id == *actor.appearance; });
        const bool idle =
            !actor.idle || std::any_of(configuration.idles.begin(), configuration.idles.end(),
                                       [&](const auto& value) { return value.id == *actor.idle; });
        if (!pose || expression == configuration.expressions.end() || !appearance || !idle)
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Character replacement would invalidate live actor presentation state"));
    }

    auto valid = validate_character_configuration_change(id, configuration);
    if (!valid)
        return valid;
    target->structural_override_source = request->source;
    target->structural_override = std::move(configuration);
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::replace_structural_configuration(const core::InteractableInstanceId& id,
                                               RuntimeInstanceConfigurationRequest source)
{
    auto* target = find_record(m_state.m_runtime_interactables, id);
    if (target == nullptr)
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.unknown_interactable", "Interactable Gameplay Instance is not live"));
    auto resolved = resolve_interactable_request(m_project, m_state, *this, source);
    const auto* request = resolved.value_if();
    if (request == nullptr)
        return core::Result<void, core::Diagnostics>::failure(resolved.error());

    auto configuration = request->configuration;
    for (const auto& state : m_state.m_interactables) {
        const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&state.location);
        if (inventory == nullptr)
            continue;
        bool owned = false;
        bool valid = true;
        std::visit(
            [&](const auto& owner) {
                using T = std::decay_t<decltype(owner)>;
                if constexpr (std::is_same_v<T, core::compiled::InteractableInventoryOwner>) {
                    if (owner.interactable == id) {
                        owned = true;
                        valid = has_inventory_id(configuration.inventories,
                                                 inventory->inventory.inventory_id);
                    }
                } else if constexpr (std::is_same_v<T, core::InteractableFeatureRef>) {
                    if (owner.interactable == id) {
                        owned = true;
                        const auto feature =
                            std::find_if(configuration.features.begin(),
                                         configuration.features.end(), [&](const auto& value) {
                                             return value.identity.id == owner.feature_id;
                                         });
                        valid = feature != configuration.features.end() &&
                                has_inventory_id(feature->inventories,
                                                 inventory->inventory.inventory_id);
                    }
                }
            },
            inventory->inventory.owner);
        if (owned && !valid)
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Interactable replacement would invalidate a live Inventory membership"));
    }
    for (const auto& property : m_state.m_property_overrides) {
        const auto* feature = std::get_if<core::InteractableFeatureRef>(&property.target());
        if (feature == nullptr || feature->interactable != id)
            continue;
        if (std::none_of(
                configuration.features.begin(), configuration.features.end(),
                [&](const auto& value) { return value.identity.id == feature->feature_id; }))
            return core::Result<void, core::Diagnostics>::failure(world_error(
                "runtime.invalid_structural_edit",
                "Interactable replacement would invalidate a live Feature Property override"));
    }

    auto valid = validate_interactable_configuration_change(id, configuration);
    if (!valid)
        return valid;
    target->structural_override_source = request->source;
    target->structural_override = std::move(configuration);
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::clear_structural_configuration(const core::RoomId& id)
{
    auto* record = find_record(m_state.m_runtime_rooms, id);
    if (record == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.unknown_room", "Room Gameplay Instance is not live"));
    auto valid = validate_room_configuration_change(id, record->birth_configuration);
    if (!valid)
        return valid;
    record->structural_override_source.reset();
    record->structural_override.reset();
    record->structural_override_exit_target_overrides.clear();
    record->exit_target_overrides.clear();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::clear_structural_configuration(const core::CharacterId& id)
{
    auto* record = find_record(m_state.m_runtime_characters, id);
    if (record == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.unknown_character", "Character Gameplay Instance is not live"));
    auto valid = validate_character_configuration_change(id, record->birth_configuration);
    if (!valid)
        return valid;
    record->structural_override_source.reset();
    record->structural_override.reset();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::clear_structural_configuration(const core::InteractableInstanceId& id)
{
    auto* record = find_record(m_state.m_runtime_interactables, id);
    if (record == nullptr)
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.unknown_interactable", "Interactable Gameplay Instance is not live"));
    auto valid = validate_interactable_configuration_change(id, record->birth_configuration);
    if (!valid)
        return valid;
    record->structural_override_source.reset();
    record->structural_override.reset();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeWorld::retarget_room_exit(const core::RoomId& room,
                                                                       const core::RoomExitId& exit,
                                                                       const core::RoomId& target)
{
    auto* record = find_record(m_state.m_runtime_rooms, room);
    if (record == nullptr || resolved_configuration(target) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.invalid_structural_edit",
                        "Room or target Room Gameplay Instance is unresolved"));
    auto candidate = record->effective_configuration();
    auto found = std::find_if(candidate.exits.begin(), candidate.exits.end(),
                              [&](const auto& value) { return value.id == exit; });
    if (found == candidate.exits.end())
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.invalid_structural_edit", "Room Exit is unresolved"));
    found->target = target;
    auto existing =
        std::find_if(record->exit_target_overrides.begin(), record->exit_target_overrides.end(),
                     [&](const auto& value) { return value.exit == exit; });
    if (existing == record->exit_target_overrides.end())
        record->exit_target_overrides.push_back({exit, target});
    else
        existing->target = target;
    record->structural_override = std::move(candidate);
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::destroy(const core::GameplayInstanceRef& instance)
{
    const bool exists = provenance(instance) != nullptr;
    if (!exists)
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.unknown_gameplay_instance", "Gameplay Instance is not live"));
    if (!runtime_created(instance))
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.declared_instance_not_destroyable",
                        "Declared Gameplay Instances cannot be destroyed"));

    const auto provenance_depends = [&](const auto& record) {
        return record.provenance.source_instance && *record.provenance.source_instance == instance;
    };
    if (std::any_of(m_state.m_runtime_rooms.begin(), m_state.m_runtime_rooms.end(),
                    provenance_depends) ||
        std::any_of(m_state.m_runtime_characters.begin(), m_state.m_runtime_characters.end(),
                    provenance_depends) ||
        std::any_of(m_state.m_runtime_interactables.begin(), m_state.m_runtime_interactables.end(),
                    provenance_depends) ||
        std::any_of(m_state.m_flow_stack.begin(), m_state.m_flow_stack.end(),
                    [&](const auto& frame) { return flow_frame_references(frame, instance); }))
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.instance_has_dependents", "Gameplay Instance cannot be destroyed while "
                                               "provenance or active Flow references remain"));

    const bool dependent = std::visit(
        [&](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, core::RoomId>) {
                if (const auto* mode = std::get_if<core::RoomMode>(&m_state.m_mode);
                    mode != nullptr && mode->room == id)
                    return true;
                if (m_state.room_visit() &&
                    (m_state.room_visit()->room == id || m_state.room_visit()->source_room == id ||
                     (m_state.room_visit()->entry_exit &&
                      m_state.room_visit()->entry_exit->room == id)))
                    return true;
                const auto presentation_owner_uses_room = [&](const auto& value) {
                    return presentation_owner_references(value.owner, id);
                };
                if (std::any_of(m_state.m_background_overrides.begin(),
                                m_state.m_background_overrides.end(),
                                presentation_owner_uses_room) ||
                    std::any_of(m_state.m_actors.begin(), m_state.m_actors.end(),
                                presentation_owner_uses_room) ||
                    std::any_of(m_state.m_presentation_props.begin(),
                                m_state.m_presentation_props.end(), presentation_owner_uses_room) ||
                    std::any_of(m_state.m_presentation_environments.begin(),
                                m_state.m_presentation_environments.end(),
                                presentation_owner_uses_room) ||
                    std::any_of(m_state.m_mounted_layouts.begin(), m_state.m_mounted_layouts.end(),
                                presentation_owner_uses_room) ||
                    std::any_of(m_state.m_desired_audio.begin(), m_state.m_desired_audio.end(),
                                presentation_owner_uses_room))
                    return true;
                if (std::any_of(m_state.m_presentation_props.begin(),
                                m_state.m_presentation_props.end(), [&](const auto& value) {
                                    return value.placement && value.placement->room == id;
                                }))
                    return true;
                for (const auto& character : m_state.m_character_world)
                    if (const auto* location =
                            std::get_if<core::compiled::RoomLocation>(&character.location);
                        location != nullptr && location->room == id)
                        return true;
                for (const auto& interactable : m_state.m_interactables) {
                    if (const auto* location =
                            std::get_if<core::compiled::RoomLocation>(&interactable.location);
                        location != nullptr && location->room == id)
                        return true;
                    const auto* inventory =
                        std::get_if<core::compiled::InventoryLocation>(&interactable.location);
                    if (inventory != nullptr &&
                        std::visit(
                            [&](const auto& owner) {
                                using O = std::decay_t<decltype(owner)>;
                                if constexpr (std::is_same_v<O, core::RoomFeatureRef>)
                                    return owner.room == id;
                                else
                                    return false;
                            },
                            inventory->inventory.owner))
                        return true;
                }
                for (const auto& room : m_state.m_runtime_rooms)
                    if (room.id != id &&
                        std::any_of(room.effective_configuration().exits.begin(),
                                    room.effective_configuration().exits.end(),
                                    [&](const auto& value) { return value.target == id; }))
                        return true;
            } else if constexpr (std::is_same_v<T, core::CharacterId>) {
                if ((m_state.m_presented_text && m_state.m_presented_text->speaker == id) ||
                    std::any_of(m_state.m_text_log.begin(), m_state.m_text_log.end(),
                                [&](const auto& entry) { return entry.speaker == id; }))
                    return true;
                for (const auto& interactable : m_state.m_interactables) {
                    const auto* location =
                        std::get_if<core::compiled::InventoryLocation>(&interactable.location);
                    if (location != nullptr &&
                        std::visit(
                            [&](const auto& owner) {
                                using O = std::decay_t<decltype(owner)>;
                                if constexpr (std::is_same_v<
                                                  O, core::compiled::CharacterInventoryOwner>)
                                    return owner.character == id;
                                else
                                    return false;
                            },
                            location->inventory.owner))
                        return true;
                }
                for (const auto& room : m_state.m_runtime_rooms)
                    if (std::any_of(room.effective_configuration().cast.begin(),
                                    room.effective_configuration().cast.end(),
                                    [&](const auto& value) { return value.character == id; }))
                        return true;
                if (std::any_of(m_state.actors().begin(), m_state.actors().end(),
                                [&](const auto& value) { return value.character == id; }))
                    return true;
            } else {
                for (const auto& room : m_state.m_runtime_rooms)
                    if (std::any_of(room.effective_configuration().interactables.begin(),
                                    room.effective_configuration().interactables.end(),
                                    [&](const auto& value) { return value.interactable == id; }))
                        return true;
                for (const auto& interactable : m_state.m_interactables) {
                    const auto* location =
                        std::get_if<core::compiled::InventoryLocation>(&interactable.location);
                    if (location == nullptr)
                        continue;
                    const bool owned = std::visit(
                        [&](const auto& owner) {
                            using O = std::decay_t<decltype(owner)>;
                            if constexpr (std::is_same_v<
                                              O, core::compiled::InteractableInventoryOwner>)
                                return owner.interactable == id;
                            else if constexpr (std::is_same_v<O, core::InteractableFeatureRef>)
                                return owner.interactable == id;
                            else
                                return false;
                        },
                        location->inventory.owner);
                    if (owned)
                        return true;
                }
            }
            return false;
        },
        instance);
    if (dependent)
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.instance_has_dependents",
                        "Gameplay Instance cannot be destroyed while dependent or "
                        "lifecycle-critical references remain"));

    std::visit(
        [&](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, core::RoomId>) {
                m_state.m_runtime_rooms.erase(
                    std::remove_if(m_state.m_runtime_rooms.begin(), m_state.m_runtime_rooms.end(),
                                   [&](const auto& value) { return value.id == id; }),
                    m_state.m_runtime_rooms.end());
                m_state.m_room_visits.erase(id);
            } else if constexpr (std::is_same_v<T, core::CharacterId>) {
                m_state.m_runtime_characters.erase(
                    std::remove_if(m_state.m_runtime_characters.begin(),
                                   m_state.m_runtime_characters.end(),
                                   [&](const auto& value) { return value.id == id; }),
                    m_state.m_runtime_characters.end());
                m_state.m_character_world.erase(
                    std::remove_if(m_state.m_character_world.begin(),
                                   m_state.m_character_world.end(),
                                   [&](const auto& value) { return value.character == id; }),
                    m_state.m_character_world.end());
            } else {
                m_state.m_runtime_interactables.erase(
                    std::remove_if(m_state.m_runtime_interactables.begin(),
                                   m_state.m_runtime_interactables.end(),
                                   [&](const auto& value) { return value.id == id; }),
                    m_state.m_runtime_interactables.end());
                m_state.m_interactables.erase(
                    std::remove_if(m_state.m_interactables.begin(), m_state.m_interactables.end(),
                                   [&](const auto& value) { return value.interactable == id; }),
                    m_state.m_interactables.end());
            }
        },
        instance);
    m_state.m_property_overrides.erase(
        std::remove_if(
            m_state.m_property_overrides.begin(), m_state.m_property_overrides.end(),
            [&](const auto& value) { return property_target_owned_by(value.target(), instance); }),
        m_state.m_property_overrides.end());
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<core::PropertyLookupResult, core::Diagnostics>
RuntimeWorld::resolve_property(const core::RoomId& id, const core::PropertyId& property) const
{
    core::PropertyResolver resolver(m_project, m_state);
    return resolver.get(core::PropertyOwnerRef{id}, property);
}

core::Result<core::PropertyLookupResult, core::Diagnostics>
RuntimeWorld::resolve_property(const core::CharacterId& id, const core::PropertyId& property) const
{
    core::PropertyResolver resolver(m_project, m_state);
    return resolver.get(core::PropertyOwnerRef{id}, property);
}

core::Result<core::PropertyLookupResult, core::Diagnostics>
RuntimeWorld::resolve_property(const core::InteractableInstanceId& id,
                               const core::PropertyId& property) const
{
    core::PropertyResolver resolver(m_project, m_state);
    return resolver.get(core::PropertyOwnerRef{id}, property);
}

const core::CharacterWorldState*
RuntimeWorld::character_state(const core::CharacterId& id) const noexcept
{
    const auto found =
        std::find_if(m_state.m_character_world.begin(), m_state.m_character_world.end(),
                     [&](const auto& value) { return value.character == id; });
    return found == m_state.m_character_world.end() ? nullptr : &*found;
}

const core::InteractableState*
RuntimeWorld::interactable_state(const core::InteractableInstanceId& id) const noexcept
{
    const auto found = std::find_if(m_state.m_interactables.begin(), m_state.m_interactables.end(),
                                    [&](const auto& value) { return value.interactable == id; });
    return found == m_state.m_interactables.end() ? nullptr : &*found;
}

bool RuntimeWorld::has_room_placement(
    const core::compiled::RoomPlacementRef& placement) const noexcept
{
    const auto* definition = resolved_configuration(placement.room);
    return definition != nullptr &&
           std::any_of(definition->placements.begin(), definition->placements.end(),
                       [&placement](const core::compiled::RoomPlacement& candidate) {
                           return candidate.id == placement.placement_id;
                       });
}

bool RuntimeWorld::has_inventory(const core::compiled::InventoryRef& inventory) const noexcept
{
    return std::visit(
        [&](const auto& owner) {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, core::compiled::ProjectInventoryOwner>)
                return has_inventory_id(m_project.inventories(), inventory.inventory_id);
            else if constexpr (std::is_same_v<T, core::compiled::CharacterInventoryOwner>) {
                const auto* definition = resolved_configuration(owner.character);
                return definition != nullptr &&
                       has_inventory_id(definition->inventories, inventory.inventory_id);
            } else if constexpr (std::is_same_v<T, core::compiled::InteractableInventoryOwner>) {
                const auto* definition = resolved_configuration(owner.interactable);
                return definition != nullptr &&
                       has_inventory_id(definition->inventories, inventory.inventory_id);
            } else if constexpr (std::is_same_v<T, core::RoomFeatureRef>) {
                const auto* definition = resolved_configuration(owner.room);
                if (definition == nullptr)
                    return false;
                const auto feature = std::find_if(
                    definition->features.begin(), definition->features.end(),
                    [&](const auto& value) { return value.identity.id == owner.feature_id; });
                return feature != definition->features.end() &&
                       has_inventory_id(feature->inventories, inventory.inventory_id);
            } else {
                const auto* definition = resolved_configuration(owner.interactable);
                if (definition == nullptr)
                    return false;
                const auto feature = std::find_if(
                    definition->features.begin(), definition->features.end(),
                    [&](const auto& value) { return value.identity.id == owner.feature_id; });
                return feature != definition->features.end() &&
                       has_inventory_id(feature->inventories, inventory.inventory_id);
            }
        },
        inventory.owner);
}

std::optional<core::RoomId> RuntimeWorld::effective_room(const core::CharacterId& id) const noexcept
{
    const auto* state = character_state(id);
    if (state == nullptr)
        return std::nullopt;
    if (const auto* room = std::get_if<core::compiled::RoomLocation>(&state->location))
        return room->room;
    return std::nullopt;
}

std::optional<core::RoomId>
RuntimeWorld::effective_room(const core::InteractableInstanceId& id) const noexcept
{
    core::InteractableInstanceId current = id;
    for (std::size_t depth = 0; depth <= m_state.m_interactables.size(); ++depth) {
        const auto* state = interactable_state(current);
        if (state == nullptr)
            return std::nullopt;
        if (const auto* room = std::get_if<core::compiled::RoomLocation>(&state->location))
            return room->room;
        const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&state->location);
        if (inventory == nullptr)
            return std::nullopt;
        std::optional<core::RoomId> direct_room;
        std::optional<core::InteractableInstanceId> next_interactable;
        std::visit(
            [&](const auto& owner) {
                using T = std::decay_t<decltype(owner)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInventoryOwner>)
                    direct_room = effective_room(owner.character);
                else if constexpr (std::is_same_v<T, core::compiled::InteractableInventoryOwner>)
                    next_interactable = owner.interactable;
                else if constexpr (std::is_same_v<T, core::RoomFeatureRef>)
                    direct_room = owner.room;
                else if constexpr (std::is_same_v<T, core::InteractableFeatureRef>)
                    next_interactable = owner.interactable;
            },
            inventory->inventory.owner);
        if (direct_room)
            return direct_room;
        if (!next_interactable)
            return std::nullopt;
        current = *next_interactable;
    }
    return std::nullopt;
}

std::vector<core::InteractableInstanceId>
RuntimeWorld::inventory_members(const core::compiled::InventoryRef& inventory) const
{
    std::vector<core::InteractableInstanceId> members;
    for (const auto& state : m_state.m_interactables) {
        const auto* location = std::get_if<core::compiled::InventoryLocation>(&state.location);
        if (location != nullptr && location->inventory == inventory)
            members.push_back(state.interactable);
    }
    return members;
}

const core::ItemStackState* RuntimeWorld::item_stack(const core::ItemStackId& id) const noexcept
{
    return find_record(m_state.m_item_stacks, id);
}

std::vector<core::ItemStackId>
RuntimeWorld::item_stack_inventory_members(const core::compiled::InventoryRef& inventory) const
{
    std::vector<core::ItemStackId> members;
    for (const auto& stack : m_state.m_item_stacks) {
        const auto* location = std::get_if<core::compiled::InventoryLocation>(&stack.location);
        if (location != nullptr && location->inventory == inventory)
            members.push_back(stack.id);
    }
    std::ranges::sort(members, {}, [](const auto& id) { return id.text(); });
    return members;
}

std::optional<core::RoomId> RuntimeWorld::effective_room(const core::ItemStackId& id) const noexcept
{
    const auto* stack = item_stack(id);
    if (stack == nullptr)
        return std::nullopt;
    if (const auto* room = std::get_if<core::compiled::RoomLocation>(&stack->location))
        return room->room;
    const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&stack->location);
    if (inventory == nullptr)
        return std::nullopt;
    return std::visit(
        [&](const auto& owner) -> std::optional<core::RoomId> {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, core::compiled::CharacterInventoryOwner>)
                return effective_room(owner.character);
            else if constexpr (std::is_same_v<T, core::compiled::InteractableInventoryOwner>)
                return effective_room(owner.interactable);
            else if constexpr (std::is_same_v<T, core::RoomFeatureRef>)
                return owner.room;
            else if constexpr (std::is_same_v<T, core::InteractableFeatureRef>)
                return effective_room(owner.interactable);
            else
                return std::nullopt;
        },
        inventory->inventory.owner);
}

core::Result<core::ItemStackId, core::Diagnostics> RuntimeWorld::allocate_item_stack_id()
{
    for (;;) {
        const auto ordinal = m_state.m_next_item_stack_id;
        if (ordinal == std::numeric_limits<std::uint64_t>::max())
            return core::Result<core::ItemStackId, core::Diagnostics>::failure(
                world_error("runtime.item_stack_identity_exhausted",
                            "Item Stack identity allocator is exhausted"));
        auto candidate = core::ItemStackId::create("runtime-item-stack-" + std::to_string(ordinal));
        if (!candidate)
            return core::Result<core::ItemStackId, core::Diagnostics>::failure(candidate.error());
        ++m_state.m_next_item_stack_id;
        const auto* id = candidate.value_if();
        if (id != nullptr && item_stack(*id) == nullptr)
            return core::Result<core::ItemStackId, core::Diagnostics>::success(*id);
    }
}

bool RuntimeWorld::item_stack_compatible(const core::ItemStackState& left,
                                         const core::ItemStackState& right) const
{
    return left.definition == right.definition;
}

void RuntimeWorld::erase_item_stack(const core::ItemStackId& id)
{
    m_state.m_item_stacks.erase(std::remove_if(m_state.m_item_stacks.begin(),
                                               m_state.m_item_stacks.end(),
                                               [&](const auto& stack) { return stack.id == id; }),
                                m_state.m_item_stacks.end());
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeWorld::split_item_stack(const core::ItemStackId& source, std::uint64_t quantity)
{
    auto* stack = find_record(m_state.m_item_stacks, source);
    if (stack == nullptr)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(
            world_error("runtime.stale_item_stack", "Item Stack identity is not live"));
    if (quantity == 0 || quantity >= stack->quantity)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(
            world_error("runtime.invalid_item_stack_quantity",
                        "Split quantity must be positive and smaller than the source Stack"));
    auto allocated = allocate_item_stack_id();
    if (!allocated)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(allocated.error());
    const auto id = *allocated.value_if();
    const auto definition = stack->definition;
    const auto location = stack->location;
    const auto traits = stack->traits;
    stack->quantity -= quantity;
    m_state.m_item_stacks.push_back(
        core::ItemStackState{id, definition, quantity, location, traits, false});
    ItemStackMutation result{quantity, {source, id}, {source}, {id}, {}};
    std::ranges::sort(result.surviving, {}, [](const auto& value) { return value.text(); });
    return core::Result<ItemStackMutation, core::Diagnostics>::success(std::move(result));
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeWorld::merge_item_stacks(const core::ItemStackId& receiver, const core::ItemStackId& donor)
{
    auto* target = find_record(m_state.m_item_stacks, receiver);
    const auto* source = item_stack(donor);
    if (target == nullptr || source == nullptr || receiver == donor)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(world_error(
            "runtime.stale_item_stack", "Merge requires two distinct live Item Stacks"));
    const auto* definition = m_project.find_item_definition(target->definition);
    const auto limit = definition && definition->stack_limit
                           ? *definition->stack_limit
                           : core::compiled::max_item_stack_quantity;
    if (target->location != source->location || !item_stack_compatible(*target, *source) ||
        source->quantity > limit - target->quantity)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(
            world_error("runtime.incompatible_item_stacks",
                        "Item Stacks are incompatible or exceed the Stack limit"));
    const auto moved = source->quantity;
    target->quantity += moved;
    erase_item_stack(donor);
    return core::Result<ItemStackMutation, core::Diagnostics>::success(
        ItemStackMutation{moved, {receiver}, {receiver}, {}, {donor}});
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeWorld::transfer_item_quantity(const core::ItemStackId& source_id, std::uint64_t quantity,
                                     core::compiled::ItemStackLocation location,
                                     ItemStackPlacementPolicy policy)
{
    auto* source = find_record(m_state.m_item_stacks, source_id);
    const bool location_valid =
        std::holds_alternative<core::compiled::UnplacedLocation>(location) ||
        (std::get_if<core::compiled::RoomLocation>(&location) != nullptr &&
         resolved_configuration(std::get<core::compiled::RoomLocation>(location).room) !=
             nullptr) ||
        (std::get_if<core::compiled::InventoryLocation>(&location) != nullptr &&
         has_inventory(std::get<core::compiled::InventoryLocation>(location).inventory));
    if (source == nullptr)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(
            world_error("runtime.stale_item_stack", "Item Stack identity is not live"));
    if (quantity == 0 || quantity > source->quantity || !location_valid)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(
            world_error("runtime.invalid_item_stack_transfer",
                        "Transfer quantity or target Location is invalid"));
    if (source->location == location)
        return core::Result<ItemStackMutation, core::Diagnostics>::success(
            ItemStackMutation{quantity, {source_id}, {}, {}, {}});

    const auto saved_stacks = m_state.m_item_stacks;
    const auto saved_overrides = m_state.m_property_overrides;
    const auto saved_allocator = m_state.m_next_item_stack_id;
    const auto definition_id = source->definition;
    const auto traits = source->traits;
    const auto* definition = m_project.find_item_definition(definition_id);
    const auto limit = definition && definition->stack_limit
                           ? *definition->stack_limit
                           : core::compiled::max_item_stack_quantity;
    ItemStackMutation result{quantity, {}, {}, {}, {}};
    std::uint64_t remaining = quantity;

    if (policy == ItemStackPlacementPolicy::Coalesce) {
        std::vector<core::ItemStackId> candidates;
        for (const auto& candidate : m_state.m_item_stacks) {
            if (candidate.id != source_id && candidate.location == location &&
                item_stack_compatible(*source, candidate) && candidate.quantity < limit)
                candidates.push_back(candidate.id);
        }
        std::ranges::sort(candidates, {}, [](const auto& id) { return id.text(); });
        for (const auto& candidate_id : candidates) {
            auto* current_source = find_record(m_state.m_item_stacks, source_id);
            auto* candidate = find_record(m_state.m_item_stacks, candidate_id);
            const auto moved =
                std::min({remaining, current_source->quantity, limit - candidate->quantity});
            current_source->quantity -= moved;
            candidate->quantity += moved;
            remaining -= moved;
            if (moved != 0) {
                result.surviving.push_back(candidate_id);
                result.changed.push_back(candidate_id);
            }
            if (remaining == 0)
                break;
        }
    }

    source = find_record(m_state.m_item_stacks, source_id);
    if (remaining != 0) {
        if (remaining == source->quantity) {
            source->location = std::move(location);
            result.surviving.push_back(source_id);
            remaining = 0;
        } else {
            auto allocated = allocate_item_stack_id();
            if (!allocated) {
                m_state.m_item_stacks = saved_stacks;
                m_state.m_property_overrides = saved_overrides;
                m_state.m_next_item_stack_id = saved_allocator;
                return core::Result<ItemStackMutation, core::Diagnostics>::failure(
                    allocated.error());
            }
            const auto new_id = *allocated.value_if();
            source = find_record(m_state.m_item_stacks, source_id);
            source->quantity -= remaining;
            m_state.m_item_stacks.push_back(core::ItemStackState{
                new_id, definition_id, remaining, std::move(location), traits, false});
            result.created.push_back(new_id);
            result.surviving.push_back(new_id);
            remaining = 0;
        }
    }
    source = find_record(m_state.m_item_stacks, source_id);
    if (source != nullptr && source->quantity == 0) {
        erase_item_stack(source_id);
        result.ended.push_back(source_id);
    } else if (source != nullptr &&
               std::ranges::find(result.surviving, source_id) == result.surviving.end()) {
        result.surviving.push_back(source_id);
    }
    if (source != nullptr)
        result.changed.push_back(source_id);
    std::ranges::sort(result.surviving, {}, [](const auto& id) { return id.text(); });
    std::ranges::sort(result.changed, {}, [](const auto& id) { return id.text(); });
    return core::Result<ItemStackMutation, core::Diagnostics>::success(std::move(result));
}

core::Result<ItemStackMutation, core::Diagnostics> RuntimeWorld::grant_item_quantity(
    const core::ItemDefinitionId& definition_id, std::uint64_t quantity,
    core::compiled::ItemStackLocation location, ItemStackPlacementPolicy policy)
{
    const auto* definition = m_project.find_item_definition(definition_id);
    const bool location_valid =
        std::holds_alternative<core::compiled::UnplacedLocation>(location) ||
        (std::get_if<core::compiled::RoomLocation>(&location) != nullptr &&
         resolved_configuration(std::get<core::compiled::RoomLocation>(location).room) !=
             nullptr) ||
        (std::get_if<core::compiled::InventoryLocation>(&location) != nullptr &&
         has_inventory(std::get<core::compiled::InventoryLocation>(location).inventory));
    if (definition == nullptr || quantity == 0 ||
        quantity > core::compiled::max_item_stack_quantity || !location_valid)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(
            world_error("runtime.invalid_item_stack_grant",
                        "Grant definition, quantity, or Location is invalid"));
    const auto saved_stacks = m_state.m_item_stacks;
    const auto saved_allocator = m_state.m_next_item_stack_id;
    const auto limit = definition->stack_limit.value_or(core::compiled::max_item_stack_quantity);
    const std::vector<core::TraitId> traits;
    ItemStackMutation result{quantity, {}, {}, {}, {}};
    std::uint64_t remaining = quantity;

    if (policy == ItemStackPlacementPolicy::Coalesce) {
        std::vector<core::ItemStackId> candidates;
        for (const auto& candidate : m_state.m_item_stacks) {
            if (candidate.definition == definition_id && candidate.location == location &&
                candidate.traits.empty() && candidate.quantity < limit)
                candidates.push_back(candidate.id);
        }
        std::ranges::sort(candidates, {}, [](const auto& id) { return id.text(); });
        for (const auto& candidate_id : candidates) {
            auto* candidate = find_record(m_state.m_item_stacks, candidate_id);
            const auto moved = std::min(remaining, limit - candidate->quantity);
            candidate->quantity += moved;
            remaining -= moved;
            if (moved != 0) {
                result.surviving.push_back(candidate_id);
                result.changed.push_back(candidate_id);
            }
            if (remaining == 0)
                break;
        }
    }
    while (remaining != 0) {
        auto allocated = allocate_item_stack_id();
        if (!allocated) {
            m_state.m_item_stacks = saved_stacks;
            m_state.m_next_item_stack_id = saved_allocator;
            return core::Result<ItemStackMutation, core::Diagnostics>::failure(allocated.error());
        }
        const auto granted = std::min(remaining, limit);
        const auto new_id = *allocated.value_if();
        m_state.m_item_stacks.push_back(
            core::ItemStackState{new_id, definition_id, granted, location, traits, false});
        result.created.push_back(new_id);
        result.surviving.push_back(new_id);
        remaining -= granted;
    }
    return core::Result<ItemStackMutation, core::Diagnostics>::success(std::move(result));
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeWorld::consume_item_quantity(const core::ItemStackId& id, std::uint64_t quantity)
{
    auto* stack = find_record(m_state.m_item_stacks, id);
    if (stack == nullptr)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(
            world_error("runtime.stale_item_stack", "Item Stack identity is not live"));
    if (quantity == 0 || quantity > stack->quantity)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(world_error(
            "runtime.invalid_item_stack_quantity", "Consume quantity exceeds the live Item Stack"));
    if (quantity == stack->quantity) {
        erase_item_stack(id);
        return core::Result<ItemStackMutation, core::Diagnostics>::success(
            ItemStackMutation{quantity, {}, {}, {}, {id}});
    }
    stack->quantity -= quantity;
    return core::Result<ItemStackMutation, core::Diagnostics>::success(
        ItemStackMutation{quantity, {id}, {id}, {}, {}});
}

bool RuntimeWorld::item_stack_matches(const core::ItemStackState& stack,
                                      const ItemStackFilter& filter) const
{
    if ((filter.definition && stack.definition != *filter.definition) ||
        (filter.location && stack.location != *filter.location))
        return false;
    return stack.traits.empty();
}

core::Result<std::uint64_t, core::Diagnostics>
RuntimeWorld::aggregate_item_quantity(const ItemStackFilter& filter) const
{
    std::uint64_t quantity = 0;
    for (const auto& stack : m_state.m_item_stacks) {
        if (!item_stack_matches(stack, filter))
            continue;
        if (stack.quantity > core::compiled::max_item_stack_quantity - quantity)
            return core::Result<std::uint64_t, core::Diagnostics>::failure(
                world_error("runtime.item_stack_quantity_overflow",
                            "Aggregate Item Stack quantity exceeds the portable range"));
        quantity += stack.quantity;
    }
    return core::Result<std::uint64_t, core::Diagnostics>::success(quantity);
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeWorld::consume_item_quantity(const ItemStackFilter& filter, std::uint64_t quantity)
{
    if (quantity == 0)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(world_error(
            "runtime.invalid_item_stack_quantity", "Consume quantity must be positive"));
    const auto available = aggregate_item_quantity(filter);
    if (!available)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(available.error());
    if (*available.value_if() < quantity)
        return core::Result<ItemStackMutation, core::Diagnostics>::failure(
            world_error("runtime.insufficient_item_quantity",
                        "Matching Item Stacks do not contain the requested quantity"));
    std::vector<core::ItemStackId> matches;
    for (const auto& stack : m_state.m_item_stacks) {
        if (item_stack_matches(stack, filter))
            matches.push_back(stack.id);
    }
    std::ranges::sort(matches, {}, [](const auto& id) { return id.text(); });
    ItemStackMutation result{quantity, {}, {}, {}, {}};
    auto remaining = quantity;
    for (const auto& id : matches) {
        const auto* stack = item_stack(id);
        const auto consumed = std::min(remaining, stack->quantity);
        auto mutation = consume_item_quantity(id, consumed);
        if (!mutation)
            return mutation;
        const auto* applied = mutation.value_if();
        result.surviving.insert(result.surviving.end(), applied->surviving.begin(),
                                applied->surviving.end());
        result.changed.insert(result.changed.end(), applied->changed.begin(),
                              applied->changed.end());
        result.ended.insert(result.ended.end(), applied->ended.begin(), applied->ended.end());
        remaining -= consumed;
        if (remaining == 0)
            break;
    }
    return core::Result<ItemStackMutation, core::Diagnostics>::success(std::move(result));
}

core::Result<void, core::Diagnostics>
RuntimeWorld::move_character(const core::CharacterId& id, core::CharacterWorldLocation location)
{
    auto found = std::find_if(m_state.m_character_world.begin(), m_state.m_character_world.end(),
                              [&](const auto& value) { return value.character == id; });
    if (found == m_state.m_character_world.end())
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.unknown_character", "Character Gameplay Instance is not live"));
    if (const auto* room = std::get_if<core::compiled::RoomLocation>(&location);
        room != nullptr && resolved_configuration(room->room) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.invalid_character_location", "Character Room Location is unresolved"));
    found->location = std::move(location);
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::set_character_enabled(const core::CharacterId& id, bool enabled)
{
    auto found = std::find_if(m_state.m_character_world.begin(), m_state.m_character_world.end(),
                              [&](const auto& value) { return value.character == id; });
    if (found == m_state.m_character_world.end())
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.unknown_character", "Character Gameplay Instance is not live"));
    found->enabled = enabled;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::set_character_visible(const core::CharacterId& id, bool visible)
{
    auto found = std::find_if(m_state.m_character_world.begin(), m_state.m_character_world.end(),
                              [&](const auto& value) { return value.character == id; });
    if (found == m_state.m_character_world.end())
        return core::Result<void, core::Diagnostics>::failure(
            world_error("runtime.unknown_character", "Character Gameplay Instance is not live"));
    found->visible = visible;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::move_interactable(const core::InteractableInstanceId& id,
                                core::compiled::InteractableLocation location)
{
    auto found = std::find_if(m_state.m_interactables.begin(), m_state.m_interactables.end(),
                              [&](const auto& value) { return value.interactable == id; });
    if (found == m_state.m_interactables.end())
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.unknown_interactable", "Interactable Gameplay Instance is not live"));
    if (const auto* room = std::get_if<core::compiled::RoomLocation>(&location);
        room != nullptr && resolved_configuration(room->room) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.invalid_interactable_location", "Interactable Room Location is unresolved"));
    if (const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&location)) {
        if (!has_inventory(inventory->inventory))
            return core::Result<void, core::Diagnostics>::failure(
                world_error("runtime.invalid_interactable_location",
                            "Interactable Inventory Location is unresolved"));
        std::vector<core::InteractableInstanceId> visited{id};
        auto owner = inventory_interactable_owner(inventory->inventory);
        while (owner) {
            if (std::find(visited.begin(), visited.end(), *owner) != visited.end())
                return core::Result<void, core::Diagnostics>::failure(world_error(
                    "runtime.inventory_cycle", "Inventory containment must be acyclic"));
            visited.push_back(*owner);
            const auto* owner_state = interactable_state(*owner);
            if (owner_state == nullptr)
                return core::Result<void, core::Diagnostics>::failure(
                    world_error("runtime.invalid_inventory_owner",
                                "Inventory owner has no live Interactable state"));
            const auto* owner_inventory =
                std::get_if<core::compiled::InventoryLocation>(&owner_state->location);
            owner = owner_inventory ? inventory_interactable_owner(owner_inventory->inventory)
                                    : std::nullopt;
        }
    }
    found->location = std::move(location);
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::set_interactable_enabled(const core::InteractableInstanceId& id, bool enabled)
{
    auto found = std::find_if(m_state.m_interactables.begin(), m_state.m_interactables.end(),
                              [&](const auto& value) { return value.interactable == id; });
    if (found == m_state.m_interactables.end())
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.unknown_interactable", "Interactable Gameplay Instance is not live"));
    found->enabled = enabled;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::set_interactable_visible(const core::InteractableInstanceId& id, bool visible)
{
    auto found = std::find_if(m_state.m_interactables.begin(), m_state.m_interactables.end(),
                              [&](const auto& value) { return value.interactable == id; });
    if (found == m_state.m_interactables.end())
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.unknown_interactable", "Interactable Gameplay Instance is not live"));
    found->visible = visible;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeWorld::commit_room_navigation(const core::RoomPresentationResolution& target)
{
    if (resolved_configuration(target.view.room) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(world_error(
            "runtime.unknown_room", "Navigation target Room Gameplay Instance is not live"));
    return m_state.commit_room_navigation(m_project, target);
}

} // namespace noveltea::runtime
