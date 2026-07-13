#pragma once

#include "noveltea/core/feature_state.hpp"
#include "noveltea/core/flow.hpp"

#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

struct ActorView {
    ActorSlotKey key;
    CharacterId character;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    ActorLogicalPlacement placement;
    bool visible;
    bool presentation_complete;
};

struct SceneView {
    SceneId scene;
    std::optional<compiled::BackgroundPresentation> background;
    std::vector<ActorView> actors;
    std::optional<PresentedTextState> text;
    std::optional<SceneChoiceState> choice;
    std::vector<LayoutSlotState> layouts;
    std::optional<LogicalTransitionState> transition;
    std::vector<AudioChannelState> audio_channels;
};

struct DialogueView {
    DialogueId dialogue;
    std::optional<PresentedTextState> line;
    std::optional<DialogueChoiceState> choice;
};

struct RoomPlacementView {
    RoomPlacementId placement;
    InteractableId interactable;
    compiled::NormalizedRect bounds;
    std::optional<std::string> label;
    TextMarkup label_markup = TextMarkup::Plain;
    std::optional<LayoutId> layout;
    bool enabled;
    bool visible;
};

struct RoomOverlayView {
    RoomOverlayId overlay;
    LayoutId layout;
    bool visible;
};

struct RoomExitView {
    RoomExitId exit;
    RoomId target;
    compiled::RoomExitDirection direction;
    std::string label;
    bool enabled;
};

struct InteractionControlView {
    VerbId verb;
    std::string label;
    std::uint8_t arity = 0;
    bool quick_action = false;
    bool enabled = false;
};

struct RoomView {
    RoomId room;
    std::uint64_t visits = 0;
    std::string description;
    TextMarkup description_markup;
    compiled::BackgroundPresentation background;
    std::vector<RoomOverlayView> overlays;
    std::vector<RoomPlacementView> placements;
    std::vector<RoomExitView> exits;
    std::vector<InteractionControlView> controls;
};

struct InteractionView {
    VerbId verb;
    std::optional<RoomId> room;
    std::vector<InteractableId> operands;
    std::optional<InteractionProgramRef> program;
    std::optional<std::string> notification;
};

struct InventoryItemView {
    InteractableId interactable;
    std::string display_name;
    compiled::InteractablePresentation presentation;
    bool enabled;
    bool visible;
};
struct InventoryView {
    std::vector<InventoryItemView> items;
    std::vector<InteractionControlView> controls;
};

struct TextLogView {
    std::vector<TextLogEntry> entries;
};

struct MapLocationView {
    MapLocationId location;
    RoomId room;
    compiled::Vector2 position;
    compiled::MapShape shape;
    std::optional<std::string> label;
    bool focused;
};
struct MapConnectionView {
    MapConnectionId connection;
    compiled::RoomExitRef exit;
    MapLocationId source;
    MapLocationId target;
    bool selectable;
};
struct MapView {
    MapId map;
    compiled::InitialMapMode mode;
    bool visible;
    std::optional<RoomId> current_room;
    std::optional<std::string> title;
    std::optional<AssetId> background;
    std::optional<LayoutId> layout;
    std::vector<MapLocationView> locations;
    std::vector<MapConnectionView> connections;
};

struct TypedRuntimeUIViewState {
    std::string mode;
    std::optional<SceneView> scene;
    std::optional<DialogueView> dialogue;
    std::optional<RoomView> room;
    std::optional<InteractionView> interaction;
    InventoryView inventory;
    TextLogView text_log;
    std::optional<MapView> map;
};

using FeatureView =
    std::variant<SceneView, DialogueView, RoomView, InteractionView, InventoryView, MapView>;

} // namespace noveltea::core
