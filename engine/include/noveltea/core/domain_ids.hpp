#pragma once

#include "noveltea/core/strong_id.hpp"

#include <cstdint>
#include <variant>

namespace noveltea::core {

#define NOVELTEA_DOMAIN_ID(name)                                                                   \
    struct name##Tag;                                                                              \
    using name = StrongId<name##Tag>
NOVELTEA_DOMAIN_ID(RoomId);
NOVELTEA_DOMAIN_ID(SceneId);
NOVELTEA_DOMAIN_ID(DialogueId);
NOVELTEA_DOMAIN_ID(CharacterId);
NOVELTEA_DOMAIN_ID(InteractableId);
NOVELTEA_DOMAIN_ID(VerbId);
NOVELTEA_DOMAIN_ID(InteractionId);
NOVELTEA_DOMAIN_ID(MapId);
NOVELTEA_DOMAIN_ID(ScriptId);
NOVELTEA_DOMAIN_ID(LayoutId);
NOVELTEA_DOMAIN_ID(AssetId);
NOVELTEA_DOMAIN_ID(PropertyId);
NOVELTEA_DOMAIN_ID(VariableId);
NOVELTEA_DOMAIN_ID(SceneStepId);
NOVELTEA_DOMAIN_ID(DialogueBlockId);
NOVELTEA_DOMAIN_ID(DialogueSegmentId);
NOVELTEA_DOMAIN_ID(DialogueEdgeId);
NOVELTEA_DOMAIN_ID(RoomPlacementId);
NOVELTEA_DOMAIN_ID(RoomExitId);
NOVELTEA_DOMAIN_ID(ActorSlotId);
#undef NOVELTEA_DOMAIN_ID

enum class PropertyOwnerKind : std::uint8_t {
    Room,
    Scene,
    Dialogue,
    Character,
    Interactable,
    Verb,
    Interaction,
    Map
};
using PropertyOwnerRef = std::variant<RoomId, SceneId, DialogueId, CharacterId, InteractableId,
                                      VerbId, InteractionId, MapId>;
} // namespace noveltea::core
