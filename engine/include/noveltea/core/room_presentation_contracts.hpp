#pragma once

#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/result.hpp"

#include <functional>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

using RoomPresentationConditionEvaluator =
    std::function<Result<bool, Diagnostics>(const Condition& condition)>;
using RoomPresentationTextResolver =
    std::function<Result<std::string, Diagnostics>(const TextSource& source)>;

using RoomPresentationConditionToken = std::size_t;
using RoomPresentationTextToken = std::size_t;
using RoomPresentationConditionTokenEvaluator =
    std::function<Result<bool, Diagnostics>(RoomPresentationConditionToken)>;
using RoomPresentationTextTokenResolver =
    std::function<Result<std::string, Diagnostics>(RoomPresentationTextToken)>;

struct RoomPresentationDefinitionView {
    struct CharacterDefaults {
        CharacterId character;
        CharacterPresentationProfileId profile;
        CharacterPoseId pose;
        CharacterExpressionId expression;
        std::optional<CharacterAppearanceId> appearance;
        std::optional<CharacterIdleId> idle;
    };
    struct Overlay {
        RoomOverlayId id;
        LayoutId layout;
        RoomPresentationConditionToken condition = 0;
        bool visible = true;
        std::int32_t order = 0;
    };
    struct CastEntry {
        RoomCastEntryId id;
        CharacterId character;
        RoomPresentationConditionToken condition = 0;
        RoomPlacementId placement;
        std::optional<CharacterPresentationProfileId> profile;
        std::optional<CharacterPoseId> pose;
        std::optional<CharacterExpressionId> expression;
        std::optional<CharacterAppearanceId> appearance;
        std::optional<CharacterIdleId> idle;
        bool visible = true;
        std::int32_t order = 0;
    };
    struct InteractableOccurrence {
        RoomInteractableEntryId id;
        InteractableId interactable;
        RoomPresentationConditionToken condition = 0;
        RoomPlacementId placement;
        bool visible = true;
        std::int32_t order = 0;
    };
    struct Prop {
        RoomPropId id;
        RoomPresentationConditionToken condition = 0;
        RoomPlacementId placement;
        std::optional<AssetId> asset;
        std::optional<MaterialId> material;
        bool visible = true;
        std::int32_t order = 0;
    };
    struct Environment {
        RoomEnvironmentId id;
        RoomPresentationConditionToken condition = 0;
        std::optional<AssetId> asset;
        MaterialId material;
        compiled::NormalizedRect bounds{};
        PresentationPlane plane = PresentationPlane::WorldContent;
        std::int32_t order = 0;
        LayoutClockDomain clock = LayoutClockDomain::Gameplay;
        compiled::Vector2 scroll_per_second{};
        double opacity = 1.0;
        bool visible = true;
    };
    struct Placement {
        RoomPlacementId id;
        compiled::NormalizedRect bounds{};
        std::optional<RoomPresentationTextToken> label;
        TextMarkup label_markup = TextMarkup::Plain;
        std::optional<LayoutId> layout;
        std::int32_t order = 0;
    };
    struct Exit {
        RoomExitId id;
        RoomPresentationConditionToken condition = 0;
        compiled::RoomExitDirection direction = compiled::RoomExitDirection::Custom;
        RoomPresentationTextToken label = 0;
        RoomId target;
    };

    RoomId room;
    compiled::BackgroundPresentation background;
    RoomPresentationTextToken description = 0;
    TextMarkup description_markup = TextMarkup::Plain;
    std::vector<CharacterDefaults> character_defaults;
    std::vector<Overlay> overlays;
    std::vector<CastEntry> cast;
    std::vector<InteractableOccurrence> interactables;
    std::vector<Prop> props;
    std::vector<Environment> environments;
    std::vector<Placement> placements;
    std::vector<Exit> exits;
};

struct RoomPresentationStateView {
    struct Character {
        CharacterId character;
        bool enabled = true;
        bool visible = true;
    };
    struct Interactable {
        InteractableId interactable;
        bool enabled = true;
        bool visible = true;
    };
    struct OverlayVisibility {
        RoomOverlayId overlay;
        bool visible = true;
    };

    std::vector<Character> characters;
    std::vector<Interactable> interactables;
    std::vector<OverlayVisibility> overlay_visibility;
};

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
    CharacterPresentationProfileId profile;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    std::optional<CharacterAppearanceId> appearance;
    std::optional<CharacterIdleId> idle;
    bool enabled = true;
    bool visible = true;
    std::int32_t order = 0;
};

struct ResolvedRoomInteractable {
    RoomInteractableEntryId occurrence;
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

struct ResolvedPresentationHotspot {
    compiled::HotspotRef ref;
    std::string label;
    bool condition_eligible = false;
    bool target_available = false;
    compiled::ResolvedHotspotTarget target;
    std::variant<std::monostate, compiled::RectHotspotShape> shape;
    std::int32_t input_order = 0;
    compiled::HotspotHighlight highlight;
    std::optional<compiled::RoomPlacementRef> interactable_placement;
    std::optional<compiled::NormalizedRect> interactable_bounds;
    PresentationPlane owner_plane = PresentationPlane::WorldBackground;
    std::int32_t owner_order = 0;
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
    std::vector<ResolvedPresentationHotspot> hotspots;
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
    RoomEntryCause entry_cause = RoomEntryCause::DirectedRoomChange;
    std::optional<RoomVisitContext> source_context;
    std::optional<compiled::RoomNavigationTransition> explicit_transition;
    std::uint64_t target_entry_sequence = 0;
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
    [[nodiscard]] virtual Result<void, Diagnostics> compose(const RoomVisitContext& visit,
                                                            RoomPresentationDraft& draft) = 0;
};

} // namespace noveltea::core
