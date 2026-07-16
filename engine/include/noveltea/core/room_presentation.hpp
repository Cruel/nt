#pragma once

#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/session_state.hpp"

#include <functional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace noveltea::core {

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

struct RoomPresentationDraft {
    compiled::BackgroundPresentation background;
    std::vector<ResolvedRoomActor> actors;
    std::vector<ResolvedRoomInteractable> interactables;
    std::vector<ResolvedRoomProp> props;
    std::vector<RoomOverlayView> overlays;
};

struct ResolvedRoomPresentation {
    RoomVisitContext visit;
    compiled::BackgroundPresentation background;
    std::vector<ResolvedRoomActor> actors;
    std::vector<ResolvedRoomInteractable> interactables;
    std::vector<ResolvedRoomProp> props;
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

class RoomPresentationResolver final {
public:
    using ConditionEvaluator = std::function<Result<bool, Diagnostics>(const Condition& condition)>;
    using TextResolver = std::function<Result<std::string, Diagnostics>(const TextSource& source)>;

    [[nodiscard]] Result<RoomPresentationResolution, Diagnostics>
    resolve(const CompiledProject& project, const SessionState& state,
            const RoomVisitContext& visit, ConditionEvaluator evaluate, TextResolver resolve_text,
            RoomCompositionCallback* composition = nullptr) const;
};

[[nodiscard]] Result<PreparedRoomNavigationTarget, Diagnostics>
prepare_room_navigation_target(const CompiledProject& project, const SessionState& settled_state,
                               const RoomNavigationPreparationInput& input,
                               RoomPresentationResolver::ConditionEvaluator evaluate,
                               RoomPresentationResolver::TextResolver resolve_text,
                               RoomCompositionCallback* composition = nullptr);

} // namespace noveltea::core
