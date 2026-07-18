#pragma once

#include "noveltea/core/feature_state.hpp"

#include <chrono>
#include <optional>
#include <variant>
#include <vector>

namespace noveltea::core {

struct PresentationRevisionBinding {
    PresentationSnapshotRevision source;
    PresentationSnapshotRevision target;
    auto operator<=>(const PresentationRevisionBinding&) const = default;
};

struct WorldCompositionOperationTarget {
    auto operator<=>(const WorldCompositionOperationTarget&) const = default;
};
struct RoomNavigationOperationTarget {
    std::optional<RoomId> source_room;
    RoomId target_room;
    auto operator<=>(const RoomNavigationOperationTarget&) const = default;
};
struct BackgroundOperationTarget {
    auto operator<=>(const BackgroundOperationTarget&) const = default;
};
struct ActorOperationTarget {
    ActorPresentationKey actor;
    bool operator==(const ActorOperationTarget&) const = default;
};
struct LayoutOperationTarget {
    MountedLayoutPresentationKey layout;
    bool operator==(const LayoutOperationTarget&) const = default;
};
using FinitePresentationOperationTarget =
    std::variant<WorldCompositionOperationTarget, RoomNavigationOperationTarget,
                 BackgroundOperationTarget, ActorOperationTarget, LayoutOperationTarget>;

struct FinitePresentationOperationCommon {
    PresentationOperationId id;
    std::chrono::milliseconds duration{0};
    bool skippable = true;
    LayoutClockDomain clock = LayoutClockDomain::Gameplay;
    PresentationRevisionBinding revisions;
    bool operator==(const FinitePresentationOperationCommon&) const = default;
};

struct SceneTransitionGroupOperation {
    FinitePresentationOperationCommon common;
    compiled::TransitionKind kind;
    std::optional<std::string> color;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const SceneTransitionGroupOperation&) const = default;
};

struct RoomNavigationTransitionOperation {
    FinitePresentationOperationCommon common;
    RoomNavigationOperationTarget target;
    compiled::TransitionKind kind;
    std::optional<std::string> color;
    PresentationFlowCompletion completion;
    bool operator==(const RoomNavigationTransitionOperation&) const = default;
};

enum class BackgroundOperationKind : std::uint8_t {
    CrossFade,
};
struct BackgroundPresentationOperation {
    FinitePresentationOperationCommon common;
    BackgroundOperationKind kind = BackgroundOperationKind::CrossFade;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const BackgroundPresentationOperation&) const = default;
};

enum class ActorOperationKind : std::uint8_t {
    Fade,
    Slide,
};
struct ActorPresentationOperation {
    FinitePresentationOperationCommon common;
    ActorOperationTarget target;
    ActorOperationKind kind = ActorOperationKind::Fade;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const ActorPresentationOperation&) const = default;
};

enum class LayoutOperationKind : std::uint8_t {
    Fade,
};
struct LayoutFinitePresentationOperation {
    FinitePresentationOperationCommon common;
    LayoutOperationTarget target;
    LayoutOperationKind kind = LayoutOperationKind::Fade;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const LayoutFinitePresentationOperation&) const = default;
};

using FinitePresentationOperation =
    std::variant<SceneTransitionGroupOperation, RoomNavigationTransitionOperation,
                 BackgroundPresentationOperation, ActorPresentationOperation,
                 LayoutFinitePresentationOperation>;

struct PresentationTargetDraft {
    std::vector<DesiredBackgroundOverride> background_overrides;
    std::vector<DesiredActorPresentation> actors;
    std::vector<DesiredMountedLayout> layouts;
    bool operator==(const PresentationTargetDraft&) const = default;
};

struct TransitionGroupUpsertBackgroundTarget {
    DesiredBackgroundOverride value;
};
struct TransitionGroupClearBackgroundTarget {
    PresentationOwner owner;
};
struct TransitionGroupUpsertActorTarget {
    DesiredActorPresentation value;
};
struct TransitionGroupRemoveActorTarget {
    ActorPresentationKey key;
    PresentationOwner owner;
};
struct TransitionGroupUpsertLayoutTarget {
    DesiredMountedLayout value;
};
struct TransitionGroupRemoveLayoutTarget {
    MountedLayoutPresentationKey key;
    PresentationOwner owner;
};
using TransitionGroupTargetMutation =
    std::variant<TransitionGroupUpsertBackgroundTarget, TransitionGroupClearBackgroundTarget,
                 TransitionGroupUpsertActorTarget, TransitionGroupRemoveActorTarget,
                 TransitionGroupUpsertLayoutTarget, TransitionGroupRemoveLayoutTarget>;

} // namespace noveltea::core
