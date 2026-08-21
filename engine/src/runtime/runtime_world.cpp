#include "noveltea/runtime/runtime_world.hpp"

#include <algorithm>
#include <utility>

namespace noveltea::runtime {

const core::compiled::RoomDefinition* RuntimeWorld::room(const core::RoomId& id) const noexcept
{
    return m_project.find_room(id);
}

const core::compiled::CharacterDefinition*
RuntimeWorld::character(const core::CharacterId& id) const noexcept
{
    return m_project.find_character(id);
}

const core::compiled::InteractableDefinition*
RuntimeWorld::interactable(const core::InteractableId& id) const noexcept
{
    return m_project.find_interactable(id);
}

const core::CharacterWorldState*
RuntimeWorld::character_state(const core::CharacterId& id) const noexcept
{
    return character(id) == nullptr ? nullptr : m_state.character_world(id);
}

const core::InteractableState*
RuntimeWorld::interactable_state(const core::InteractableId& id) const noexcept
{
    return interactable(id) == nullptr ? nullptr : m_state.interactable(id);
}

bool RuntimeWorld::has_room_placement(
    const core::compiled::RoomPlacementRef& placement) const noexcept
{
    const auto* definition = room(placement.room);
    return definition != nullptr &&
           std::any_of(definition->placements.begin(), definition->placements.end(),
                       [&placement](const core::compiled::RoomPlacement& candidate) {
                           return candidate.id == placement.placement_id;
                       });
}

core::Result<void, core::Diagnostics>
RuntimeWorld::move_character(const core::CharacterId& id, core::CharacterWorldLocation location)
{
    return m_state.move_character(m_project, id, std::move(location));
}

core::Result<void, core::Diagnostics>
RuntimeWorld::set_character_enabled(const core::CharacterId& id, bool enabled)
{
    return m_state.set_character_enabled(m_project, id, enabled);
}

core::Result<void, core::Diagnostics>
RuntimeWorld::set_character_visible(const core::CharacterId& id, bool visible)
{
    return m_state.set_character_visible(m_project, id, visible);
}

core::Result<void, core::Diagnostics>
RuntimeWorld::move_interactable(const core::InteractableId& id,
                                core::compiled::InteractableLocation location)
{
    return m_state.move_interactable(m_project, id, std::move(location));
}

core::Result<void, core::Diagnostics>
RuntimeWorld::set_interactable_enabled(const core::InteractableId& id, bool enabled)
{
    return m_state.set_interactable_enabled(m_project, id, enabled);
}

core::Result<void, core::Diagnostics>
RuntimeWorld::set_interactable_visible(const core::InteractableId& id, bool visible)
{
    return m_state.set_interactable_visible(m_project, id, visible);
}

core::Result<void, core::Diagnostics>
RuntimeWorld::commit_room_navigation(const core::RoomPresentationResolution& target)
{
    return m_state.commit_room_navigation(m_project, target);
}

} // namespace noveltea::runtime
