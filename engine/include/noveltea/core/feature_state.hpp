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
};

struct SceneChoiceOptionState {
    SceneChoiceOptionId option;
    std::string label;
    bool enabled = true;
};
struct SceneChoiceState {
    SceneId scene;
    SceneStepId step;
    std::optional<std::string> prompt;
    std::vector<SceneChoiceOptionState> options;
};

struct DialogueChoiceOptionState {
    DialogueEdgeId edge;
    std::string label;
    bool enabled = true;
    TextMarkup markup = TextMarkup::Plain;
};
struct DialogueChoiceState {
    DialogueId dialogue;
    DialogueBlockId block;
    std::vector<DialogueChoiceOptionState> options;
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
