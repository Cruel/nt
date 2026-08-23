#pragma once

#include "noveltea/core/strong_id.hpp"

#include <cstdint>
#include <variant>

namespace noveltea::core {

#define NOVELTEA_DOMAIN_ID(name)                                                                   \
    struct name##Tag;                                                                              \
    using name = StrongId<name##Tag>
NOVELTEA_DOMAIN_ID(ProjectId);
NOVELTEA_DOMAIN_ID(ArchetypeId);
NOVELTEA_DOMAIN_ID(RoomId);
NOVELTEA_DOMAIN_ID(SceneId);
NOVELTEA_DOMAIN_ID(DialogueId);
NOVELTEA_DOMAIN_ID(CharacterId);
NOVELTEA_DOMAIN_ID(InteractableId);
NOVELTEA_DOMAIN_ID(ItemDefinitionId);
NOVELTEA_DOMAIN_ID(ItemStackId);
NOVELTEA_DOMAIN_ID(VerbId);
NOVELTEA_DOMAIN_ID(VerbSlotId);
NOVELTEA_DOMAIN_ID(InteractionId);
NOVELTEA_DOMAIN_ID(MapId);
NOVELTEA_DOMAIN_ID(ScriptId);
NOVELTEA_DOMAIN_ID(LayoutId);
NOVELTEA_DOMAIN_ID(LayoutInputId);
NOVELTEA_DOMAIN_ID(LayoutSignalId);
NOVELTEA_DOMAIN_ID(LayoutSignalFieldId);
NOVELTEA_DOMAIN_ID(AssetId);
NOVELTEA_DOMAIN_ID(MaterialId);
NOVELTEA_DOMAIN_ID(PropertyId);
NOVELTEA_DOMAIN_ID(TraitId);
NOVELTEA_DOMAIN_ID(FeatureId);
NOVELTEA_DOMAIN_ID(InventoryId);
NOVELTEA_DOMAIN_ID(SceneStepId);
NOVELTEA_DOMAIN_ID(TransitionGroupChildId);
NOVELTEA_DOMAIN_ID(DialogueBlockId);
NOVELTEA_DOMAIN_ID(DialogueSegmentId);
NOVELTEA_DOMAIN_ID(DialogueEdgeId);
NOVELTEA_DOMAIN_ID(RoomPlacementId);
NOVELTEA_DOMAIN_ID(RoomExitId);
NOVELTEA_DOMAIN_ID(HotspotId);
NOVELTEA_DOMAIN_ID(ActorSlotId);
NOVELTEA_DOMAIN_ID(CharacterPoseId);
NOVELTEA_DOMAIN_ID(CharacterExpressionId);
NOVELTEA_DOMAIN_ID(CharacterIdleId);
NOVELTEA_DOMAIN_ID(RoomOverlayId);
NOVELTEA_DOMAIN_ID(RoomCastEntryId);
NOVELTEA_DOMAIN_ID(RoomInteractableEntryId);
NOVELTEA_DOMAIN_ID(RoomPropId);
NOVELTEA_DOMAIN_ID(RoomEnvironmentId);
NOVELTEA_DOMAIN_ID(SceneBranchId);
NOVELTEA_DOMAIN_ID(SceneChoiceOptionId);
NOVELTEA_DOMAIN_ID(InteractionRuleId);
NOVELTEA_DOMAIN_ID(InteractionInstructionId);
NOVELTEA_DOMAIN_ID(MapLocationId);
NOVELTEA_DOMAIN_ID(MapConnectionId);
#undef NOVELTEA_DOMAIN_ID

struct RoomFeatureRef {
    RoomId room;
    FeatureId feature_id;
    auto operator<=>(const RoomFeatureRef&) const = default;
};
struct InteractableFeatureRef {
    InteractableId interactable;
    FeatureId feature_id;
    auto operator<=>(const InteractableFeatureRef&) const = default;
};
using FeatureRef = std::variant<RoomFeatureRef, InteractableFeatureRef>;

enum class PropertyOwnerKind : std::uint8_t {
    Room,
    Character,
    Interactable,
    Feature,
    ItemStack
};
using PropertyOwnerRef = std::variant<RoomId, CharacterId, InteractableId, RoomFeatureRef,
                                      InteractableFeatureRef, ItemStackId>;
} // namespace noveltea::core
