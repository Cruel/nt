#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/room_presentation_contracts.hpp"
#include "noveltea/core/session_state.hpp"

namespace noveltea::runtime {

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

    [[nodiscard]] const core::compiled::RoomDefinition* room(const core::RoomId& id) const noexcept;
    [[nodiscard]] const core::compiled::CharacterDefinition*
    character(const core::CharacterId& id) const noexcept;
    [[nodiscard]] const core::compiled::InteractableDefinition*
    interactable(const core::InteractableId& id) const noexcept;

    [[nodiscard]] const core::CharacterWorldState*
    character_state(const core::CharacterId& id) const noexcept;
    [[nodiscard]] const core::InteractableState*
    interactable_state(const core::InteractableId& id) const noexcept;
    [[nodiscard]] bool
    has_room_placement(const core::compiled::RoomPlacementRef& placement) const noexcept;

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
    const core::CompiledProject& m_project;
    core::SessionState& m_state;
};

} // namespace noveltea::runtime
