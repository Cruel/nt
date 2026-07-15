#pragma once

#include "noveltea/core/feature_state.hpp"
#include "noveltea/core/result.hpp"

#include <cstdint>
#include <optional>
#include <variant>
#include <vector>

namespace noveltea::core {

class SessionState;

enum class PresentationRuntimeMode : std::uint8_t {
    Room,
    Flow,
    Ended
};

struct PresentationBackground {
    std::optional<AssetId> asset;
    std::optional<std::string> color;
    compiled::BackgroundFit fit = compiled::BackgroundFit::Cover;
    std::optional<MaterialId> material;
    bool operator==(const PresentationBackground&) const = default;
};

struct PresentationActor {
    ActorSlotKey key;
    CharacterId character;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    std::optional<AssetId> pose_sprite;
    std::optional<MaterialId> pose_material;
    compiled::Vector2 pose_anchor;
    compiled::Vector2 pose_offset;
    double pose_scale = 1.0;
    std::optional<AssetId> expression_sprite;
    std::optional<MaterialId> expression_material;
    ActorLogicalPlacement placement;
    bool visible = false;
    bool presentation_complete = true;
    bool operator==(const PresentationActor&) const = default;
};

struct PresentationRoomOverlay {
    RoomId room;
    RoomOverlayId overlay;
    LayoutId layout;
    bool visible = true;
    bool operator==(const PresentationRoomOverlay&) const = default;
};

struct PresentationLayoutSlot {
    compiled::LayoutSlot slot = compiled::LayoutSlot::Hud;
    LayoutId layout;
    bool operator==(const PresentationLayoutSlot&) const = default;
};

struct PresentationTextAndChoice {
    std::optional<PresentedTextState> text;
    std::optional<ActiveChoiceState> choice;
    bool operator==(const PresentationTextAndChoice&) const = default;
};

struct PresentationLogicalTransition {
    compiled::TransitionKind kind = compiled::TransitionKind::Cut;
    std::optional<std::string> color;
    bool complete = true;
    bool operator==(const PresentationLogicalTransition&) const = default;
};

struct PresentationMap {
    MapId map;
    compiled::InitialMapMode mode = compiled::InitialMapMode::Minimap;
    bool visible = false;
    std::optional<MapLocationId> focused_location;
    std::optional<AssetId> background;
    std::optional<LayoutId> layout;
    bool operator==(const PresentationMap&) const = default;
};

struct PresentationAudioChannel {
    compiled::AudioChannel channel = compiled::AudioChannel::SoundEffect;
    std::optional<AssetId> asset;
    double volume = 1.0;
    bool loop = false;
    bool playing = false;
    bool operator==(const PresentationAudioChannel&) const = default;
};

// Collections are canonical: actors by (scene, slot), overlays by (room, overlay), Layout slots by
// slot enum, and audio by channel enum. Optional members explicitly represent absent families.
// Phase 7 extends this value with reconstructible loop instances and replaces transitional audio.
struct RuntimePresentationSnapshot {
    std::uint64_t revision = 0;
    PresentationRuntimeMode mode = PresentationRuntimeMode::Flow;
    std::optional<RoomId> current_room;
    std::optional<PresentationBackground> background;
    std::vector<PresentationActor> actors;
    std::vector<PresentationRoomOverlay> overlays;
    std::vector<PresentationLayoutSlot> layout_slots;
    PresentationTextAndChoice text_and_choice;
    std::optional<PresentationLogicalTransition> transition;
    std::optional<PresentationMap> map;
    std::vector<PresentationAudioChannel> audio_channels;
    bool operator==(const RuntimePresentationSnapshot&) const = default;
};

class PresentationProjector {
public:
    [[nodiscard]] static Result<RuntimePresentationSnapshot, Diagnostics>
    project(const CompiledProject& project, const SessionState& state);
};

class RuntimePresentationSnapshotPublisher {
public:
    [[nodiscard]] Result<bool, Diagnostics> reproject(const CompiledProject& project,
                                                      const SessionState& state);
    [[nodiscard]] const RuntimePresentationSnapshot* published() const noexcept;

private:
    std::optional<RuntimePresentationSnapshot> m_published;
};

} // namespace noveltea::core
