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
    std::optional<PresentationOwner> material_owner;
    std::optional<AssetId> asset;
    std::optional<std::string> color;
    compiled::BackgroundFit fit = compiled::BackgroundFit::Cover;
    std::optional<MaterialId> material;
    bool operator==(const PresentationBackground&) const = default;
};

struct PresentationCamera {
    compiled::WorldPresentationSpace space;
    compiled::CameraView view;
    bool operator==(const PresentationCamera&) const = default;
};

struct PresentationActorLayer {
    CharacterPresentationLayerId id;
    std::optional<std::string> role;
    std::optional<AssetId> sprite;
    std::optional<MaterialId> material;
    compiled::Vector2 anchor;
    compiled::Vector2 offset;
    double scale = 1.0;
    bool visible = true;
    bool operator==(const PresentationActorLayer&) const = default;
};

struct PresentationActor {
    ActorPresentationKey key;
    std::optional<PresentationOwner> material_owner;
    CharacterId character;
    CharacterPresentationProfileId profile;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    std::optional<CharacterAppearanceId> appearance;
    std::optional<compiled::CharacterIdle> idle;
    std::vector<PresentationActorLayer> layers;
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

struct PresentationLayoutStateValue {
    LayoutStateScope scope = LayoutStateScope::Session;
    std::optional<PersistableValue> value;
    bool operator==(const PresentationLayoutStateValue&) const = default;
};

struct PresentationMountedLayout {
    MountedLayoutPresentationKey key;
    PresentationOwner owner;
    LayoutId layout;
    MountedLayoutPolicy policy;
    LayoutScaleOverrides scale_overrides{};
    PresentationCompositionGroup composition_group = PresentationCompositionGroup::Interface;
    std::optional<LayoutMountOccurrenceId> occurrence;
    std::vector<LayoutResolvedInput> inputs;
    std::vector<LayoutSignalId> connected_signals;
    std::optional<LayoutStateShape> state_shape;
    std::vector<PresentationLayoutStateValue> state_values;
    bool operator==(const PresentationMountedLayout&) const = default;
};

struct PresentationTextAndChoice {
    std::optional<PresentedTextState> text;
    std::optional<ActiveChoiceState> choice;
    bool operator==(const PresentationTextAndChoice&) const = default;
};

struct PresentationDesiredAudio {
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
    bool operator==(const PresentationDesiredAudio&) const = default;
};

struct PresentationMaterialParameter {
    PresentationOwner owner;
    MaterialOccurrence occurrence;
    MaterialId material;
    std::string parameter;
    std::optional<compiled::MaterialParameterValue> value;
    std::optional<MaterialStandardFacet> standard_facet;
    MaterialClockPolicy clock = MaterialClockPolicy::Gameplay;
    bool operator==(const PresentationMaterialParameter&) const = default;
};

struct AlphaHotspotShape {
    bool operator==(const AlphaHotspotShape&) const = default;
};

struct PresentationHotspot {
    compiled::HotspotRef ref;
    std::string label;
    bool condition_eligible = false;
    bool target_available = false;
    compiled::ResolvedHotspotTarget target;
    std::variant<AlphaHotspotShape, compiled::NormalizedRect> shape;
    std::int32_t input_order = 0;
    compiled::HotspotHighlight highlight;
    AssetId source_image;
    std::uint16_t source_width = 0;
    std::uint16_t source_height = 0;
    std::optional<compiled::RoomPlacementRef> interactable_placement;
    std::optional<compiled::NormalizedRect> interactable_bounds;
    PresentationPlane owner_plane = PresentationPlane::WorldBackground;
    std::int32_t owner_order = 0;
    bool operator==(const PresentationHotspot&) const = default;
};

struct RuntimePresentationSnapshot {
    PresentationSnapshotRevision revision = PresentationSnapshotRevision::from_number(0);
    PresentationRuntimeMode mode = PresentationRuntimeMode::Flow;
    std::optional<RoomId> current_room;
    std::optional<PresentationBackground> background;
    std::optional<PresentationCamera> camera;
    std::vector<PresentationActor> actors;
    std::vector<PresentationInteractable> interactables;
    std::vector<PresentationProp> props;
    std::vector<PresentationEnvironment> environments;
    std::vector<PresentationMaterialParameter> material_parameters;
    std::vector<DesiredPostprocessEffect> postprocess_effects;
    std::vector<PresentationMountedLayout> layouts;
    PresentationTextAndChoice text_and_choice;
    std::vector<PresentationOwner> active_audio_owners;
    std::vector<PresentationDesiredAudio> desired_audio;
    std::vector<PresentationHotspot> hotspots;
    bool operator==(const RuntimePresentationSnapshot&) const = default;
};

} // namespace noveltea::core
