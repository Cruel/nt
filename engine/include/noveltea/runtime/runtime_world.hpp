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
    resolved_configuration(const core::InteractableId& id) const noexcept;
    [[nodiscard]] const core::RuntimeInstanceProvenance*
    provenance(const core::GameplayInstanceRef& instance) const noexcept;
    [[nodiscard]] bool runtime_created(const core::GameplayInstanceRef& instance) const noexcept;

    [[nodiscard]] core::Result<core::RoomId, core::Diagnostics>
    create_room(RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<core::CharacterId, core::Diagnostics>
    create_character(RuntimeInstanceConfigurationRequest source,
                     core::CharacterWorldLocation location = core::compiled::UnplacedLocation{},
                     bool enabled = true, bool visible = true);
    [[nodiscard]] core::Result<core::InteractableId, core::Diagnostics> create_interactable(
        RuntimeInstanceConfigurationRequest source,
        core::compiled::InteractableLocation location = core::compiled::UnplacedLocation{},
        bool enabled = true, bool visible = true);

    [[nodiscard]] core::Result<void, core::Diagnostics>
    replace_structural_configuration(const core::RoomId& id,
                                     RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    replace_structural_configuration(const core::CharacterId& id,
                                     RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    replace_structural_configuration(const core::InteractableId& id,
                                     RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_structural_configuration(const core::RoomId& id);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_structural_configuration(const core::CharacterId& id);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_structural_configuration(const core::InteractableId& id);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    retarget_room_exit(const core::RoomId& room, const core::RoomExitId& exit,
                       const core::RoomId& target);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    destroy(const core::GameplayInstanceRef& instance);

    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    resolve_property(const core::RoomId& id, const core::PropertyId& property) const;
    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    resolve_property(const core::CharacterId& id, const core::PropertyId& property) const;
    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    resolve_property(const core::InteractableId& id, const core::PropertyId& property) const;

    [[nodiscard]] const core::CharacterWorldState*
    character_state(const core::CharacterId& id) const noexcept;
    [[nodiscard]] const core::InteractableState*
    interactable_state(const core::InteractableId& id) const noexcept;
    [[nodiscard]] bool
    has_room_placement(const core::compiled::RoomPlacementRef& placement) const noexcept;
    [[nodiscard]] bool has_inventory(const core::compiled::InventoryRef& inventory) const noexcept;
    [[nodiscard]] std::optional<core::RoomId>
    effective_room(const core::CharacterId& id) const noexcept;
    [[nodiscard]] std::optional<core::RoomId>
    effective_room(const core::InteractableId& id) const noexcept;
    [[nodiscard]] std::vector<core::InteractableId>
    inventory_members(const core::compiled::InventoryRef& inventory) const;

    [[nodiscard]] core::Result<void, core::Diagnostics>
    move_character(const core::CharacterId& id, core::CharacterWorldLocation location);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_character_enabled(const core::CharacterId& id, bool enabled);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_character_visible(const core::CharacterId& id, bool visible);

    [[nodiscard]] core::Result<void, core::Diagnostics>
    move_interactable(const core::InteractableId& id,
                      core::compiled::InteractableLocation location);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_interactable_enabled(const core::InteractableId& id, bool enabled);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_interactable_visible(const core::InteractableId& id, bool visible);

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
        const core::InteractableId& id,
        const core::compiled::InteractableDefinition& configuration) const;

    const core::CompiledProject& m_project;
    core::SessionState& m_state;
};

} // namespace noveltea::runtime
