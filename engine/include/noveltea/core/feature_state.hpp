#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/flow.hpp"
#include "noveltea/core/presentation_contracts.hpp"

#include <chrono>
#include <compare>
#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

struct RoomVisitInstanceTag;
struct PresentationSessionTag;
struct ShellPresentationScopeTag;
using RoomVisitInstanceId = SessionSequence<RoomVisitInstanceTag>;
using PresentationSessionId = SessionSequence<PresentationSessionTag>;
using ShellPresentationScopeId = SessionSequence<ShellPresentationScopeTag>;

struct ScenePresentationOwner {
    FlowFrameId invocation;
    SceneId scene;
    auto operator<=>(const ScenePresentationOwner&) const = default;
};

struct CurrentRoomPresentationOwner {
    RoomVisitInstanceId visit;
    RoomId room;
    auto operator<=>(const CurrentRoomPresentationOwner&) const = default;
};

struct RoomPresentationOwner {
    RoomId room;
    auto operator<=>(const RoomPresentationOwner&) const = default;
};

struct SessionPresentationOwner {
    PresentationSessionId session;
    auto operator<=>(const SessionPresentationOwner&) const = default;
};

struct ShellPresentationOwner {
    ShellPresentationScopeId scope;
    auto operator<=>(const ShellPresentationOwner&) const = default;
};

using PresentationOwner =
    std::variant<ScenePresentationOwner, CurrentRoomPresentationOwner, RoomPresentationOwner,
                 SessionPresentationOwner, ShellPresentationOwner>;

enum class PresentationAuthority : std::uint8_t {
    Gameplay,
    Shell,
};

inline PresentationAuthority presentation_authority(const PresentationOwner& owner) noexcept
{
    return std::holds_alternative<ShellPresentationOwner>(owner) ? PresentationAuthority::Shell
                                                                 : PresentationAuthority::Gameplay;
}

struct CharacterActorKey {
    CharacterId character;
    auto operator<=>(const CharacterActorKey&) const = default;
};

struct RoomCastActorKey {
    RoomId room;
    RoomCastEntryId entry;
    auto operator<=>(const RoomCastActorKey&) const = default;
};

struct SceneActorKey {
    ScenePresentationOwner owner;
    ActorSlotId slot;
    auto operator<=>(const SceneActorKey&) const = default;
};

struct ScopedActorKey {
    StrongId<struct ScopedActorInstanceTag> instance;
    auto operator<=>(const ScopedActorKey&) const = default;
};

using ActorPresentationKey =
    std::variant<CharacterActorKey, RoomCastActorKey, SceneActorKey, ScopedActorKey>;

using PresentationPropInstanceId = StrongId<struct PresentationPropInstanceTag>;
using PresentationEnvironmentInstanceId = StrongId<struct PresentationEnvironmentInstanceTag>;
using PresentationEnvironmentStopKey = StrongId<struct PresentationEnvironmentStopKeyTag>;
using DesiredAudioInstanceId = StrongId<struct DesiredAudioInstanceTag>;
using DesiredAudioReplacementKey = StrongId<struct DesiredAudioReplacementKeyTag>;
using ScopedLayoutInstanceId = StrongId<struct ScopedLayoutInstanceTag>;

struct ReservedLayoutMountKey {
    compiled::LayoutSlot slot;
    auto operator<=>(const ReservedLayoutMountKey&) const = default;
};

struct RoomOverlayLayoutMountKey {
    RoomId room;
    RoomOverlayId overlay;
    auto operator<=>(const RoomOverlayLayoutMountKey&) const = default;
};

struct ScopedLayoutMountKey {
    ScopedLayoutInstanceId instance;
    auto operator<=>(const ScopedLayoutMountKey&) const = default;
};

using MountedLayoutPresentationKey =
    std::variant<ReservedLayoutMountKey, RoomOverlayLayoutMountKey, ScopedLayoutMountKey>;

struct BackgroundMaterialOccurrence {
    auto operator<=>(const BackgroundMaterialOccurrence&) const = default;
};
enum class ActorMaterialLayer : std::uint8_t {
    Pose,
    Expression,
};
struct ActorMaterialOccurrence {
    ActorPresentationKey key;
    ActorMaterialLayer layer = ActorMaterialLayer::Pose;
    auto operator<=>(const ActorMaterialOccurrence&) const = default;
};
struct PropMaterialOccurrence {
    PresentationPropInstanceId instance;
    auto operator<=>(const PropMaterialOccurrence&) const = default;
};
struct EnvironmentMaterialOccurrence {
    PresentationEnvironmentInstanceId instance;
    auto operator<=>(const EnvironmentMaterialOccurrence&) const = default;
};
struct LayoutMaterialOccurrence {
    MountedLayoutPresentationKey key;
    MaterialId material;
    auto operator<=>(const LayoutMaterialOccurrence&) const = default;
};
struct PostprocessMaterialOccurrence {
    PostprocessEffectInstanceId instance;
    auto operator<=>(const PostprocessMaterialOccurrence&) const = default;
};
using MaterialOccurrence = std::variant<BackgroundMaterialOccurrence, ActorMaterialOccurrence,
                                        PropMaterialOccurrence, EnvironmentMaterialOccurrence,
                                        LayoutMaterialOccurrence, PostprocessMaterialOccurrence>;

enum class MaterialClockPolicy : std::uint8_t {
    Gameplay,
    UnscaledPresentation,
};
enum class MaterialStandardFacet : std::uint8_t {
    OccurrenceTime,
    PaintWidth,
    PaintHeight,
    ViewportWidth,
    ViewportHeight,
    CameraZoom,
};
struct MaterialPropertyBinding {
    PropertyTargetRef target;
    PropertyId property;
    bool operator==(const MaterialPropertyBinding&) const = default;
};
struct MaterialStandardFacetBinding {
    MaterialStandardFacet facet = MaterialStandardFacet::OccurrenceTime;
    bool operator==(const MaterialStandardFacetBinding&) const = default;
};
using MaterialParameterBinding =
    std::variant<MaterialPropertyBinding, MaterialStandardFacetBinding>;
struct DesiredMaterialParameter {
    PresentationOwner owner;
    MaterialOccurrence occurrence;
    MaterialId material;
    std::string parameter;
    std::optional<compiled::MaterialParameterValue> value;
    std::optional<MaterialParameterBinding> binding;
    MaterialClockPolicy clock = MaterialClockPolicy::Gameplay;
    bool operator==(const DesiredMaterialParameter&) const = default;
};

inline constexpr std::size_t max_postprocess_effects_per_scope = 4;
struct DesiredPostprocessEffect {
    PostprocessEffectInstanceId instance;
    PresentationOwner owner;
    MaterialId material;
    compiled::MaterialPostprocessScope scope = compiled::MaterialPostprocessScope::World;
    std::int32_t order = 0;
    MaterialClockPolicy clock = MaterialClockPolicy::Gameplay;
    bool visible = true;
    bool operator==(const DesiredPostprocessEffect&) const = default;
};

enum class LayoutStateScope : std::uint8_t {
    Visit,
    Room,
    Flow,
    Session,
};

struct LayoutVisitStateOwner {
    RoomVisitInstanceId visit;
    auto operator<=>(const LayoutVisitStateOwner&) const = default;
};
struct LayoutRoomStateOwner {
    RoomId room;
    auto operator<=>(const LayoutRoomStateOwner&) const = default;
};
struct LayoutFlowStateOwner {
    FlowFrameId flow;
    auto operator<=>(const LayoutFlowStateOwner&) const = default;
};
struct LayoutSessionStateOwner {
    PresentationSessionId session;
    auto operator<=>(const LayoutSessionStateOwner&) const = default;
};
using LayoutStateScopeOwner = std::variant<LayoutVisitStateOwner, LayoutRoomStateOwner,
                                           LayoutFlowStateOwner, LayoutSessionStateOwner>;

struct LayoutStateSlot {
    LayoutStateScopeOwner scope_owner;
    MountedLayoutPresentationKey key;
    LayoutId layout;
    PersistableValue value;
    bool operator==(const LayoutStateSlot&) const = default;
};

enum class PresentationCompositionGroup : std::uint8_t {
    World,
    Interface,
    Shell,
    Debug,
};

struct ActorLogicalPlacement {
    compiled::ActorPosition position = compiled::ActorPosition::Center;
    compiled::Vector2 offset{0.0, 0.0};
    double scale = 1.0;
    bool operator==(const ActorLogicalPlacement&) const = default;
};

struct DesiredActorPresentation {
    ActorPresentationKey key;
    PresentationOwner owner;
    CharacterId character;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    std::optional<CharacterIdleId> idle;
    ActorLogicalPlacement placement;
    bool visible = false;
    bool presentation_complete = true;
    bool operator==(const DesiredActorPresentation&) const = default;
};

struct DesiredBackgroundOverride {
    PresentationOwner owner;
    compiled::BackgroundPresentation background;
    bool operator==(const DesiredBackgroundOverride&) const = default;
};

struct DesiredCameraView {
    PresentationOwner owner;
    compiled::CameraView view;
    bool operator==(const DesiredCameraView&) const = default;
};

struct DesiredPresentationProp {
    PresentationPropInstanceId instance;
    PresentationOwner owner;
    std::optional<AssetId> asset;
    std::optional<MaterialId> material;
    std::optional<compiled::RoomPlacementRef> placement;
    compiled::NormalizedRect bounds{0.0, 0.0, 0.0, 0.0};
    PresentationPlane plane = PresentationPlane::WorldContent;
    std::int32_t order = 0;
    bool visible = true;
    bool operator==(const DesiredPresentationProp&) const = default;
};

struct DesiredPresentationEnvironment {
    PresentationEnvironmentInstanceId instance;
    PresentationOwner owner;
    PresentationEnvironmentStopKey stop_key;
    std::optional<AssetId> asset;
    MaterialId material;
    compiled::NormalizedRect bounds{0.0, 0.0, 1.0, 1.0};
    PresentationPlane plane = PresentationPlane::WorldContent;
    std::int32_t order = 0;
    LayoutClockDomain clock = LayoutClockDomain::Gameplay;
    compiled::Vector2 scroll_per_second{0.0, 0.0};
    double opacity = 1.0;
    bool visible = true;
    bool operator==(const DesiredPresentationEnvironment&) const = default;
};

struct DesiredMountedLayout {
    MountedLayoutPresentationKey key;
    PresentationOwner owner;
    LayoutId layout;
    MountedLayoutPolicy policy;
    LayoutScaleOverrides scale_overrides{};
    PresentationCompositionGroup composition_group = PresentationCompositionGroup::Interface;
    std::optional<LayoutMountOccurrenceId> occurrence;
    std::vector<LayoutInputAssignment> inputs;
    std::vector<LayoutSignalId> connected_signals;
    bool operator==(const DesiredMountedLayout&) const = default;
};

struct DesiredAudioInstance {
    DesiredAudioInstanceId instance;
    PresentationOwner owner;
    compiled::AudioPurpose purpose = compiled::AudioPurpose::Music;
    compiled::AudioPausePolicy pause_policy = compiled::AudioPausePolicy::Gameplay;
    AssetId asset;
    double gain = 1.0;
    double pan = 0.0;
    std::optional<compiled::AudioPanSource> pan_source;
    std::chrono::milliseconds fade_in{0};
    std::chrono::milliseconds fade_out{0};
    std::optional<DesiredAudioReplacementKey> replacement_key;
    bool operator==(const DesiredAudioInstance&) const = default;
};

struct InteractableState {
    InteractableId interactable;
    compiled::InteractableLocation location;
    bool enabled = true;
    bool visible = true;
};

struct ItemStackState {
    ItemStackId id;
    ItemDefinitionId definition;
    std::uint64_t quantity;
    compiled::ItemStackLocation location;
    std::vector<TraitId> traits;
    bool declared = false;
    bool operator==(const ItemStackState&) const = default;
};

using CharacterWorldLocation = compiled::CharacterInitialWorldLocation;

struct CharacterWorldState {
    CharacterId character;
    CharacterWorldLocation location;
    bool enabled = true;
    bool visible = true;
    bool operator==(const CharacterWorldState&) const = default;
};

struct DialogueLineHistoryKey {
    DialogueId dialogue;
    DialogueSegmentId segment;
    auto operator<=>(const DialogueLineHistoryKey&) const = default;
};

struct DialogueChoiceHistoryKey {
    DialogueId dialogue;
    DialogueEdgeId edge;
    auto operator<=>(const DialogueChoiceHistoryKey&) const = default;
};

struct SceneTextLogOrigin {
    SceneId scene;
    SceneStepId step;
};
struct DialogueLineTextLogOrigin {
    DialogueId dialogue;
    DialogueSegmentId segment;
};
struct DialogueChoiceTextLogOrigin {
    DialogueId dialogue;
    DialogueEdgeId edge;
};
struct InteractionTextLogOrigin {
    InteractionId interaction;
    InteractionInstructionId instruction;
};
struct SystemTextLogOrigin {};
using TextLogOrigin =
    std::variant<SceneTextLogOrigin, DialogueLineTextLogOrigin, DialogueChoiceTextLogOrigin,
                 InteractionTextLogOrigin, SystemTextLogOrigin>;

enum class TextLogEntryKind : std::uint8_t {
    Line,
    Choice,
    Notification
};

struct TextLogEntry {
    TextLogEntryKind kind;
    TextLogOrigin origin;
    std::optional<CharacterId> speaker;
    std::string text;
    TextMarkup markup = TextMarkup::Plain;
};

struct PresentedTextState {
    std::optional<CharacterId> speaker;
    std::string text;
    TextMarkup markup = TextMarkup::Plain;
    bool operator==(const PresentedTextState&) const = default;
};

struct SceneChoiceOptionState {
    SceneChoiceOptionId option;
    std::string label;
    bool enabled = true;
    bool operator==(const SceneChoiceOptionState&) const = default;
};
struct SceneChoiceState {
    SceneId scene;
    SceneStepId step;
    std::optional<std::string> prompt;
    std::vector<SceneChoiceOptionState> options;
    bool operator==(const SceneChoiceState&) const = default;
};

struct DialogueChoiceOptionState {
    DialogueEdgeId edge;
    std::string label;
    bool enabled = true;
    TextMarkup markup = TextMarkup::Plain;
    bool operator==(const DialogueChoiceOptionState&) const = default;
};
struct DialogueChoiceState {
    DialogueId dialogue;
    DialogueBlockId block;
    std::vector<DialogueChoiceOptionState> options;
    bool operator==(const DialogueChoiceState&) const = default;
};

using ActiveChoiceState = std::variant<SceneChoiceState, DialogueChoiceState>;

} // namespace noveltea::core
