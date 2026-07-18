#pragma once

#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/result.hpp"

#include <functional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

using RoomPresentationConditionEvaluator =
    std::function<Result<bool, Diagnostics>(const Condition& condition)>;
using RoomPresentationTextResolver =
    std::function<Result<std::string, Diagnostics>(const TextSource& source)>;

struct PersistentCharacterPresentationId {
    CharacterId character;
    auto operator<=>(const PersistentCharacterPresentationId&) const = default;
};
struct RoomCastPresentationId {
    RoomId room;
    RoomCastEntryId entry;
    auto operator<=>(const RoomCastPresentationId&) const = default;
};
using ResolvedRoomActorId = std::variant<PersistentCharacterPresentationId, RoomCastPresentationId>;

struct ResolvedRoomActor {
    ResolvedRoomActorId id;
    CharacterId character;
    RoomPlacementId placement;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    std::optional<CharacterIdleId> idle;
    bool enabled = true;
    bool visible = true;
    std::int32_t order = 0;
};

struct ResolvedRoomInteractable {
    InteractableId interactable;
    RoomPlacementId placement;
    bool enabled = true;
    bool visible = true;
};

struct ResolvedRoomProp {
    RoomPropId prop;
    RoomPlacementId placement;
    std::optional<AssetId> asset;
    std::optional<MaterialId> material;
    bool visible = true;
    std::int32_t order = 0;
};

struct ResolvedRoomEnvironment {
    RoomEnvironmentId environment;
    std::optional<AssetId> asset;
    MaterialId material;
    compiled::NormalizedRect bounds{0.0, 0.0, 1.0, 1.0};
    PresentationPlane plane = PresentationPlane::WorldContent;
    std::int32_t order = 0;
    LayoutClockDomain clock = LayoutClockDomain::Gameplay;
    compiled::Vector2 scroll_per_second{0.0, 0.0};
    double opacity = 1.0;
    bool visible = true;
};

struct RoomPresentationDraft {
    compiled::BackgroundPresentation background;
    std::vector<ResolvedRoomActor> actors;
    std::vector<ResolvedRoomInteractable> interactables;
    std::vector<ResolvedRoomProp> props;
    std::vector<ResolvedRoomEnvironment> environments;
    std::vector<RoomOverlayView> overlays;
};

struct ResolvedRoomPresentation {
    RoomVisitContext visit;
    compiled::BackgroundPresentation background;
    std::vector<ResolvedRoomActor> actors;
    std::vector<ResolvedRoomInteractable> interactables;
    std::vector<ResolvedRoomProp> props;
    std::vector<ResolvedRoomEnvironment> environments;
    std::vector<RoomOverlayView> overlays;
};

struct RoomPresentationResolution {
    ResolvedRoomPresentation presentation;
    RoomView view;
    std::vector<compiled::InteractionSubject> eligible_subjects;
};

struct RoomNavigationPreparationInput {
    FlowFrameId owner;
    std::optional<RoomId> source_room;
    RoomId target_room;
    std::optional<compiled::RoomExitRef> selected_exit;
    std::optional<compiled::RoomNavigationTransition> explicit_transition;
    std::uint64_t target_visit_index = 0;
};

struct PreparedRoomNavigationTransition {
    FlowFrameId owner;
    std::optional<RoomVisitContext> source_visit;
    RoomVisitContext target_visit;
    compiled::RoomNavigationTransition policy;
};

struct PreparedRoomNavigationTarget {
    RoomPresentationResolution resolution;
    PreparedRoomNavigationTransition transition;
};

class RoomCompositionCallback {
public:
    virtual ~RoomCompositionCallback() = default;
    [[nodiscard]] virtual Result<void, Diagnostics>
    compose(const compiled::RoomCompositionHook& hook, const RoomVisitContext& visit,
            RoomPresentationDraft& draft) = 0;
};

} // namespace noveltea::core
