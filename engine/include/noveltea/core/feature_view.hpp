#pragma once

#include "noveltea/core/gameplay_pause.hpp"

#include "noveltea/core/feature_state.hpp"
#include "noveltea/core/flow.hpp"

#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

struct ActorView {
    ActorPresentationKey key;
    CharacterId character;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    ActorLogicalPlacement placement;
    bool visible;
    bool presentation_complete;
};

struct SceneLayoutView {
    compiled::LayoutSlot slot;
    LayoutId layout;
};

struct SceneView {
    SceneId scene;
    std::optional<compiled::BackgroundPresentation> background;
    std::vector<ActorView> actors;
    std::optional<PresentedTextState> text;
    std::optional<SceneChoiceState> choice;
    std::vector<SceneLayoutView> layouts;
    std::vector<DesiredAudioInstance> desired_audio;
};

struct DialogueView {
    DialogueId dialogue;
    std::optional<PresentedTextState> line;
    std::optional<DialogueChoiceState> choice;
};

struct RoomPlacementView {
    RoomPlacementId placement;
    compiled::NormalizedRect bounds;
    std::optional<std::string> label;
    TextMarkup label_markup = TextMarkup::Plain;
    std::optional<LayoutId> layout;
    std::int32_t order = 0;
    struct Occupant {
        compiled::InteractionSubject subject;
        bool enabled;
        bool visible;
    };
    std::vector<Occupant> occupants;
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
    std::vector<VerbSlotId> binding_order;
    bool enabled = false;
};

struct VerbOfferView {
    VerbId verb;
    VerbSlotId slot;
    std::string label;
    std::vector<VerbSlotId> binding_order;
    std::int64_t rank = 0;
    bool primary = false;
    bool operator==(const VerbOfferView&) const = default;
};

struct ItemStackView {
    ItemStackId stack;
    ItemDefinitionId definition;
    std::uint64_t quantity;
    compiled::ItemStackLocation location;
    std::optional<RoomId> effective_room;
    std::string display_name;
    std::string description;
    compiled::ItemDefinitionPresentation presentation;
    std::vector<TraitId> traits;
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
    std::vector<ItemStackView> item_stacks;
    std::vector<InteractionControlView> controls;
};

struct InteractionView {
    VerbId verb;
    std::optional<RoomId> room;
    std::vector<InteractionSubjectBinding> bindings;
    std::optional<InteractionProgramRef> program;
    std::optional<std::string> notification;
};

struct InventoryContainerView {
    compiled::InventoryRef inventory;
    std::string label;
    std::optional<RoomId> effective_room;
};
struct InventoryItemView {
    InteractableId interactable;
    compiled::InventoryRef inventory;
    std::optional<RoomId> effective_room;
    std::string display_name;
    compiled::InteractablePresentation presentation;
    bool enabled;
    bool visible;
};
struct InventoryView {
    std::vector<InventoryContainerView> inventories;
    std::vector<InventoryItemView> items;
    std::vector<ItemStackView> item_stacks;
    std::vector<InteractionControlView> controls;
};

struct TextLogView {
    std::vector<TextLogEntry> entries;
};

struct MapLocationView {
    MapLocationId location;
    RoomId room;
    std::vector<compiled::MapPolygon> regions;
    std::optional<std::string> label;
    std::optional<AssetId> icon;
    std::optional<std::string> style;
    std::optional<compiled::Vector2> label_anchor;
    std::optional<compiled::Vector2> connection_anchor;
    std::int64_t pick_order = 0;
    std::int64_t logical_order = 0;
    bool current = false;
    bool visible = true;
    bool actionable = false;
    std::optional<compiled::RoomExitRef> convenience_exit;
};
struct MapConnectionView {
    MapConnectionId connection;
    std::vector<compiled::RoomExitRef> exits;
    MapLocationId source;
    MapLocationId target;
    std::optional<compiled::RoomExitRef> active_exit;
    std::optional<std::string> label;
    std::optional<AssetId> icon;
    std::optional<std::string> style;
    std::int64_t logical_order = 0;
    std::vector<compiled::Vector2> path;
    std::vector<compiled::MapPolygon> hit_regions;
    bool visible = true;
    bool actionable = false;
};
struct MapView {
    MapId map;
    compiled::InitialMapMode initial_mode;
    std::optional<RoomId> current_room;
    std::optional<std::string> title;
    std::optional<AssetId> background;
    std::optional<LayoutId> layout;
    std::vector<MapLocationView> locations;
    std::vector<MapConnectionView> connections;
};

struct TypedRuntimeUIViewState {
    std::string mode;
    // Authored/session source reported by Game.paused() and persisted by the runtime policy.
    bool gameplay_paused = false;
    // Derived shell/Layout/platform fact. This is presentation/runtime-loop state, not save state.
    EffectiveGameplayPause effective_gameplay_pause;
    std::optional<SceneView> scene;
    std::optional<DialogueView> dialogue;
    std::optional<RoomView> room;
    std::optional<InteractionView> interaction;
    InventoryView inventory;
    TextLogView text_log;
    std::vector<MapView> maps;
    std::vector<compiled::InteractionSubject> selected_subjects;
    std::vector<VerbOfferView> verb_offers;
    bool verb_menu_open = false;
    bool can_continue = false;
};

using FeatureView =
    std::variant<SceneView, DialogueView, RoomView, InteractionView, InventoryView, MapView>;

} // namespace noveltea::core
