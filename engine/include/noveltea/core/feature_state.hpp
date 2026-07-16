#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <compare>
#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

struct ActorSlotKey {
    SceneId scene;
    ActorSlotId slot;
    auto operator<=>(const ActorSlotKey&) const = default;
};

struct ActorLogicalPlacement {
    compiled::ActorPosition position = compiled::ActorPosition::Center;
    compiled::Vector2 offset{0.0, 0.0};
    double scale = 1.0;
    bool operator==(const ActorLogicalPlacement&) const = default;
};

struct ActorState {
    ActorSlotKey key;
    CharacterId character;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    ActorLogicalPlacement placement;
    bool visible = false;
    bool presentation_complete = true;
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

struct LayoutSlotState {
    compiled::LayoutSlot slot;
    LayoutId layout;
};

struct RoomOverlayState {
    RoomId room;
    RoomOverlayId overlay;
    bool visible = true;
};

struct LogicalTransitionState {
    compiled::TransitionKind kind;
    std::optional<std::string> color;
    bool complete = true;
};

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
