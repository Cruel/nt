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
struct CameraOperationTarget {
    auto operator<=>(const CameraOperationTarget&) const = default;
};
struct ActorOperationTarget {
    ActorPresentationKey actor;
    bool operator==(const ActorOperationTarget&) const = default;
};
struct LayoutOperationTarget {
    MountedLayoutPresentationKey layout;
    PresentationOwner owner;
    bool operator==(const LayoutOperationTarget&) const = default;
};
struct MaterialParameterOperationTarget {
    PresentationOwner owner;
    MaterialOccurrence occurrence;
    MaterialId material;
    std::string parameter;
    bool operator==(const MaterialParameterOperationTarget&) const = default;
};
using FinitePresentationOperationTarget =
    std::variant<WorldCompositionOperationTarget, RoomNavigationOperationTarget,
                 BackgroundOperationTarget, CameraOperationTarget, ActorOperationTarget,
                 LayoutOperationTarget, MaterialParameterOperationTarget>;

enum class PresentationEasing : std::uint8_t {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
};

struct FinitePresentationOperationCommon {
    PresentationOperationId id;
    std::chrono::milliseconds duration{0};
    bool skippable = true;
    LayoutClockDomain clock = LayoutClockDomain::Gameplay;
    PresentationRevisionBinding revisions;
    PresentationEasing easing = PresentationEasing::Linear;
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

struct RoomAnchorFocusSource {
    RoomId room;
    RoomAnchorId anchor;
    auto operator<=>(const RoomAnchorFocusSource&) const = default;
};
using CameraFocusSource =
    std::variant<ActorPresentationKey, compiled::RoomPlacementRef, RoomAnchorFocusSource>;
struct CameraFocusCapture {
    CameraFocusSource source;
    compiled::WorldPresentationRect bounds;
    bool operator==(const CameraFocusCapture&) const = default;
};

struct CameraPanOperation {
    FinitePresentationOperationCommon common;
    CameraOperationTarget target;
    compiled::CameraView source_view;
    compiled::CameraView target_view;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const CameraPanOperation&) const = default;
};
struct CameraZoomOperation {
    FinitePresentationOperationCommon common;
    CameraOperationTarget target;
    compiled::CameraView source_view;
    compiled::CameraView target_view;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const CameraZoomOperation&) const = default;
};
struct CameraRotationOperation {
    FinitePresentationOperationCommon common;
    CameraOperationTarget target;
    compiled::CameraView source_view;
    compiled::CameraView target_view;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const CameraRotationOperation&) const = default;
};
struct CameraFocusOperation {
    FinitePresentationOperationCommon common;
    CameraOperationTarget target;
    CameraFocusCapture capture;
    compiled::CameraView return_view;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const CameraFocusOperation&) const = default;
};
struct CameraShakeOperation {
    FinitePresentationOperationCommon common;
    CameraOperationTarget target;
    compiled::Vector2 amplitude;
    double frequency_hz = 12.0;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const CameraShakeOperation&) const = default;
};
struct CameraPunchOperation {
    FinitePresentationOperationCommon common;
    CameraOperationTarget target;
    compiled::Vector2 translation;
    double zoom_delta = 0.0;
    double rotation_degrees = 0.0;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const CameraPunchOperation&) const = default;
};
struct CameraFlashOperation {
    FinitePresentationOperationCommon common;
    CameraOperationTarget target;
    std::string color;
    double opacity = 1.0;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const CameraFlashOperation&) const = default;
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

struct CharacterGestureOperation {
    FinitePresentationOperationCommon common;
    ActorOperationTarget target;
    CharacterId character;
    CharacterGestureId gesture;
    CharacterAnimationClipId clip;
    std::vector<compiled::CharacterGestureCue> cues;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const CharacterGestureOperation&) const = default;
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

struct MaterialParameterTransitionOperation {
    FinitePresentationOperationCommon common;
    MaterialParameterOperationTarget target;
    compiled::MaterialParameterValue source_value;
    compiled::MaterialParameterValue target_value;
    std::optional<PresentationFlowCompletion> completion;
    bool operator==(const MaterialParameterTransitionOperation&) const = default;
};

using FinitePresentationOperation =
    std::variant<SceneTransitionGroupOperation, RoomNavigationTransitionOperation,
                 BackgroundPresentationOperation, CameraPanOperation, CameraZoomOperation,
                 CameraRotationOperation, CameraFocusOperation, CameraShakeOperation,
                 CameraPunchOperation, CameraFlashOperation, ActorPresentationOperation,
                 CharacterGestureOperation, LayoutFinitePresentationOperation,
                 MaterialParameterTransitionOperation>;

struct PresentationTargetDraft {
    std::vector<DesiredBackgroundOverride> background_overrides;
    std::vector<DesiredCameraView> camera_views;
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
struct TransitionGroupUpsertCameraTarget {
    DesiredCameraView value;
};
struct TransitionGroupClearCameraTarget {
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
                 TransitionGroupUpsertCameraTarget, TransitionGroupClearCameraTarget,
                 TransitionGroupUpsertActorTarget, TransitionGroupRemoveActorTarget,
                 TransitionGroupUpsertLayoutTarget, TransitionGroupRemoveLayoutTarget>;

} // namespace noveltea::core
