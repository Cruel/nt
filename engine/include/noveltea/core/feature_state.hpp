#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/presentation_contracts.hpp"

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
    PresentationCompositionGroup composition_group = PresentationCompositionGroup::Interface;
    bool operator==(const DesiredMountedLayout&) const = default;
};

struct InteractableState {
    InteractableId interactable;
    compiled::InteractableLocation location;
    bool enabled = true;
    bool visible = true;
};

using CharacterWorldLocation =
    std::variant<compiled::NowhereCharacterLocation, compiled::RoomPlacementRef>;

struct CharacterWorldState {
    CharacterId character;
    CharacterWorldLocation location;
    bool enabled = true;
    bool visible = true;
    bool operator==(const CharacterWorldState&) const = default;
};

struct RoomVisitContext {
    RoomId room;
    std::optional<RoomId> source_room;
    std::optional<compiled::RoomExitRef> entry_exit;
    std::uint64_t visit_index = 0;
    bool operator==(const RoomVisitContext&) const = default;
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

struct AudioChannelState {
    compiled::AudioChannel channel;
    std::optional<AssetId> asset;
    double volume = 1.0;
    bool loop = false;
    bool playing = false;
};

struct MapPresentationState {
    MapId map;
    compiled::InitialMapMode mode;
    bool visible = false;
    std::optional<MapLocationId> focused_location;
};

} // namespace noveltea::core
