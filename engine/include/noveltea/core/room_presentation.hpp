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

} // namespace noveltea::core
