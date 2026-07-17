#pragma once

#include "noveltea/core/feature_state.hpp"
#include "noveltea/core/result.hpp"

#include <cstdint>
#include <optional>
#include <variant>
#include <vector>

namespace noveltea::core {

class SessionState;
struct ResolvedRoomPresentation;

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
    std::string kind;
    PresentationPlane plane = PresentationPlane::WorldContent;
    std::int32_t order = 0;
    LayoutClockDomain clock = LayoutClockDomain::Gameplay;
    bool visible = true;
    bool operator==(const PresentationEnvironment&) const = default;
};

struct PresentationMountedLayout {
    MountedLayoutPresentationKey key;
    PresentationOwner owner;
    LayoutId layout;
    MountedLayoutPolicy policy;
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

struct PresentationAudioChannel {
    compiled::AudioChannel channel = compiled::AudioChannel::SoundEffect;
    std::optional<AssetId> asset;
    double volume = 1.0;
    bool loop = false;
    bool playing = false;
    bool operator==(const PresentationAudioChannel&) const = default;
};

// Collections are canonical by plane, local order/depth, and stable typed identity. Backend
// realization state never belongs in this snapshot. Audio remains the explicitly transitional
// one-record-per-channel family until the desired-audio cutover.
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
    std::vector<PresentationAudioChannel> audio_channels;
    bool operator==(const RuntimePresentationSnapshot&) const = default;
};

class PresentationProjector {
public:
    [[nodiscard]] static Result<RuntimePresentationSnapshot, Diagnostics>
    project(const CompiledProject& project, const SessionState& state,
            const ResolvedRoomPresentation* room_presentation = nullptr);
};

class RuntimePresentationSnapshotPublisher {
public:
    [[nodiscard]] Result<bool, Diagnostics>
    reproject(const CompiledProject& project, const SessionState& state,
              const ResolvedRoomPresentation* room_presentation = nullptr);
    [[nodiscard]] const RuntimePresentationSnapshot* published() const noexcept;

private:
    std::optional<RuntimePresentationSnapshot> m_published;
};

} // namespace noveltea::core
