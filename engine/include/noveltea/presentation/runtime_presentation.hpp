#pragma once

#include "noveltea/core/result.hpp"
#include "noveltea/core/room_presentation_contracts.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"
#include "noveltea/runtime/runtime_world.hpp"

#include <optional>
#include <vector>

namespace noveltea::core {

class SessionState;

struct RoomPresentationVisualCatalog {
    struct Placement {
        RoomPlacementId placement;
        compiled::NormalizedRect bounds{};
        std::int32_t order = 0;
    };
    struct CharacterVisual {
        CharacterId character;
        CharacterPresentationProfileId profile;
        CharacterPoseId pose;
        CharacterExpressionId expression;
        std::optional<CharacterAppearanceId> appearance;
        std::optional<CharacterIdleId> idle_id;
        std::vector<PresentationActorLayer> layers;
        std::optional<compiled::CharacterIdle> idle;
    };
    struct InteractableVisual {
        InteractableInstanceId interactable;
        std::optional<AssetId> sprite;
        std::optional<compiled::MaterialApplication> material_application;
    };
    struct HotspotVisual {
        compiled::HotspotRef ref;
        AssetId source_image;
        std::uint16_t source_width = 0;
        std::uint16_t source_height = 0;
    };

    std::vector<Placement> placements;
    std::vector<CharacterVisual> characters;
    std::vector<InteractableVisual> interactables;
    std::vector<HotspotVisual> hotspots;
};

[[nodiscard]] RoomPresentationVisualCatalog
build_room_presentation_visual_catalog(const runtime::RuntimeWorld& world,
                                       const RoomPresentationResolution& resolution);
[[nodiscard]] RoomPresentationVisualCatalog
build_room_presentation_visual_catalog(const CompiledProject& project,
                                       const runtime::RuntimeWorld& world,
                                       const RoomPresentationResolution& resolution);

class RoomPresentationSnapshotProjector final {
public:
    // Focused preview projects hotspot geometry from its bounded visual catalog without requiring a
    // complete compiled Project.
    [[nodiscard]] static Result<RuntimePresentationSnapshot, Diagnostics>
    project(const RoomPresentationResolution& resolution,
            const RoomPresentationVisualCatalog& visuals);
    [[nodiscard]] static Result<RuntimePresentationSnapshot, Diagnostics>
    project(const CompiledProject& project, const RoomPresentationResolution& resolution,
            const RoomPresentationVisualCatalog& visuals);
};

class PresentationProjector {
public:
    [[nodiscard]] static Result<RuntimePresentationSnapshot, Diagnostics>
    project(const CompiledProject& project, const runtime::RuntimeWorld& world,
            const SessionState& state, const ResolvedRoomPresentation* room_presentation = nullptr,
            const std::vector<SceneStageRoomPresentation>* scene_stages = nullptr);
};

class RuntimePresentationSnapshotPublisher {
public:
    [[nodiscard]] Result<bool, Diagnostics>
    reproject(const CompiledProject& project, const runtime::RuntimeWorld& world,
              const SessionState& state,
              const ResolvedRoomPresentation* room_presentation = nullptr);
    [[nodiscard]] const RuntimePresentationSnapshot* published() const noexcept;

private:
    std::optional<RuntimePresentationSnapshot> m_published;
};

} // namespace noveltea::core
