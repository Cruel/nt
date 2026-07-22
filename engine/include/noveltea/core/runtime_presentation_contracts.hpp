#pragma once

#include "noveltea/core/feature_state.hpp"

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

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
    ActorPresentationKey key;
    CharacterId character;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    std::optional<compiled::CharacterIdle> idle;
    std::optional<AssetId> pose_sprite;
    std::optional<MaterialId> pose_material;
    compiled::Vector2 pose_anchor;
    compiled::Vector2 pose_offset;
    double pose_scale = 1.0;
    std::optional<AssetId> expression_sprite;
    std::optional<MaterialId> expression_material;
    ActorLogicalPlacement placement;
    std::optional<compiled::RoomPlacementRef> room_placement;
    std::optional<compiled::NormalizedRect> room_bounds;
    PresentationPlane plane = PresentationPlane::WorldContent;
    std::int32_t order = 0;
    bool enabled = true;
    bool visible = false;
    bool presentation_complete = true;
    bool operator==(const PresentationActor&) const = default;
};

struct PresentationInteractable {
    InteractableId interactable;
    compiled::RoomPlacementRef placement;
    compiled::NormalizedRect bounds;
    std::optional<AssetId> sprite;
    std::optional<MaterialId> material;
    PresentationPlane plane = PresentationPlane::WorldContent;
    std::int32_t order = 0;
    bool enabled = true;
    bool visible = true;
    bool operator==(const PresentationInteractable&) const = default;
};

struct RoomPropPresentationKey {
    RoomId room;
    RoomPropId prop;
    auto operator<=>(const RoomPropPresentationKey&) const = default;
};
struct ScopedPropPresentationKey {
    PresentationPropInstanceId instance;
    auto operator<=>(const ScopedPropPresentationKey&) const = default;
};
using PresentationPropKey = std::variant<RoomPropPresentationKey, ScopedPropPresentationKey>;

struct PresentationProp {
    PresentationPropKey key;
    PresentationOwner owner;
    std::optional<AssetId> asset;
    std::optional<MaterialId> material;
    std::optional<compiled::RoomPlacementRef> placement;
    compiled::NormalizedRect bounds;
    PresentationPlane plane = PresentationPlane::WorldContent;
    std::int32_t order = 0;
    bool visible = true;
    bool operator==(const PresentationProp&) const = default;
};

struct PresentationEnvironment {
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
    bool operator==(const PresentationEnvironment&) const = default;
};

struct PresentationMountedLayout {
    MountedLayoutPresentationKey key;
    PresentationOwner owner;
    LayoutId layout;
    MountedLayoutPolicy policy;
    LayoutScaleOverrides scale_overrides{};
    PresentationCompositionGroup composition_group = PresentationCompositionGroup::Interface;
    bool operator==(const PresentationMountedLayout&) const = default;
};

struct PresentationTextAndChoice {
    std::optional<PresentedTextState> text;
    std::optional<ActiveChoiceState> choice;
    bool operator==(const PresentationTextAndChoice&) const = default;
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

struct PresentationDesiredAudio {
    DesiredAudioInstanceId instance;
    PresentationOwner owner;
    compiled::AudioChannel bus = compiled::AudioChannel::Music;
    AssetId asset;
    double volume = 1.0;
    std::chrono::milliseconds fade_in{0};
    std::chrono::milliseconds fade_out{0};
    std::optional<DesiredAudioReplacementKey> replacement_key;
    bool operator==(const PresentationDesiredAudio&) const = default;
};

struct RuntimePresentationSnapshot {
    PresentationSnapshotRevision revision = PresentationSnapshotRevision::from_number(0);
    PresentationRuntimeMode mode = PresentationRuntimeMode::Flow;
    std::optional<RoomId> current_room;
    std::optional<PresentationBackground> background;
    std::vector<PresentationActor> actors;
    std::vector<PresentationInteractable> interactables;
    std::vector<PresentationProp> props;
    std::vector<PresentationEnvironment> environments;
    std::vector<PresentationMountedLayout> layouts;
    PresentationTextAndChoice text_and_choice;
    std::optional<PresentationMap> map;
    std::vector<PresentationDesiredAudio> desired_audio;
    bool operator==(const RuntimePresentationSnapshot&) const = default;
};

} // namespace noveltea::core
