#pragma once

#include "noveltea/core/domain_ids.hpp"

#include <string>
#include <variant>

namespace noveltea::core::compiled {

struct ProjectInventoryOwner {
    bool operator==(const ProjectInventoryOwner&) const = default;
};
struct CharacterInventoryOwner {
    CharacterId character;
    bool operator==(const CharacterInventoryOwner&) const = default;
};
struct InteractableInventoryOwner {
    InteractableInstanceId interactable;
    bool operator==(const InteractableInventoryOwner&) const = default;
};
using InventoryOwnerRef =
    std::variant<ProjectInventoryOwner, CharacterInventoryOwner, InteractableInventoryOwner,
                 RoomFeatureRef, InteractableFeatureRef>;
struct InventoryRef {
    InventoryOwnerRef owner;
    InventoryId inventory_id;
    bool operator==(const InventoryRef&) const = default;
};

[[nodiscard]] inline std::string inventory_ref_key(const InventoryRef& inventory)
{
    std::string prefix = std::visit(
        [](const auto& owner) -> std::string {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, ProjectInventoryOwner>)
                return "project";
            else if constexpr (std::is_same_v<T, CharacterInventoryOwner>)
                return "character:" + owner.character.text();
            else if constexpr (std::is_same_v<T, InteractableInventoryOwner>)
                return "interactable:" + owner.interactable.text();
            else if constexpr (std::is_same_v<T, RoomFeatureRef>)
                return "room-feature:" + owner.room.text() + ":" + owner.feature_id.text();
            else
                return "interactable-feature:" + owner.interactable.text() + ":" +
                       owner.feature_id.text();
        },
        inventory.owner);
    return prefix + ":" + inventory.inventory_id.text();
}
struct UnplacedLocation {
    bool operator==(const UnplacedLocation&) const = default;
};
struct RoomLocation {
    RoomId room;
    bool operator==(const RoomLocation&) const = default;
};
struct InventoryLocation {
    InventoryRef inventory;
    bool operator==(const InventoryLocation&) const = default;
};

} // namespace noveltea::core::compiled

namespace noveltea::core {

struct CurrentRoomOperand {
    bool operator==(const CurrentRoomOperand&) const = default;
};
struct InteractionSlotOperand {
    VerbSlotId slot_id;
    bool operator==(const InteractionSlotOperand&) const = default;
};
struct CommandResultOperand {
    CommandResultBindingId binding_id;
    bool operator==(const CommandResultOperand&) const = default;
};

using GameplayIdentityOperand =
    std::variant<RoomId, CharacterId, InteractableInstanceId, RoomFeatureRef,
                 InteractableFeatureRef, CurrentRoomOperand, InteractionSlotOperand,
                 CommandResultOperand>;
using InteractableOperand =
    std::variant<InteractableInstanceId, InteractionSlotOperand, CommandResultOperand>;
using LocationSubjectOperand =
    std::variant<CharacterId, InteractableInstanceId, InteractionSlotOperand, CommandResultOperand>;
using RoomOperand = std::variant<RoomId, CurrentRoomOperand, CommandResultOperand>;

struct ProjectInventoryOwnerOperand {
    bool operator==(const ProjectInventoryOwnerOperand&) const = default;
};
using InventoryOwnerOperand =
    std::variant<ProjectInventoryOwnerOperand, CharacterId, InteractableInstanceId, RoomFeatureRef,
                 InteractableFeatureRef, InteractionSlotOperand, CommandResultOperand>;
struct ExactInventoryOperand {
    compiled::InventoryRef inventory;
    bool operator==(const ExactInventoryOperand&) const = default;
};
struct PlayerInventoryOperand {
    bool operator==(const PlayerInventoryOperand&) const = default;
};
struct OwnerInventoryOperand {
    InventoryOwnerOperand owner;
    InventoryId inventory_id;
    bool operator==(const OwnerInventoryOperand&) const = default;
};
using InventoryOperand = std::variant<ExactInventoryOperand, PlayerInventoryOperand,
                                      OwnerInventoryOperand, CommandResultOperand>;
struct RoomLocationOperand {
    RoomOperand room;
    bool operator==(const RoomLocationOperand&) const = default;
};
struct InventoryLocationOperand {
    InventoryOperand inventory;
    bool operator==(const InventoryLocationOperand&) const = default;
};
using LocationOperand =
    std::variant<compiled::UnplacedLocation, RoomLocationOperand, InventoryLocationOperand>;

using GameplayOperandValue =
    std::variant<RoomId, CharacterId, InteractableInstanceId, RoomFeatureRef,
                 InteractableFeatureRef, compiled::InventoryRef, compiled::UnplacedLocation,
                 compiled::RoomLocation, compiled::InventoryLocation>;

struct CommandResultBinding {
    CommandResultBindingId binding_id;
    GameplayOperandValue value;
    bool operator==(const CommandResultBinding&) const = default;
};

} // namespace noveltea::core
