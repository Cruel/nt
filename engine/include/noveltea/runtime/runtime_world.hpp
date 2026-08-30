#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/room_presentation_contracts.hpp"
#include "noveltea/core/session_state.hpp"

namespace noveltea::runtime {

struct ArchetypeInstanceConfiguration {
    core::ArchetypeId archetype;
};
struct CompiledInstanceConfiguration {
    core::GameplayInstanceRef instance;
};
struct EffectiveInstanceConfiguration {
    core::GameplayInstanceRef instance;
};
using RuntimeInstanceConfigurationRequest =
    std::variant<ArchetypeInstanceConfiguration, CompiledInstanceConfiguration,
                 EffectiveInstanceConfiguration>;

struct InteractablePropertyMatch {
    core::PropertyId property;
    core::RuntimeValue value;
};

// Narrow reusable matcher for exact live Interactable Instances. Empty fields mean broad matching;
// populated fields are conjunctive rather than a second recursive boolean expression language.
struct InteractableMatcher {
    std::optional<core::InteractableDefinitionId> definition;
    std::vector<core::TraitId> traits;
    std::vector<InteractablePropertyMatch> properties;
    std::optional<core::InteractableInstanceId> instance;

    InteractableMatcher() = default;
    explicit InteractableMatcher(core::InteractableDefinitionId definition_id)
        : definition(std::move(definition_id))
    {
    }
    explicit InteractableMatcher(std::optional<core::InteractableDefinitionId> definition_id)
        : definition(std::move(definition_id))
    {
    }
};

struct InteractableQuantityFilter {
    InteractableMatcher matcher;
    std::optional<core::compiled::InteractableLocation> location;

    InteractableQuantityFilter() = default;
    InteractableQuantityFilter(std::optional<core::InteractableDefinitionId> definition,
                               std::optional<core::compiled::InteractableLocation> target_location)
        : matcher(std::move(definition)), location(std::move(target_location))
    {
    }
};

struct InteractableQuantityMutation {
    std::uint64_t quantity = 0;
    std::vector<core::InteractableInstanceId> surviving;
    std::vector<core::InteractableInstanceId> changed;
    std::vector<core::InteractableInstanceId> created;
    std::vector<core::InteractableInstanceId> ended;
};

enum class InteractableRoomPresentationPolicy : std::uint8_t {
    Resolve,
    None
};

enum class InteractableRoomPlacementSource : std::uint8_t {
    Dynamic,
    Authored,
    Fallback
};

struct ResolvedInteractableRoomPlacement {
    core::RoomPlacementId placement;
    InteractableRoomPlacementSource source = InteractableRoomPlacementSource::Fallback;
    std::optional<core::RoomInteractableEntryId> authored_occurrence;
};

// Session-scoped semantic lookup and mutation seam for live Gameplay Instances. The world borrows
// immutable Project definitions and the authoritative SessionState; it owns neither.
class RuntimeWorld final {
public:
    RuntimeWorld(const core::CompiledProject& project, core::SessionState& state) noexcept
        : m_project(project), m_state(state)
    {
    }
    RuntimeWorld(const RuntimeWorld&) = delete;
    RuntimeWorld& operator=(const RuntimeWorld&) = delete;

    [[nodiscard]] const core::compiled::RoomDefinition*
    resolved_configuration(const core::RoomId& id) const noexcept;
    [[nodiscard]] const core::compiled::CharacterDefinition*
    resolved_configuration(const core::CharacterId& id) const noexcept;
    [[nodiscard]] const core::compiled::InteractableDefinition*
    resolved_configuration(const core::InteractableInstanceId& id) const noexcept;
    [[nodiscard]] const core::RuntimeInstanceProvenance*
    provenance(const core::GameplayInstanceRef& instance) const noexcept;
    [[nodiscard]] bool runtime_created(const core::GameplayInstanceRef& instance) const noexcept;

    [[nodiscard]] core::Result<core::RoomId, core::Diagnostics>
    create_room(RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<core::CharacterId, core::Diagnostics>
    create_character(RuntimeInstanceConfigurationRequest source,
                     core::CharacterWorldLocation location = core::compiled::UnplacedLocation{},
                     bool enabled = true, bool visible = true);
    [[nodiscard]] core::Result<InteractableQuantityMutation, core::Diagnostics>
    create_interactable_quantity(
        const core::InteractableDefinitionId& definition, std::uint64_t quantity,
        core::compiled::InteractableLocation location = core::compiled::UnplacedLocation{},
        bool enabled = true, bool visible = true,
        InteractableRoomPresentationPolicy presentation =
            InteractableRoomPresentationPolicy::Resolve);

    [[nodiscard]] core::Result<void, core::Diagnostics>
    replace_structural_configuration(const core::RoomId& id,
                                     RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    replace_structural_configuration(const core::CharacterId& id,
                                     RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    replace_structural_configuration(const core::InteractableInstanceId& id,
                                     RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_structural_configuration(const core::RoomId& id);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_structural_configuration(const core::CharacterId& id);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_structural_configuration(const core::InteractableInstanceId& id);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    retarget_room_exit(const core::RoomId& room, const core::RoomExitId& exit,
                       const core::RoomId& target);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    destroy(const core::GameplayInstanceRef& instance);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_trait(const core::PropertyOwnerRef& owner, core::TraitId trait, bool present);

    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    resolve_property(const core::RoomId& id, const core::PropertyId& property) const;
    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    resolve_property(const core::CharacterId& id, const core::PropertyId& property) const;
    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    resolve_property(const core::InteractableInstanceId& id,
                     const core::PropertyId& property) const;
    [[nodiscard]] const core::CharacterWorldState*
    character_state(const core::CharacterId& id) const noexcept;
    [[nodiscard]] const core::InteractableState*
    interactable_state(const core::InteractableInstanceId& id) const noexcept;
    [[nodiscard]] bool
    has_room_placement(const core::compiled::RoomPlacementRef& placement) const noexcept;
    [[nodiscard]] bool has_inventory(const core::compiled::InventoryRef& inventory) const noexcept;
    [[nodiscard]] std::optional<core::RoomId>
    effective_room(const core::CharacterId& id) const noexcept;
    [[nodiscard]] std::optional<core::RoomId>
    effective_room(const core::InteractableInstanceId& id) const noexcept;
    [[nodiscard]] std::vector<core::InteractableInstanceId>
    inventory_members(const core::compiled::InventoryRef& inventory) const;
    [[nodiscard]] bool matches_interactable(const core::InteractableInstanceId& instance,
                                            const InteractableMatcher& matcher) const;
    [[nodiscard]] std::optional<ResolvedInteractableRoomPlacement>
    resolve_interactable_room_placement(const core::InteractableInstanceId& instance,
                                        const core::RoomId& room) const;
    [[nodiscard]] core::Result<InteractableQuantityMutation, core::Diagnostics>
    split_interactable_quantity(const core::InteractableInstanceId& source, std::uint64_t quantity);
    [[nodiscard]] core::Result<InteractableQuantityMutation, core::Diagnostics>
    merge_interactable_quantities(const core::InteractableInstanceId& receiver,
                                  const core::InteractableInstanceId& donor);
    [[nodiscard]] core::Result<InteractableQuantityMutation, core::Diagnostics>
    transfer_interactable_quantity(const core::InteractableInstanceId& source,
                                   std::uint64_t quantity,
                                   core::compiled::InteractableLocation location);
    [[nodiscard]] core::Result<InteractableQuantityMutation, core::Diagnostics>
    transfer_interactable_quantity(const InteractableQuantityFilter& filter, std::uint64_t quantity,
                                   core::compiled::InteractableLocation location);
    [[nodiscard]] core::Result<InteractableQuantityMutation, core::Diagnostics>
    add_interactable_quantity(const core::InteractableDefinitionId& definition,
                              std::uint64_t quantity,
                              core::compiled::InteractableLocation location);
    [[nodiscard]] core::Result<InteractableQuantityMutation, core::Diagnostics>
    consume_interactable_quantity(const core::InteractableInstanceId& instance,
                                  std::uint64_t quantity);
    [[nodiscard]] core::Result<std::uint64_t, core::Diagnostics>
    aggregate_interactable_quantity(const InteractableQuantityFilter& filter) const;
    [[nodiscard]] core::Result<InteractableQuantityMutation, core::Diagnostics>
    consume_interactable_quantity(const InteractableQuantityFilter& filter, std::uint64_t quantity);

    [[nodiscard]] core::Result<void, core::Diagnostics>
    move_character(const core::CharacterId& id, core::CharacterWorldLocation location);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_character_enabled(const core::CharacterId& id, bool enabled);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_character_visible(const core::CharacterId& id, bool visible);

    [[nodiscard]] core::Result<void, core::Diagnostics>
    move_interactable(const core::InteractableInstanceId& id,
                      core::compiled::InteractableLocation location,
                      InteractableRoomPresentationPolicy presentation =
                          InteractableRoomPresentationPolicy::Resolve);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_interactable_enabled(const core::InteractableInstanceId& id, bool enabled);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_interactable_visible(const core::InteractableInstanceId& id, bool visible);

    [[nodiscard]] core::Result<void, core::Diagnostics>
    commit_room_navigation(const core::RoomPresentationResolution& target);

private:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    validate_room_configuration_change(const core::RoomId& id,
                                       const core::compiled::RoomDefinition& configuration) const;
    [[nodiscard]] core::Result<void, core::Diagnostics> validate_character_configuration_change(
        const core::CharacterId& id,
        const core::compiled::CharacterDefinition& configuration) const;
    [[nodiscard]] core::Result<void, core::Diagnostics> validate_interactable_configuration_change(
        const core::InteractableInstanceId& id,
        const core::compiled::InteractableDefinition& configuration) const;
    [[nodiscard]] core::Result<core::InteractableInstanceId, core::Diagnostics>
    allocate_interactable_instance_id();
    [[nodiscard]] bool valid_interactable_location(
        const core::compiled::InteractableLocation& location) const noexcept;
    [[nodiscard]] bool
    interactable_quantity_matches(const core::InteractableState& state,
                                  const InteractableQuantityFilter& filter) const;
    [[nodiscard]] bool
    interactable_quantity_compatible(const core::InteractableInstanceId& left,
                                     const core::InteractableInstanceId& right) const;
    [[nodiscard]] bool default_interactable_quantity_state(
        const core::InteractableInstanceId& id,
        const core::compiled::InteractableDefinition& definition) const;
    [[nodiscard]] core::Result<core::InteractableInstanceId, core::Diagnostics>
    clone_interactable_quantity_instance(const core::InteractableInstanceId& source,
                                         std::uint64_t quantity,
                                         core::compiled::InteractableLocation location);
    void erase_interactable_quantity_instance(const core::InteractableInstanceId& id);
    const core::CompiledProject& m_project;
    core::SessionState& m_state;
};

} // namespace noveltea::runtime
