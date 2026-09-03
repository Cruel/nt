#pragma once

#include "noveltea/core/execution_primitives.hpp"
#include "noveltea/core/gameplay_references.hpp"
#include "noveltea/core/layout_contracts.hpp"
#include "noveltea/core/layout_scale_policy.hpp"
#include "noveltea/core/property.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/text_content.hpp"
#include "noveltea/core/wait.hpp"

#include <cstddef>
#include <cstdint>
#include <array>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

namespace noveltea::core {
enum class PresentationPlane : std::uint8_t;
enum class LayoutClockDomain : std::uint8_t;
} // namespace noveltea::core

namespace noveltea::core::compiled {

inline constexpr std::string_view builtin_inventory_layout_id = "builtin-inventory";
inline constexpr std::string_view builtin_verb_menu_layout_id = "builtin-verb-menu";

struct TraitProperty {
    PropertyId property_id;
    PropertyValueType value_type;
    bool nullable;
    std::vector<std::string> enum_values;
    std::optional<RuntimeValue> configured_value;
    std::string label;
    std::string description;
};
using OwnerPropertyContract = TraitProperty;
struct InstanceLocalProperty {
    OwnerPropertyContract contract;
    RuntimeValue value;
};
struct TraitDefinition {
    TraitId id;
    std::string label;
    std::string description;
    std::vector<PropertyOwnerKind> allowed_owners;
    std::vector<TraitProperty> properties;
};

template<class Id> struct DefinitionIdentity {
    Id id;
};

template<class Id> struct PropertyBearingDefinition {
    Id id;
    std::vector<TraitId> traits;
    std::vector<PropertyAssignment> property_assignments;
};

struct Vector2 {
    double x;
    double y;
    bool operator==(const Vector2&) const = default;
};
struct NormalizedRect {
    double x;
    double y;
    double width;
    double height;
    bool operator==(const NormalizedRect&) const = default;
};

struct ProjectIdentity {
    ProjectId id;
    std::string name;
    std::string version;
    std::string author;
    std::string description;
};
using Entrypoint = std::variant<RoomId, SceneId, DialogueId>;

struct LocalizationEntry {
    std::string key;
    std::string value;
};
struct LocalizationCatalog {
    std::string locale;
    std::vector<LocalizationEntry> entries;
};
struct Localization {
    std::string default_locale;
    std::optional<std::string> fallback_locale;
    std::vector<LocalizationCatalog> catalogs;
};

struct InventoryDefinition {
    InventoryId id;
    std::string label;
    bool operator==(const InventoryDefinition&) const = default;
};
enum class AssetKind : std::uint8_t {
    Image,
    Font,
    Audio,
    Script,
    ShaderSource,
    Text,
    Data,
    Binary
};
enum class ImageSampling : std::uint8_t {
    Linear,
    Nearest
};
struct AssetResource {
    AssetId id;
    AssetKind kind;
    std::string path;
    std::vector<std::string> aliases;
    std::optional<ImageSampling> sampling;
    std::optional<std::uint32_t> width;
    std::optional<std::uint32_t> height;
};
struct InlineLayoutSource {
    std::string text;
};
struct AssetLayoutSource {
    AssetId asset;
};
using LayoutSource = std::variant<InlineLayoutSource, AssetLayoutSource>;
enum class LayoutKind : std::uint8_t {
    Document,
    Fragment
};
enum class LayoutTarget : std::uint8_t {
    DefaultUi,
    DialogueUi,
    SceneOverlay,
    RoomOverlay,
    MenuUi,
    CustomOverlay
};
struct LayoutDependencies {
    std::vector<AssetId> fonts;
    std::vector<AssetId> images;
    std::vector<MaterialId> materials;
    std::vector<AssetId> scripts;
    std::vector<AssetId> stylesheets;
};
struct LayoutResource {
    LayoutId id;
    LayoutKind kind;
    LayoutTarget target;
    LayoutScalePolicy scale_policy;
    LayoutContract contract;
    LayoutSource rml;
    LayoutSource rcss;
    LayoutSource lua;
    LayoutDependencies dependencies;
    std::optional<std::string> default_parent;
    bool scoped_styles;
    bool script_enabled;
    std::optional<std::string> script_namespace;
};
struct InlineLuaSource {
    std::string source;
};
struct AssetScriptSource {
    AssetId asset;
};
using ScriptSource = std::variant<InlineLuaSource, AssetScriptSource>;
struct ScriptResource {
    ScriptId id;
    ScriptSource source;
};

enum class MaterialRole : std::uint8_t {
    Engine2D,
    ActiveText,
    RmlUiDecorator,
    RmlUiFilter,
    Postprocess,
    HotspotOverlay,
};
enum class MaterialParameterType : std::uint8_t {
    Float,
    Vec2,
    Vec3,
    Vec4,
    Color,
    Int,
    Bool,
};
enum class MaterialPostprocessScope : std::uint8_t {
    World,
    FullGameViewport,
};
struct MaterialColorValue {
    double r = 1.0;
    double g = 1.0;
    double b = 1.0;
    double a = 1.0;
    bool operator==(const MaterialColorValue&) const = default;
};
using MaterialParameterValue =
    std::variant<double, std::array<double, 2>, std::array<double, 3>, std::array<double, 4>,
                 MaterialColorValue, std::int64_t, bool>;
struct MaterialParameterDeclaration {
    std::string name;
    MaterialParameterType type = MaterialParameterType::Float;
    std::optional<std::string> renderer_binding;
    bool operator==(const MaterialParameterDeclaration&) const = default;
};
struct MaterialInterfaceResource {
    MaterialId id;
    MaterialRole role = MaterialRole::Engine2D;
    MaterialPostprocessScope postprocess_scope = MaterialPostprocessScope::World;
    std::vector<MaterialParameterDeclaration> parameters;
    bool operator==(const MaterialInterfaceResource&) const = default;
};

struct AspectRatio {
    std::uint32_t width;
    std::uint32_t height;
};
inline constexpr std::uint32_t max_reference_resolution_dimension = 10'000;
struct ReferenceResolution {
    std::uint32_t width;
    std::uint32_t height;
};
enum class DisplayOrientation : std::uint8_t {
    Landscape,
    Portrait
};
enum class WorldRasterPolicy : std::uint8_t {
    Capped,
    Native
};
struct DisplaySettings {
    ReferenceResolution reference_resolution;
    std::string bar_color;
    WorldRasterPolicy world_raster_policy;
};
struct AccessibilityScalePolicy {
    bool enabled;
    double minimum;
    double maximum;
};
struct AccessibilitySettings {
    AccessibilityScalePolicy ui_scale;
    AccessibilityScalePolicy text_scale;
};
enum class SystemLayoutRole : std::uint8_t {
    Title,
    GameHud,
    PauseMenu,
    LoadMenu,
    SettingsMenu,
    Modal,
    DebugOverlay,
    SaveMenu,
    TextLog,
    CommandBuilder,
    SceneText,
    SceneChoice
};
struct SystemLayout {
    SystemLayoutRole role;
    std::optional<LayoutId> layout;
};
struct TextSettings {
    std::optional<AssetId> default_font;
};
struct TitleScreenSettings {
    bool show_author;
    bool show_project_title;
    std::string start_label;
    std::string subtitle;
    std::optional<AssetId> title_image;
};
enum class AudioPurpose : std::uint8_t {
    Music,
    Ambience,
    Voice,
    SoundEffect,
    UiSound
};
struct AudioPurposeMixSettings {
    double volume = 1.0;
    bool muted = false;
};
struct VoiceDuckingSettings {
    bool enabled = false;
    double music_gain = 0.5;
    double ambience_gain = 0.5;
};
struct AudioMixSettings {
    AudioPurposeMixSettings music;
    AudioPurposeMixSettings ambience;
    AudioPurposeMixSettings voice;
    AudioPurposeMixSettings sound_effect;
    AudioPurposeMixSettings ui_sound;
    VoiceDuckingSettings voice_ducking;
};
struct InventorySettings {
    std::optional<InventoryId> player_inventory;
    std::optional<LayoutId> default_layout;
};
struct InteractionPresentationSettings {
    std::optional<LayoutId> default_verb_menu_layout;
};
enum class TransitionKind : std::uint8_t {
    Fade,
    Cut,
    Dissolve
};
struct RoomNavigationTransition {
    TransitionKind kind;
    std::uint64_t duration_ms;
    std::optional<std::string> color;
    bool skippable;
};
struct RuntimeSettings {
    DisplaySettings display;
    AccessibilitySettings accessibility;
    std::vector<SystemLayout> system_layouts;
    TextSettings text;
    TitleScreenSettings title_screen;
    RoomNavigationTransition room_navigation_transition{TransitionKind::Cut, 0, std::nullopt, true};
    AudioMixSettings audio;
    InventorySettings inventory;
    InteractionPresentationSettings interaction;
};

enum class BackgroundFit : std::uint8_t {
    Cover,
    Contain,
    Stretch,
    Center
};
struct BackgroundPresentation {
    std::optional<AssetId> asset;
    std::optional<std::string> color;
    BackgroundFit fit;
    std::optional<MaterialId> material;
    bool operator==(const BackgroundPresentation&) const = default;
};
struct RoomPlacementRef {
    RoomId room;
    RoomPlacementId placement_id;
    bool operator==(const RoomPlacementRef&) const = default;
};

struct CharacterPresentationLayer {
    CharacterPresentationLayerId id;
    std::optional<std::string> role;
    bool operator==(const CharacterPresentationLayer&) const = default;
};
struct CharacterLayerComposition {
    CharacterPresentationLayerId layer_id;
    std::optional<AssetId> sprite;
    std::optional<MaterialId> material;
    Vector2 offset;
    double scale;
    Vector2 anchor;
    bool visible;
    bool operator==(const CharacterLayerComposition&) const = default;
};
struct CharacterPose {
    CharacterPoseId id;
    std::vector<CharacterLayerComposition> layers;
    bool operator==(const CharacterPose&) const = default;
};
template<typename T> struct CharacterOptionalOverride {
    bool specified = false;
    std::optional<T> value;
    bool operator==(const CharacterOptionalOverride&) const = default;
};
struct CharacterAnimationLayerFrame {
    CharacterPresentationLayerId layer_id;
    CharacterOptionalOverride<AssetId> sprite;
    CharacterOptionalOverride<MaterialId> material;
    std::optional<Vector2> offset;
    std::optional<double> scale;
    std::optional<Vector2> anchor;
    std::optional<bool> visible;
    bool operator==(const CharacterAnimationLayerFrame&) const = default;
};
struct CharacterAnimationFrame {
    std::uint64_t duration_ms;
    std::vector<CharacterAnimationLayerFrame> layers;
    bool operator==(const CharacterAnimationFrame&) const = default;
};
struct CharacterAnimationClip {
    CharacterAnimationClipId id;
    LayoutClockDomain clock;
    std::vector<CharacterAnimationFrame> frames;
    bool operator==(const CharacterAnimationClip&) const = default;
};
struct CharacterAutomaticBlink {
    CharacterAnimationClipId clip_id;
    std::string role;
    std::uint64_t interval_ms;
    bool operator==(const CharacterAutomaticBlink&) const = default;
};
struct CharacterAutomaticSpeaking {
    CharacterAnimationClipId clip_id;
    std::string role;
    bool operator==(const CharacterAutomaticSpeaking&) const = default;
};
struct CharacterAutomaticAnimations {
    std::optional<CharacterAutomaticBlink> blink;
    std::optional<CharacterAutomaticSpeaking> speaking;
    bool operator==(const CharacterAutomaticAnimations&) const = default;
};
struct CharacterPresentationProfile {
    CharacterPresentationProfileId id;
    std::vector<CharacterPresentationLayer> layers;
    CharacterPoseId default_pose_id;
    std::vector<CharacterPose> poses;
    std::vector<CharacterAnimationClip> animation_clips;
    CharacterAutomaticAnimations automatic_animations;
    bool operator==(const CharacterPresentationProfile&) const = default;
};
struct CharacterLayerOverride {
    CharacterPresentationLayerId layer_id;
    CharacterOptionalOverride<AssetId> sprite;
    CharacterOptionalOverride<MaterialId> material;
    std::optional<bool> visible;
    bool operator==(const CharacterLayerOverride&) const = default;
};
struct CharacterProfileLayerOverrides {
    CharacterPresentationProfileId profile_id;
    std::vector<CharacterLayerOverride> layers;
    bool operator==(const CharacterProfileLayerOverrides&) const = default;
};
struct CharacterExpression {
    CharacterExpressionId id;
    std::vector<CharacterProfileLayerOverrides> profiles;
    bool operator==(const CharacterExpression&) const = default;
};
struct CharacterAppearance {
    CharacterAppearanceId id;
    std::vector<CharacterProfileLayerOverrides> profiles;
    bool operator==(const CharacterAppearance&) const = default;
};
enum class CharacterIdleKind : std::uint8_t {
    Bob,
    Sway,
    Pulse,
};
struct CharacterIdle {
    CharacterIdleId id;
    CharacterIdleKind kind;
    double amplitude;
    std::uint64_t period_ms;
    LayoutClockDomain clock;
    bool operator==(const CharacterIdle&) const = default;
};
struct CharacterPresentationGestureCue {
    CharacterGestureCueId id;
    std::uint64_t at_ms;
    CharacterGestureEventId event;
    bool operator==(const CharacterPresentationGestureCue&) const = default;
};
struct CharacterAudioGestureCue {
    CharacterGestureCueId id;
    std::uint64_t at_ms;
    AssetId asset;
    double gain = 1.0;
    double pan = 0.0;
    bool operator==(const CharacterAudioGestureCue&) const = default;
};
using CharacterGestureCue = std::variant<CharacterPresentationGestureCue, CharacterAudioGestureCue>;
struct CharacterGestureProfile {
    CharacterPresentationProfileId profile_id;
    CharacterAnimationClipId clip_id;
    std::vector<CharacterGestureCue> cues;
    bool operator==(const CharacterGestureProfile&) const = default;
};
struct CharacterGesture {
    CharacterGestureId id;
    std::vector<CharacterGestureProfile> profiles;
    bool operator==(const CharacterGesture&) const = default;
};
struct CharacterDialoguePresentation {
    std::string name;
    std::optional<std::string> name_color;
    std::string style_class;
    std::optional<std::string> text_color;
};
struct CharacterDefaults {
    CharacterPresentationProfileId profile_id;
    CharacterExpressionId expression_id;
    std::optional<CharacterAppearanceId> appearance_id;
    std::optional<CharacterIdleId> idle_id;
};
using CharacterInitialWorldLocation = std::variant<UnplacedLocation, RoomLocation>;
struct CharacterInitialWorldState {
    CharacterInitialWorldLocation location;
    bool enabled;
    bool visible;
};
struct CharacterDefinition {
    PropertyBearingDefinition<CharacterId> identity;
    std::string display_name;
    std::vector<OwnerPropertyContract> properties;
    CharacterDialoguePresentation dialogue;
    CharacterDefaults defaults;
    std::vector<CharacterPresentationProfile> profiles;
    std::vector<CharacterExpression> expressions;
    std::vector<CharacterAppearance> appearances;
    std::vector<CharacterGesture> gestures;
    std::vector<CharacterIdle> idles;
    std::vector<InventoryDefinition> inventories;
    CharacterInitialWorldState initial_world_state;
};

struct FeatureDefinition {
    PropertyBearingDefinition<FeatureId> identity;
    std::string label;
    std::vector<OwnerPropertyContract> properties;
    std::vector<InventoryDefinition> inventories;
};
struct CharacterInteractionSubject {
    CharacterId character;
    bool operator==(const CharacterInteractionSubject&) const = default;
};
struct InteractableInteractionSubject {
    InteractableInstanceId interactable;
    bool operator==(const InteractableInteractionSubject&) const = default;
};
struct FeatureInteractionSubject {
    FeatureRef feature;
    bool operator==(const FeatureInteractionSubject&) const = default;
};
using InteractionSubject = std::variant<CharacterInteractionSubject, InteractableInteractionSubject,
                                        FeatureInteractionSubject>;

struct RoomExitRef {
    RoomId room;
    RoomExitId exit_id;
    auto operator<=>(const RoomExitRef&) const = default;
};
struct RoomHotspotRef {
    RoomId room;
    HotspotId hotspot_id;
    auto operator<=>(const RoomHotspotRef&) const = default;
};
struct InteractableHotspotRef {
    InteractableInstanceId interactable;
    HotspotId hotspot_id;
    auto operator<=>(const InteractableHotspotRef&) const = default;
};
using HotspotRef = std::variant<RoomHotspotRef, InteractableHotspotRef>;
struct RoomHotspotOwnerRef {
    RoomId room;
    auto operator<=>(const RoomHotspotOwnerRef&) const = default;
};
struct InteractableHotspotOwnerRef {
    InteractableInstanceId interactable;
    auto operator<=>(const InteractableHotspotOwnerRef&) const = default;
};
using HotspotOwnerRef = std::variant<RoomHotspotOwnerRef, InteractableHotspotOwnerRef>;
struct DefaultHotspotHighlight {
    auto operator<=>(const DefaultHotspotHighlight&) const = default;
};
struct NoHotspotHighlight {
    auto operator<=>(const NoHotspotHighlight&) const = default;
};
struct MaterialHotspotHighlight {
    MaterialId material;
    auto operator<=>(const MaterialHotspotHighlight&) const = default;
};
using HotspotHighlight =
    std::variant<DefaultHotspotHighlight, MaterialHotspotHighlight, NoHotspotHighlight>;
struct HotspotOwnerTarget {
    auto operator<=>(const HotspotOwnerTarget&) const = default;
};
struct HotspotOwnerFeatureTarget {
    FeatureId feature_id;
    auto operator<=>(const HotspotOwnerFeatureTarget&) const = default;
};
struct HotspotSubjectTarget {
    InteractionSubject subject;
    bool operator==(const HotspotSubjectTarget&) const = default;
};
struct RoomExitHotspotTarget {
    RoomExitId exit_id;
    auto operator<=>(const RoomExitHotspotTarget&) const = default;
};
using RoomHotspotTarget =
    std::variant<HotspotOwnerFeatureTarget, HotspotSubjectTarget, RoomExitHotspotTarget>;
using InteractableHotspotTarget =
    std::variant<HotspotOwnerTarget, HotspotOwnerFeatureTarget, HotspotSubjectTarget>;
using ResolvedHotspotTarget = std::variant<InteractionSubject, RoomExitRef>;
struct RectHotspotShape {
    NormalizedRect bounds;
    bool operator==(const RectHotspotShape&) const = default;
};
struct RoomHotspot {
    HotspotId id;
    std::string label;
    Condition condition;
    std::int32_t input_order;
    HotspotHighlight highlight;
    RectHotspotShape shape;
    RoomHotspotTarget target;
};
struct InteractableHotspotBehavior {
    HotspotId id;
    std::string label;
    Condition condition;
    std::int32_t input_order;
    HotspotHighlight highlight;
    InteractableHotspotTarget target;
};
struct InteractableCustomHotspot : InteractableHotspotBehavior {
    RectHotspotShape shape;
};
struct NoInteractableHotspots {};
struct SpriteAlphaHotspots {
    InteractableHotspotBehavior hotspot;
};
struct CustomInteractableHotspots {
    std::vector<InteractableCustomHotspot> hotspots;
};
using InteractableHotspots =
    std::variant<NoInteractableHotspots, SpriteAlphaHotspots, CustomInteractableHotspots>;
struct RoomPlacementPresentation {
    std::optional<TextContent> label;
    std::optional<LayoutId> layout;
};
struct RoomPlacement {
    RoomPlacementId id;
    NormalizedRect bounds;
    std::int32_t order = 0;
    RoomPlacementPresentation presentation;
};
struct WorldPresentationRect {
    double x = 0.0;
    double y = 0.0;
    double width = 0.0;
    double height = 0.0;
    bool operator==(const WorldPresentationRect&) const = default;
};
struct CameraView {
    Vector2 center{0.0, 0.0};
    double zoom = 1.0;
    double rotation_degrees = 0.0;
    bool operator==(const CameraView&) const = default;
};
struct NamedCameraView {
    CameraViewId id;
    CameraView view;
    bool operator==(const NamedCameraView&) const = default;
};
enum class WorldPresentationEdgePolicy : std::uint8_t {
    Contain,
    Overscan,
};
struct WorldPresentationSpace {
    Vector2 size{1920.0, 1080.0};
    std::optional<WorldPresentationRect> bounds;
    WorldPresentationEdgePolicy edge_policy = WorldPresentationEdgePolicy::Contain;
    CameraView default_view{{960.0, 540.0}, 1.0, 0.0};
    std::vector<NamedCameraView> views;
    bool operator==(const WorldPresentationSpace&) const = default;
};
struct RoomAnchor {
    RoomAnchorId id;
    NormalizedRect bounds;
    bool operator==(const RoomAnchor&) const = default;
};
enum class RoomExitDirection : std::uint8_t {
    Northwest,
    North,
    Northeast,
    West,
    East,
    Southwest,
    South,
    Southeast,
    Custom
};
struct RoomExit {
    RoomExitId id;
    Condition condition;
    RoomExitDirection direction;
    TextContent label;
    RoomId target;
    std::optional<RoomNavigationTransition> transition;
    std::vector<GameplayCommand> on_rejected;
};
struct RoomLifecycle {
    Condition can_enter;
    Condition can_leave;
    std::vector<GameplayCommand> before_enter;
    std::vector<GameplayCommand> after_enter;
    std::vector<GameplayCommand> before_leave;
    std::vector<GameplayCommand> after_leave;
    std::vector<GameplayCommand> on_enter_rejected;
    std::vector<GameplayCommand> on_leave_rejected;
};
struct RoomOverlay {
    RoomOverlayId id;
    LayoutId layout;
    Condition condition;
    bool visible;
    std::int32_t order = 0;
};
struct RoomCastEntry {
    RoomCastEntryId id;
    CharacterId character;
    Condition condition;
    RoomPlacementId placement_id;
    std::optional<CharacterPresentationProfileId> profile_id;
    std::optional<CharacterPoseId> pose_id;
    std::optional<CharacterExpressionId> expression_id;
    std::optional<CharacterAppearanceId> appearance_id;
    std::optional<CharacterIdleId> idle_id;
    bool visible;
    std::int32_t order = 0;
};
struct RoomInteractableEntry {
    RoomInteractableEntryId id;
    InteractableInstanceId interactable;
    Condition condition;
    RoomPlacementId placement_id;
    bool visible;
    std::int32_t order = 0;
};
struct RoomProp {
    RoomPropId id;
    Condition condition;
    RoomPlacementId placement_id;
    std::optional<AssetId> asset;
    std::optional<MaterialId> material;
    bool visible;
    std::int32_t order = 0;
};
struct RoomEnvironment {
    RoomEnvironmentId id;
    Condition condition;
    std::optional<AssetId> asset;
    MaterialId material;
    NormalizedRect bounds;
    PresentationPlane plane;
    std::int32_t order;
    LayoutClockDomain clock;
    Vector2 scroll_per_second;
    double opacity;
    bool visible;
    bool operator==(const RoomEnvironment&) const = default;
};
enum class RoomScriptHookKind : std::uint8_t {
    CanEnter,
    CanLeave,
    RejectEnter,
    RejectLeave,
    BeforeEnter,
    AfterEnter,
    BeforeLeave,
    AfterLeave,
    Compose
};
struct ScriptHookHandlerReference {
    ScriptId module;
    std::string export_name;
};
struct RoomScriptHookMapping {
    RoomScriptHookKind hook;
    ScriptHookHandlerReference handler;
};
struct RoomDefinition {
    PropertyBearingDefinition<RoomId> identity;
    std::string display_name;
    std::vector<OwnerPropertyContract> properties;
    TextContent description;
    BackgroundPresentation background;
    WorldPresentationSpace presentation_space;
    std::vector<RoomAnchor> anchors;
    RoomLifecycle lifecycle;
    std::vector<RoomOverlay> overlays;
    std::vector<RoomCastEntry> cast;
    std::vector<RoomInteractableEntry> interactables;
    std::optional<RoomPlacementId> fallback_interactable_placement;
    std::vector<RoomProp> props;
    std::vector<RoomEnvironment> environments;
    std::vector<RoomScriptHookMapping> script_hooks;
    std::vector<RoomPlacement> placements;
    std::vector<RoomExit> exits;
    std::vector<FeatureDefinition> features;
    std::vector<RoomHotspot> hotspots;
};

using InteractableLocation = std::variant<InventoryLocation, UnplacedLocation, RoomLocation>;
struct InteractablePresentation {
    std::optional<MaterialId> material;
    std::optional<AssetId> sprite;
    InteractableHotspots hotspots;
};
struct InteractableDefinition {
    PropertyBearingDefinition<InteractableDefinitionId> identity;
    std::string display_name;
    bool stackable = false;
    std::optional<std::uint64_t> stack_limit;
    std::vector<OwnerPropertyContract> properties;
    std::vector<FeatureDefinition> features;
    std::vector<InventoryDefinition> inventories;
    InteractablePresentation presentation;
};
struct InteractableFeatureOverride {
    FeatureId feature_id;
    std::vector<TraitId> trait_adds;
    std::vector<TraitId> trait_removes;
    std::vector<PropertyAssignment> property_overrides;
};
struct InteractableInstanceDeclaration {
    InteractableInstanceId id;
    InteractableDefinitionId definition;
    InteractableLocation location;
    bool enabled;
    bool visible;
    std::uint64_t quantity = 1;
    std::vector<TraitId> trait_adds;
    std::vector<TraitId> trait_removes;
    std::vector<PropertyAssignment> property_overrides;
    std::vector<InstanceLocalProperty> local_properties;
    std::vector<InteractableFeatureOverride> feature_overrides;
};

inline constexpr std::uint64_t max_interactable_quantity = 9'007'199'254'740'991ULL;

enum class GameplayInstanceKind : std::uint8_t {
    Room,
    Character,
    Interactable,
};

// Archetype configuration is compiled, fully resolved vocabulary. The contained definition-shaped
// value is a template only: its identity field is never indexed or exposed as a Gameplay Instance.
// RuntimeWorld replaces that placeholder with a session-owned identity when creating an instance.
using ArchetypeConfiguration =
    std::variant<RoomDefinition, CharacterDefinition, InteractableDefinition>;
struct ArchetypeDefinition {
    ArchetypeId id;
    GameplayInstanceKind kind;
    ArchetypeConfiguration configuration;
};

enum class InteractionOutcome : std::uint8_t {
    Handled,
    Unhandled
};
struct InteractionProgram {
    std::vector<GameplayCommand> instructions;
    FlowTarget completion;
    InteractionOutcome outcome;
};
enum class SubjectFamily : std::uint8_t {
    Character,
    Interactable,
    Feature
};
struct AnySubjectSelector {};
struct FamilySubjectSelector {
    SubjectFamily family;
};
struct TraitSubjectSelector {
    TraitId trait;
};
struct InteractableDefinitionSubjectSelector {
    InteractableDefinitionId interactable_definition;
};
struct InteractableFeatureSubjectSelector {
    InteractableDefinitionId interactable_definition;
    FeatureId feature_id;
};
struct QualifiedPatternSubjectSelector {
    SubjectFamily family;
    std::string pattern;
};
struct ExactSubjectSelector {
    InteractionSubject subject;
};
using SubjectSelector =
    std::variant<AnySubjectSelector, FamilySubjectSelector, TraitSubjectSelector,
                 InteractableDefinitionSubjectSelector, InteractableFeatureSubjectSelector,
                 QualifiedPatternSubjectSelector, ExactSubjectSelector>;
struct InteractionSlotSelector {
    VerbSlotId slot_id;
    std::vector<SubjectSelector> selectors;
};
struct InteractionOffer {
    VerbSlotId slot_id;
    std::optional<Condition> condition;
    std::int64_t rank = 0;
    bool primary = false;
};
struct InteractionRule {
    InteractionRuleId id;
    VerbId verb;
    std::vector<InteractionSlotSelector> slots;
    std::optional<InteractionOffer> offer;
    Condition guard;
    std::int64_t priority = 0;
    InteractionProgram program;
};
struct InteractionDefinition {
    DefinitionIdentity<InteractionId> identity;
    std::vector<InteractionRule> rules;
};
struct VerbSlot {
    VerbSlotId id;
    TextContent label;
    TextContent prompt;
    std::vector<SubjectSelector> selectors;
};
struct VerbOffer {
    VerbOfferId id;
    VerbSlotId slot_id;
    std::vector<SubjectSelector> selectors;
    std::optional<Condition> condition;
    std::int64_t rank = 0;
    bool primary = false;
};
struct VerbDefinition {
    DefinitionIdentity<VerbId> identity;
    TextContent action_text;
    TextContent completed_command_text;
    std::vector<VerbSlot> slots;
    std::vector<VerbSlotId> binding_order;
    std::vector<VerbOffer> offers;
    Condition availability;
    InteractionProgram default_program;
};

enum class BackgroundTransition : std::uint8_t {
    None,
    Fade,
    Cut
};
enum class ScenePresentationOwner : std::uint8_t {
    Invocation,
    ActiveRoom,
    RuntimeSession,
};
struct SetBackgroundInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    ScenePresentationOwner owner = ScenePresentationOwner::Invocation;
    BackgroundPresentation background;
    BackgroundTransition transition;
    std::uint64_t duration_ms;
    PresentationInstructionWait wait;
    bool skippable;
};
enum class ActorCueAction : std::uint8_t {
    Show,
    Hide,
    Move,
    Profile,
    Pose,
    Expression,
    Appearance
};
enum class ActorPosition : std::uint8_t {
    Left,
    Center,
    Right,
    Custom
};
enum class ActorTransition : std::uint8_t {
    None,
    Fade,
    Slide
};
struct ActorCueInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    ScenePresentationOwner owner = ScenePresentationOwner::Invocation;
    ActorCueAction action;
    CharacterId character;
    std::optional<CharacterPresentationProfileId> profile_id;
    std::optional<CharacterExpressionId> expression_id;
    std::optional<CharacterAppearanceId> appearance_id;
    Vector2 offset;
    std::optional<CharacterPoseId> pose_id;
    ActorPosition position;
    double scale;
    ActorSlotId slot_id;
    ActorTransition transition;
    std::uint64_t duration_ms;
    PresentationInstructionWait wait;
    bool skippable;
};
struct SceneInputBinding {
    SceneInputId input_id;
    RuntimeValue value;
};
struct CallSceneSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    bool autosave_safe_point;
    SceneId scene;
    std::vector<SceneInputBinding> inputs;
};
enum class DetachedSceneOwner : std::uint8_t {
    Flow,
    ActiveRoom,
    RuntimeSession,
};
struct StartDetachedSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    bool autosave_safe_point;
    SceneId scene;
    std::vector<SceneInputBinding> inputs;
    DetachedSceneOwner owner = DetachedSceneOwner::Flow;
};
struct CallDialogueSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    bool autosave_safe_point;
    DialogueId dialogue;
    std::optional<DialogueBlockId> start_block_id;
};
struct ResumeDialogueSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    bool autosave_safe_point;
};
struct ShowTextInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    bool autosave_safe_point;
    std::optional<CharacterId> speaker;
    TextContent text;
    InputInstructionWait wait;
};
enum class AudioAction : std::uint8_t {
    Play,
    Stop,
    FadeIn,
    FadeOut
};
enum class AudioLifetime : std::uint8_t {
    DesiredLoop,
    OneShot
};
enum class AudioPausePolicy : std::uint8_t {
    Gameplay,
    Owner,
    Unscaled
};
enum class AudioCausality : std::uint8_t {
    Causal,
    Disposable
};
enum class AudioSkipBehavior : std::uint8_t {
    Stop,
    Suppress,
    Play
};
struct SceneActorAudioPanSource {
    ActorSlotId slot;
    bool operator==(const SceneActorAudioPanSource&) const = default;
};
struct RoomAnchorAudioPanSource {
    RoomId room;
    RoomAnchorId anchor;
    bool operator==(const RoomAnchorAudioPanSource&) const = default;
};
using AudioPanSource = std::variant<SceneActorAudioPanSource, RoomAnchorAudioPanSource>;
struct AudioCueInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    ScenePresentationOwner owner = ScenePresentationOwner::Invocation;
    AudioAction action;
    std::optional<AssetId> asset;
    AudioPurpose purpose = AudioPurpose::SoundEffect;
    AudioLifetime lifetime = AudioLifetime::OneShot;
    AudioPausePolicy pause_policy = AudioPausePolicy::Gameplay;
    double gain = 1.0;
    double pan = 0.0;
    std::optional<AudioPanSource> pan_source;
    std::uint64_t fade_ms = 0;
    AudioInstructionWait wait = ImmediateWait{};
    AudioCausality causality = AudioCausality::Causal;
    bool synchronized = false;
    AudioSkipBehavior skip_behavior = AudioSkipBehavior::Suppress;
    std::optional<std::string> instance_id;
    std::optional<std::string> replacement_group;
};
struct GameplayEffectBatchSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    std::vector<GameplayCommand> operations;
};
using SceneGameplayInstanceRef = std::variant<RoomId, CharacterId, InteractableInstanceId>;
struct SceneArchetypeConfigurationSource {
    ArchetypeId archetype;
};
struct SceneCompiledInstanceConfigurationSource {
    SceneGameplayInstanceRef instance;
};
struct SceneEffectiveInstanceConfigurationSource {
    SceneGameplayInstanceRef instance;
};
using SceneInstanceConfigurationSource =
    std::variant<SceneArchetypeConfigurationSource, SceneCompiledInstanceConfigurationSource,
                 SceneEffectiveInstanceConfigurationSource>;
struct CreateRoomSceneWorldOperation {
    SceneInstanceConfigurationSource source;
};
struct CreateCharacterSceneWorldOperation {
    SceneInstanceConfigurationSource source;
    CharacterInitialWorldLocation location;
    bool enabled = true;
    bool visible = true;
};
struct CreateInteractableSceneWorldOperation {
    InteractableDefinitionId definition;
    std::uint64_t quantity = 1;
    InteractableLocation location;
    bool enabled = true;
    bool visible = true;
    RoomPresentationPolicy room_presentation = RoomPresentationPolicy::Resolve;
};
struct ReplaceConfigurationSceneWorldOperation {
    SceneGameplayInstanceRef instance;
    SceneInstanceConfigurationSource source;
};
struct ClearConfigurationSceneWorldOperation {
    SceneGameplayInstanceRef instance;
};
struct RetargetRoomExitSceneWorldOperation {
    RoomId room;
    RoomExitId exit;
    RoomId target;
};
struct DestroyInstanceSceneWorldOperation {
    SceneGameplayInstanceRef instance;
};
using SceneRuntimeWorldOperation =
    std::variant<CreateRoomSceneWorldOperation, CreateCharacterSceneWorldOperation,
                 CreateInteractableSceneWorldOperation, ReplaceConfigurationSceneWorldOperation,
                 ClearConfigurationSceneWorldOperation, RetargetRoomExitSceneWorldOperation,
                 DestroyInstanceSceneWorldOperation>;
struct RuntimeWorldTransactionSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    std::vector<SceneRuntimeWorldOperation> operations;
};
struct DirectedRoomChangeSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    RoomId room;
};
struct NavigationAttemptSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    RoomId room;
    RoomExitId exit;
};
struct SceneInteractionBinding {
    VerbSlotId slot;
    InteractionSubject subject;
};
struct CallInteractionSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    VerbId verb;
    std::vector<SceneInteractionBinding> bindings;
};
struct RunLuaSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    bool autosave_safe_point;
    bool may_yield;
    std::string source;
};
struct WaitDurationInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    DurationWait wait;
    bool skippable;
};
struct WaitInputInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    bool skippable;
};
struct WaitConditionInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    Condition wait_condition;
    bool skippable;
};
struct WaitOperationInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    SceneStepId event;
    bool skippable;
};
struct WaitAudioInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    SceneStepId event;
    bool skippable;
};
enum class LayoutSlot : std::uint8_t;
struct WaitLayoutSignalInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    ScenePresentationOwner owner = ScenePresentationOwner::Invocation;
    LayoutSlot slot;
    LayoutSignalId signal;
    bool skippable;
};
struct SceneBranch {
    SceneBranchId id;
    Condition condition;
    SceneStepId target_instruction_id;
};
struct ConditionalBranchInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    std::vector<SceneBranch> branches;
    SceneStepId fallback_instruction_id;
};
struct SceneChoiceOption {
    SceneChoiceOptionId id;
    std::optional<Condition> condition;
    std::vector<GameplayCommand> effects;
    TextContent label;
    SceneStepId target_instruction_id;
};
struct ChoiceSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    bool autosave_safe_point;
    std::vector<SceneChoiceOption> options;
    std::optional<TextContent> prompt;
};
enum class LayoutAction : std::uint8_t {
    Show,
    Hide,
    Swap
};
enum class LayoutSlot : std::uint8_t {
    Hud,
    DialogueBox,
    Overlay,
    Custom
};
enum class LayoutTransition : std::uint8_t {
    None,
    Fade
};
struct SetLayoutInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    ScenePresentationOwner owner = ScenePresentationOwner::Invocation;
    LayoutAction action;
    std::optional<LayoutId> layout;
    LayoutScaleOverrides scale_overrides;
    LayoutSlot slot;
    LayoutTransition transition;
    std::uint64_t duration_ms;
    PresentationInstructionWait wait;
    bool skippable;
};
struct BackgroundMaterialInstructionTarget {
    auto operator<=>(const BackgroundMaterialInstructionTarget&) const = default;
};
struct ActorMaterialInstructionTarget {
    ActorSlotId slot;
    CharacterPresentationLayerId layer;
    auto operator<=>(const ActorMaterialInstructionTarget&) const = default;
};
struct LayoutMaterialInstructionTarget {
    LayoutSlot slot = LayoutSlot::Overlay;
    auto operator<=>(const LayoutMaterialInstructionTarget&) const = default;
};
struct PostprocessMaterialInstructionTarget {
    PostprocessEffectInstanceId instance;
    auto operator<=>(const PostprocessMaterialInstructionTarget&) const = default;
};
using MaterialOccurrenceInstructionTarget =
    std::variant<BackgroundMaterialInstructionTarget, ActorMaterialInstructionTarget,
                 LayoutMaterialInstructionTarget, PostprocessMaterialInstructionTarget>;
enum class MaterialParameterTransition : std::uint8_t {
    None,
    Tween,
};
enum class MaterialClock : std::uint8_t {
    Gameplay,
    UnscaledPresentation,
};
enum class MaterialEasing : std::uint8_t {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
};
struct MaterialParameterInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    ScenePresentationOwner owner = ScenePresentationOwner::Invocation;
    MaterialOccurrenceInstructionTarget target;
    MaterialId material;
    std::string parameter;
    MaterialParameterValue value;
    MaterialParameterTransition transition = MaterialParameterTransition::None;
    std::uint64_t duration_ms = 0;
    MaterialEasing easing = MaterialEasing::Linear;
    MaterialClock clock = MaterialClock::Gameplay;
    PresentationInstructionWait wait;
    bool skippable = true;
};
enum class PostprocessEffectAction : std::uint8_t {
    Upsert,
    Remove,
};
struct PostprocessEffectParameter {
    std::string name;
    MaterialParameterValue value;
    bool operator==(const PostprocessEffectParameter&) const = default;
};
struct PostprocessEffectInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    ScenePresentationOwner owner = ScenePresentationOwner::Invocation;
    PostprocessEffectAction action = PostprocessEffectAction::Upsert;
    PostprocessEffectInstanceId instance;
    std::optional<MaterialId> material;
    MaterialPostprocessScope scope = MaterialPostprocessScope::World;
    std::int32_t order = 0;
    MaterialClock clock = MaterialClock::Gameplay;
    std::vector<PostprocessEffectParameter> parameters;
};
struct TransitionGroupSetBackgroundMutation {
    TransitionGroupChildId id;
    BackgroundPresentation background;
};
struct TransitionGroupClearBackgroundMutation {
    TransitionGroupChildId id;
};
struct TransitionGroupActorMutation {
    TransitionGroupChildId id;
    ActorCueAction action;
    CharacterId character;
    std::optional<CharacterPresentationProfileId> profile_id;
    std::optional<CharacterExpressionId> expression_id;
    std::optional<CharacterAppearanceId> appearance_id;
    Vector2 offset;
    std::optional<CharacterPoseId> pose_id;
    ActorPosition position;
    double scale;
    ActorSlotId slot_id;
};
struct TransitionGroupLayoutMutation {
    TransitionGroupChildId id;
    LayoutAction action;
    std::optional<LayoutId> layout;
    LayoutScaleOverrides scale_overrides;
    LayoutSlot slot;
};
using TransitionGroupMutation =
    std::variant<TransitionGroupSetBackgroundMutation, TransitionGroupClearBackgroundMutation,
                 TransitionGroupActorMutation, TransitionGroupLayoutMutation>;
struct TransitionGroupInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    ScenePresentationOwner owner = ScenePresentationOwner::Invocation;
    std::optional<std::string> color;
    std::uint64_t duration_ms;
    TransitionKind transition_kind;
    PresentationInstructionWait wait;
    bool skippable;
    std::vector<TransitionGroupMutation> children;
};
using SceneInstruction =
    std::variant<SetBackgroundInstruction, ActorCueInstruction, CallSceneSceneInstruction,
                 StartDetachedSceneInstruction, CallDialogueSceneInstruction,
                 ResumeDialogueSceneInstruction, ShowTextInstruction, AudioCueInstruction,
                 GameplayEffectBatchSceneInstruction, RuntimeWorldTransactionSceneInstruction,
                 DirectedRoomChangeSceneInstruction, NavigationAttemptSceneInstruction,
                 CallInteractionSceneInstruction, RunLuaSceneInstruction, WaitDurationInstruction,
                 WaitInputInstruction, WaitConditionInstruction, WaitOperationInstruction,
                 WaitAudioInstruction, WaitLayoutSignalInstruction, ConditionalBranchInstruction,
                 ChoiceSceneInstruction, SetLayoutInstruction, MaterialParameterInstruction,
                 PostprocessEffectInstruction, TransitionGroupInstruction>;
struct SceneEventTimeline {
    std::string track_id;
    std::uint64_t start_ms = 0;
    std::uint64_t duration_ms = 0;
};
struct SceneEventMetadata {
    SceneStepId id;
    SceneEventTimeline timeline;
    std::vector<SceneStepId> completion_dependencies;
};
struct SceneProgram {
    std::vector<SceneInstruction> instructions;
    std::vector<SceneEventMetadata> events;
};
struct InheritedSceneStage {};
struct StagedRoomSceneStage {
    RoomId room;
};
struct BlankSceneStage {
    BackgroundPresentation background;
    std::optional<LayoutId> layout;
};
using SceneStage = std::variant<InheritedSceneStage, StagedRoomSceneStage, BlankSceneStage>;
enum class SceneInputType : std::uint8_t {
    Boolean,
    Integer,
    Number,
    String,
};
struct SceneInputDefinition {
    SceneInputId id;
    std::string label;
    SceneInputType type = SceneInputType::String;
    bool nullable = false;
    std::optional<RuntimeValue> default_value;
};
struct SceneOutcomeDefinition {
    SceneOutcomeId id;
    std::string label;
};
struct ReturnSceneTerminal {
    std::optional<SceneOutcomeId> outcome;
};
struct ContinueSceneTerminal {
    SceneId scene;
    std::vector<SceneInputBinding> inputs;
};
struct ContinueDialogueSceneTerminal {
    DialogueId dialogue;
};
struct ReleaseToExplorationSceneTerminal {};
struct CompleteGameSceneTerminal {};
using SceneTerminal =
    std::variant<ReturnSceneTerminal, ContinueSceneTerminal, ContinueDialogueSceneTerminal,
                 ReleaseToExplorationSceneTerminal, CompleteGameSceneTerminal>;
struct SceneDefinition {
    DefinitionIdentity<SceneId> identity;
    std::string display_name;
    SceneStage stage;
    std::vector<SceneInputDefinition> inputs;
    std::vector<SceneOutcomeDefinition> outcomes;
    SceneProgram program;
    SceneTerminal terminal;
};

struct DialogueStageSlotState {
    CharacterId character;
    CharacterPresentationProfileId profile_id;
    CharacterPoseId pose_id;
    CharacterExpressionId expression_id;
    std::optional<CharacterAppearanceId> appearance_id;
    ActorPosition position = ActorPosition::Center;
    Vector2 offset{0.0, 0.0};
    double scale = 1.0;
    bool visible = true;

    bool operator==(const DialogueStageSlotState&) const = default;
};
struct DialogueStageSlotDefinition {
    DialogueStageSlotId id;
    bool speaker_sync = true;
    std::optional<DialogueStageSlotState> initial;
};
struct DialogueImageMedia {
    AssetId asset;

    bool operator==(const DialogueImageMedia&) const = default;
};
struct DialogueCharacterMedia {
    CharacterId character;
    CharacterPresentationProfileId profile_id;
    CharacterPoseId pose_id;
    CharacterExpressionId expression_id;
    std::optional<CharacterAppearanceId> appearance_id;

    bool operator==(const DialogueCharacterMedia&) const = default;
};
using DialogueMediaContent = std::variant<DialogueImageMedia, DialogueCharacterMedia>;
struct DialogueMediaSlotDefinition {
    DialogueMediaSlotId id;
    std::optional<DialogueMediaContent> initial;
    bool visible = true;
};
enum class DialogueSlotMutationAction : std::uint8_t {
    Update,
    Show,
    Hide,
    Clear,
};
struct DialogueStageMutation {
    DialogueStageSlotId slot_id;
    DialogueSlotMutationAction action = DialogueSlotMutationAction::Update;
    std::optional<CharacterId> character;
    std::optional<CharacterPresentationProfileId> profile_id;
    std::optional<CharacterPoseId> pose_id;
    std::optional<CharacterExpressionId> expression_id;
    std::optional<std::optional<CharacterAppearanceId>> appearance_id;
    std::optional<ActorPosition> position;
    std::optional<Vector2> offset;
    std::optional<double> scale;
};
struct DialogueMediaMutation {
    DialogueMediaSlotId slot_id;
    DialogueSlotMutationAction action = DialogueSlotMutationAction::Update;
    std::optional<DialogueMediaContent> content;
};
struct DialogueCuePosition {
    std::uint64_t offset = 0;
    std::uint64_t order = 0;
    auto operator<=>(const DialogueCuePosition&) const = default;
};
struct DialogueSpeakerExpressionCue {
    DialogueCueId id;
    DialogueCuePosition position;
    CharacterExpressionId expression_id;
};
struct DialogueStageCue {
    DialogueCueId id;
    DialogueCuePosition position;
    DialogueStageMutation mutation;
};
struct DialogueMediaCue {
    DialogueCueId id;
    DialogueCuePosition position;
    DialogueMediaMutation mutation;
};
struct DialogueGestureCue {
    DialogueCueId id;
    DialogueCuePosition position;
    DialogueStageSlotId slot_id;
    CharacterGestureId gesture_id;
    bool wait_for_completion = false;
    bool skippable = true;
};
struct DialogueVoiceCue {
    DialogueCueId id;
    DialogueCuePosition position;
    AssetId asset;
    AudioPausePolicy pause_policy = AudioPausePolicy::Gameplay;
    double gain = 1.0;
    double pan = 0.0;
    bool wait_for_completion = false;
    AudioSkipBehavior skip_behavior = AudioSkipBehavior::Stop;
};
struct DialogueSoundEffectCue {
    DialogueCueId id;
    DialogueCuePosition position;
    AssetId asset;
    AudioPausePolicy pause_policy = AudioPausePolicy::Gameplay;
    double gain = 1.0;
    double pan = 0.0;
    bool wait_for_completion = false;
    AudioCausality causality = AudioCausality::Disposable;
    bool synchronized = false;
    AudioSkipBehavior skip_behavior = AudioSkipBehavior::Suppress;
};
struct DialogueCameraShakeEmphasis {
    Vector2 amplitude;
    double frequency_hz = 12.0;
    std::uint64_t duration_ms = 0;
    bool skippable = true;
    bool wait_for_completion = false;
};
struct DialogueCameraPunchEmphasis {
    Vector2 translation;
    double zoom_delta = 0.0;
    double rotation_degrees = 0.0;
    std::uint64_t duration_ms = 0;
    bool skippable = true;
    bool wait_for_completion = false;
};
struct DialogueCameraFlashEmphasis {
    std::string color;
    double opacity = 1.0;
    std::uint64_t duration_ms = 0;
    bool skippable = true;
    bool wait_for_completion = false;
};
using DialogueCameraEmphasis =
    std::variant<DialogueCameraShakeEmphasis, DialogueCameraPunchEmphasis,
                 DialogueCameraFlashEmphasis>;
struct DialogueCameraCue {
    DialogueCueId id;
    DialogueCuePosition position;
    DialogueCameraEmphasis emphasis;
};
using DialogueSemanticCue =
    std::variant<DialogueSpeakerExpressionCue, DialogueStageCue, DialogueMediaCue,
                 DialogueGestureCue, DialogueVoiceCue, DialogueSoundEffectCue, DialogueCameraCue>;
struct DialogueLineSegment {
    DialogueSegmentId id;
    bool autosave_safe_point;
    std::optional<Condition> condition;
    std::vector<GameplayCommand> effects;
    bool logged;
    bool show_once;
    std::optional<CharacterId> speaker;
    TextContent text;
    std::vector<DialogueSemanticCue> cues;
};
struct DialogueRunLuaSegment {
    DialogueSegmentId id;
    std::optional<Condition> condition;
    bool may_yield;
    std::string source;
};
enum class DialogueChildSceneUiPolicy : std::uint8_t {
    Preserve,
    Conceal,
};
struct DialogueCallSceneSegment {
    DialogueSegmentId id;
    std::optional<Condition> condition;
    SceneId scene;
    std::vector<SceneInputBinding> inputs;
    DialogueChildSceneUiPolicy ui_policy = DialogueChildSceneUiPolicy::Conceal;
};
struct DialogueHandoffSegment {
    DialogueSegmentId id;
    std::optional<Condition> condition;
    std::optional<RuntimeValue> payload;
};
using DialogueSegment = std::variant<DialogueLineSegment, DialogueRunLuaSegment,
                                     DialogueCallSceneSegment, DialogueHandoffSegment>;
struct DialogueSequenceBlock {
    DialogueBlockId id;
    std::optional<CharacterId> default_speaker;
    std::vector<DialogueSegment> segments;
};
struct DialogueChoiceBlock {
    DialogueBlockId id;
};
struct DialogueRedirectBlock {
    DialogueBlockId id;
    DialogueBlockId target_block_id;
};
using DialogueBlock =
    std::variant<DialogueSequenceBlock, DialogueChoiceBlock, DialogueRedirectBlock>;
struct DialogueNextEdge {
    DialogueEdgeId id;
    DialogueBlockId from_block_id;
    DialogueBlockId to_block_id;
};
struct DialogueChoiceEdge {
    DialogueEdgeId id;
    bool autosave_safe_point;
    std::optional<Condition> condition;
    std::vector<GameplayCommand> effects;
    DialogueBlockId from_block_id;
    TextContent label;
    bool logged;
    DialogueBlockId to_block_id;
};
using DialogueEdge = std::variant<DialogueNextEdge, DialogueChoiceEdge>;
struct DialogueProgram {
    std::vector<DialogueBlock> blocks;
    std::vector<DialogueEdge> edges;
    DialogueBlockId entry_block_id;
};
enum class DialogueLogMode : std::uint8_t {
    Everything,
    Nothing,
    OnlyChoices,
    OnlyLines
};
struct DialogueSettings {
    DialogueLogMode log_mode;
    bool show_disabled_choices;
};
struct DialogueDefinition {
    DefinitionIdentity<DialogueId> identity;
    std::string display_name;
    std::optional<CharacterId> default_speaker;
    std::vector<DialogueStageSlotDefinition> stage_slots;
    std::vector<DialogueMediaSlotDefinition> media_slots;
    DialogueProgram program;
    DialogueSettings settings;
    FlowTarget completion;
};

struct MapPolygon {
    std::vector<Vector2> points;
};
struct MapLocation {
    MapLocationId id;
    RoomId room;
    std::vector<MapPolygon> regions;
    std::optional<TextContent> label;
    std::optional<AssetId> icon;
    std::optional<std::string> style;
    std::optional<Vector2> label_anchor;
    std::optional<Vector2> connection_anchor;
    Condition visibility;
    std::int64_t pick_order = 0;
    std::int64_t logical_order = 0;
};
struct MapConnection {
    MapConnectionId id;
    std::vector<RoomExitRef> exits;
    MapLocationId source_location_id;
    MapLocationId target_location_id;
    std::optional<TextContent> label;
    std::optional<AssetId> icon;
    std::optional<std::string> style;
    Condition visibility;
    std::int64_t logical_order = 0;
    std::vector<Vector2> path;
    std::vector<MapPolygon> hit_regions;
};
enum class InitialMapMode : std::uint8_t {
    Minimap,
    FullMap
};
struct MapPresentation {
    std::optional<AssetId> background;
    InitialMapMode initial_mode;
    std::optional<LayoutId> layout;
    std::optional<TextContent> title;
};
struct MapDefinition {
    DefinitionIdentity<MapId> identity;
    std::vector<MapConnection> connections;
    std::vector<MapLocation> locations;
    MapPresentation presentation;
};

struct FlowPredictionAssetDependency {
    AssetId asset;
    bool operator==(const FlowPredictionAssetDependency&) const = default;
};
struct FlowPredictionAudioDependency {
    AssetId asset;
    AudioPurpose purpose = AudioPurpose::SoundEffect;
    bool operator==(const FlowPredictionAudioDependency&) const = default;
};
struct FlowPredictionCharacterDependency {
    CharacterId character;
    std::optional<CharacterPresentationProfileId> profile_id;
    std::optional<CharacterPoseId> pose_id;
    std::optional<CharacterExpressionId> expression_id;
    std::optional<CharacterAppearanceId> appearance_id;
    bool operator==(const FlowPredictionCharacterDependency&) const = default;
};
struct FlowPredictionLayoutDependency {
    LayoutId layout;
    bool operator==(const FlowPredictionLayoutDependency&) const = default;
};
struct FlowPredictionMaterialDependency {
    MaterialId material;
    bool operator==(const FlowPredictionMaterialDependency&) const = default;
};
struct FlowPredictionRoomDependency {
    RoomId room;
    bool operator==(const FlowPredictionRoomDependency&) const = default;
};
using FlowPredictionDependency =
    std::variant<FlowPredictionAssetDependency, FlowPredictionAudioDependency,
                 FlowPredictionCharacterDependency, FlowPredictionLayoutDependency,
                 FlowPredictionMaterialDependency, FlowPredictionRoomDependency>;

struct SceneEntryPredictionPoint {
    SceneId scene;
    bool operator==(const SceneEntryPredictionPoint&) const = default;
};
struct SceneStepPredictionPoint {
    SceneId scene;
    SceneStepId step;
    bool operator==(const SceneStepPredictionPoint&) const = default;
};
struct SceneTerminalPredictionPoint {
    SceneId scene;
    bool operator==(const SceneTerminalPredictionPoint&) const = default;
};
struct DialogueEntryPredictionPoint {
    DialogueId dialogue;
    bool operator==(const DialogueEntryPredictionPoint&) const = default;
};
enum class DialoguePredictionStage : std::uint8_t {
    EnterBlock,
    PresentSegment,
    ApplySegmentEffects,
    PresentChoices,
    ApplyChoiceEffects,
    FollowEdge,
};
struct DialoguePositionPredictionPoint {
    DialogueId dialogue;
    DialogueBlockId block;
    std::optional<DialogueSegmentId> segment;
    std::optional<DialogueEdgeId> edge;
    DialoguePredictionStage stage = DialoguePredictionStage::EnterBlock;
    std::size_t cursor = 0;
    bool operator==(const DialoguePositionPredictionPoint&) const = default;
};
struct DialogueTerminalPredictionPoint {
    DialogueId dialogue;
    bool operator==(const DialogueTerminalPredictionPoint&) const = default;
};
enum class RoomLifecyclePredictionStage : std::uint8_t {
    BeforeLeave,
    BeforeEnter,
    Presentation,
    AfterLeave,
    AfterEnter,
};
struct RoomLifecyclePredictionPoint {
    RoomId room;
    RoomLifecyclePredictionStage stage = RoomLifecyclePredictionStage::Presentation;
    bool operator==(const RoomLifecyclePredictionPoint&) const = default;
};
using FlowPredictionPoint =
    std::variant<SceneEntryPredictionPoint, SceneStepPredictionPoint, SceneTerminalPredictionPoint,
                 DialogueEntryPredictionPoint, DialoguePositionPredictionPoint,
                 DialogueTerminalPredictionPoint, RoomLifecyclePredictionPoint>;

struct FlowPredictionSetGlobalProperty {
    PropertyId property;
    RuntimeValue value;
};
struct FlowPredictionInvalidateGlobalProperty {
    PropertyId property;
};
struct FlowPredictionCallScene {
    SceneId scene;
};
struct FlowPredictionStartDetachedScene {
    SceneId scene;
};
struct FlowPredictionCallDialogue {
    DialogueId dialogue;
};
struct FlowPredictionEnterRoom {
    RoomId room;
};
struct FlowPredictionOpaque {};
struct FlowPredictionCommand;
struct FlowPredictionIf {
    Condition condition;
    std::vector<FlowPredictionCommand> then_commands;
    std::vector<FlowPredictionCommand> else_commands;
};
struct FlowPredictionCommand {
    using Value = std::variant<FlowPredictionSetGlobalProperty,
                               FlowPredictionInvalidateGlobalProperty, FlowPredictionCallScene,
                               FlowPredictionStartDetachedScene, FlowPredictionCallDialogue,
                               FlowPredictionEnterRoom, FlowPredictionOpaque, FlowPredictionIf>;
    std::optional<InteractionInstructionId> command_id;
    Value value;
};

struct FlowPredictionSequentialControl {
    std::optional<std::size_t> successor;
};
struct FlowPredictionBranchEdge {
    Condition condition;
    std::size_t target = 0;
};
struct FlowPredictionBranchControl {
    std::vector<FlowPredictionBranchEdge> branches;
    std::size_t fallback = 0;
};
struct FlowPredictionChoiceEdge {
    SceneChoiceOptionId option;
    std::optional<Condition> condition;
    std::vector<std::vector<FlowPredictionCommand>> programs;
    std::size_t target = 0;
};
struct FlowPredictionChoiceControl {
    std::vector<FlowPredictionChoiceEdge> options;
};
using FlowPredictionControl =
    std::variant<FlowPredictionSequentialControl, FlowPredictionBranchControl,
                 FlowPredictionChoiceControl>;

enum class FlowPredictionFrontier : std::uint8_t {
    Normal,
    ShortWait,
    StrongWait,
    Decision,
};

struct FlowPredictionSlice {
    FlowPredictionPoint point;
    std::vector<std::size_t> dependency_groups;
    std::optional<Condition> condition;
    std::optional<std::size_t> condition_false_successor;
    FlowPredictionControl control;
    FlowPredictionFrontier frontier = FlowPredictionFrontier::Normal;
    std::vector<FlowPredictionCommand> program;
};

struct FlowPredictionIndex {
    std::vector<std::vector<FlowPredictionDependency>> dependency_groups;
    std::vector<FlowPredictionSlice> slices;
};

struct CompiledProjectInput {
    ProjectIdentity identity;
    RuntimeSettings settings;
    Entrypoint entrypoint;
    std::optional<FlowPredictionIndex> flow_prediction;
    ScriptId bootstrap_module;
    std::string save_contract;
    Localization localization;
    std::vector<PropertyDefinition> properties;
    std::vector<TraitDefinition> traits;
    std::vector<ArchetypeDefinition> archetypes;
    std::vector<InventoryDefinition> inventories;
    std::vector<AssetResource> assets;
    std::vector<LayoutResource> layouts;
    std::vector<MaterialInterfaceResource> material_interfaces;
    std::vector<ScriptResource> scripts;
    std::vector<CharacterDefinition> characters;
    std::vector<RoomDefinition> rooms;
    std::vector<InteractableDefinition> interactables;
    std::vector<InteractableInstanceDeclaration> interactable_instances;
    std::vector<VerbDefinition> verbs;
    std::vector<InteractionDefinition> interactions;
    std::optional<InteractionProgram> undefined_interaction_program;
    std::vector<SceneDefinition> scenes;
    std::vector<DialogueDefinition> dialogues;
    std::vector<MapDefinition> maps;
};

} // namespace noveltea::core::compiled

namespace noveltea::core {

class CompiledProject {
public:
    CompiledProject() = delete;

    [[nodiscard]] static Result<CompiledProject, Diagnostics>
    create(compiled::CompiledProjectInput input);

    [[nodiscard]] const compiled::ProjectIdentity& identity() const noexcept { return m_identity; }
    [[nodiscard]] const compiled::RuntimeSettings& settings() const noexcept { return m_settings; }
    [[nodiscard]] const compiled::Entrypoint& entrypoint() const noexcept { return m_entrypoint; }
    [[nodiscard]] const std::optional<compiled::FlowPredictionIndex>&
    flow_prediction() const noexcept
    {
        return m_flow_prediction;
    }
    [[nodiscard]] const ScriptId& bootstrap_module() const noexcept { return m_bootstrap_module; }
    [[nodiscard]] const std::string& save_contract() const noexcept { return m_save_contract; }
    [[nodiscard]] const compiled::Localization& localization() const noexcept
    {
        return m_localization;
    }

    [[nodiscard]] const std::vector<PropertyDefinition>& properties() const noexcept
    {
        return m_properties;
    }
    [[nodiscard]] const std::vector<compiled::TraitDefinition>& traits() const noexcept
    {
        return m_traits;
    }
    [[nodiscard]] const std::vector<compiled::ArchetypeDefinition>& archetypes() const noexcept
    {
        return m_archetypes;
    }
    [[nodiscard]] const std::vector<compiled::InventoryDefinition>& inventories() const noexcept
    {
        return m_inventories;
    }
    [[nodiscard]] const std::vector<compiled::AssetResource>& assets() const noexcept
    {
        return m_assets;
    }
    [[nodiscard]] const std::vector<compiled::LayoutResource>& layouts() const noexcept
    {
        return m_layouts;
    }
    [[nodiscard]] const std::vector<compiled::MaterialInterfaceResource>&
    material_interfaces() const noexcept
    {
        return m_material_interfaces;
    }
    [[nodiscard]] const std::vector<compiled::ScriptResource>& scripts() const noexcept
    {
        return m_scripts;
    }
    [[nodiscard]] const std::vector<compiled::CharacterDefinition>& characters() const noexcept
    {
        return m_characters;
    }
    [[nodiscard]] const std::vector<compiled::RoomDefinition>& rooms() const noexcept
    {
        return m_rooms;
    }
    [[nodiscard]] const std::vector<compiled::InteractableDefinition>&
    interactables() const noexcept
    {
        return m_interactables;
    }
    [[nodiscard]] const std::vector<compiled::InteractableInstanceDeclaration>&
    interactable_instances() const noexcept
    {
        return m_interactable_instances;
    }
    [[nodiscard]] const std::vector<compiled::VerbDefinition>& verbs() const noexcept
    {
        return m_verbs;
    }
    [[nodiscard]] const std::vector<compiled::InteractionDefinition>& interactions() const noexcept
    {
        return m_interactions;
    }
    [[nodiscard]] const std::optional<compiled::InteractionProgram>&
    undefined_interaction_program() const noexcept
    {
        return m_undefined_interaction_program;
    }
    [[nodiscard]] const std::vector<compiled::SceneDefinition>& scenes() const noexcept
    {
        return m_scenes;
    }
    [[nodiscard]] const std::vector<compiled::DialogueDefinition>& dialogues() const noexcept
    {
        return m_dialogues;
    }
    [[nodiscard]] const std::vector<compiled::MapDefinition>& maps() const noexcept
    {
        return m_maps;
    }

    [[nodiscard]] const PropertyDefinition* find_property(const PropertyId& id) const noexcept;
    [[nodiscard]] const PropertyDefinition* find_property(const PropertyOwnerRef& owner,
                                                          const PropertyId& id) const noexcept;
    [[nodiscard]] const compiled::TraitDefinition* find_trait(const TraitId& id) const noexcept;
    [[nodiscard]] const compiled::ArchetypeDefinition*
    find_archetype(const ArchetypeId& id) const noexcept;
    [[nodiscard]] const compiled::InventoryDefinition*
    find_inventory(const compiled::InventoryRef& reference) const noexcept;
    [[nodiscard]] const compiled::AssetResource* find_asset(const AssetId& id) const noexcept;
    [[nodiscard]] const compiled::LayoutResource* find_layout(const LayoutId& id) const noexcept;
    [[nodiscard]] const compiled::MaterialInterfaceResource*
    find_material_interface(const MaterialId& id) const noexcept;
    [[nodiscard]] const compiled::ScriptResource* find_script(const ScriptId& id) const noexcept;
    [[nodiscard]] const compiled::CharacterDefinition*
    find_character(const CharacterId& id) const noexcept;
    [[nodiscard]] const compiled::RoomDefinition* find_room(const RoomId& id) const noexcept;
    [[nodiscard]] const compiled::InteractableDefinition*
    find_interactable_definition(const InteractableDefinitionId& id) const noexcept;
    [[nodiscard]] const compiled::InteractableInstanceDeclaration*
    find_interactable_instance(const InteractableInstanceId& id) const noexcept;
    [[nodiscard]] const compiled::FeatureDefinition*
    find_feature(const RoomFeatureRef& reference) const noexcept;
    [[nodiscard]] const compiled::FeatureDefinition*
    find_feature(const InteractableFeatureRef& reference) const noexcept;
    [[nodiscard]] const compiled::FeatureDefinition*
    find_feature(const FeatureRef& reference) const noexcept;
    [[nodiscard]] const compiled::VerbDefinition* find_verb(const VerbId& id) const noexcept;
    [[nodiscard]] const compiled::InteractionDefinition*
    find_interaction(const InteractionId& id) const noexcept;
    [[nodiscard]] const compiled::SceneDefinition* find_scene(const SceneId& id) const noexcept;
    [[nodiscard]] const compiled::DialogueDefinition*
    find_dialogue(const DialogueId& id) const noexcept;
    [[nodiscard]] const compiled::MapDefinition* find_map(const MapId& id) const noexcept;

private:
    explicit CompiledProject(compiled::CompiledProjectInput input);

    compiled::ProjectIdentity m_identity;
    compiled::RuntimeSettings m_settings;
    compiled::Entrypoint m_entrypoint;
    std::optional<compiled::FlowPredictionIndex> m_flow_prediction;
    ScriptId m_bootstrap_module;
    std::string m_save_contract;
    compiled::Localization m_localization;
    std::vector<PropertyDefinition> m_properties;
    std::vector<compiled::TraitDefinition> m_traits;
    std::vector<compiled::ArchetypeDefinition> m_archetypes;
    std::vector<compiled::InventoryDefinition> m_inventories;
    std::vector<compiled::AssetResource> m_assets;
    std::vector<compiled::LayoutResource> m_layouts;
    std::vector<compiled::MaterialInterfaceResource> m_material_interfaces;
    std::vector<compiled::ScriptResource> m_scripts;
    std::vector<compiled::CharacterDefinition> m_characters;
    std::vector<compiled::RoomDefinition> m_rooms;
    std::vector<compiled::InteractableDefinition> m_interactables;
    std::vector<compiled::InteractableInstanceDeclaration> m_interactable_instances;
    std::vector<compiled::VerbDefinition> m_verbs;
    std::vector<compiled::InteractionDefinition> m_interactions;
    std::optional<compiled::InteractionProgram> m_undefined_interaction_program;
    std::vector<compiled::SceneDefinition> m_scenes;
    std::vector<compiled::DialogueDefinition> m_dialogues;
    std::vector<compiled::MapDefinition> m_maps;

#define NOVELTEA_COMPILED_INDEX(type, name) std::unordered_map<type, std::size_t> m_##name##_index
    NOVELTEA_COMPILED_INDEX(PropertyId, property);
    NOVELTEA_COMPILED_INDEX(TraitId, trait);
    NOVELTEA_COMPILED_INDEX(ArchetypeId, archetype);
    NOVELTEA_COMPILED_INDEX(AssetId, asset);
    NOVELTEA_COMPILED_INDEX(LayoutId, layout);
    NOVELTEA_COMPILED_INDEX(MaterialId, material_interface);
    NOVELTEA_COMPILED_INDEX(ScriptId, script);
    NOVELTEA_COMPILED_INDEX(CharacterId, character);
    NOVELTEA_COMPILED_INDEX(RoomId, room);
    NOVELTEA_COMPILED_INDEX(InteractableDefinitionId, interactable_definition);
    NOVELTEA_COMPILED_INDEX(InteractableInstanceId, interactable_instance);
    NOVELTEA_COMPILED_INDEX(VerbId, verb);
    NOVELTEA_COMPILED_INDEX(InteractionId, interaction);
    NOVELTEA_COMPILED_INDEX(SceneId, scene);
    NOVELTEA_COMPILED_INDEX(DialogueId, dialogue);
    NOVELTEA_COMPILED_INDEX(MapId, map);
#undef NOVELTEA_COMPILED_INDEX
};

} // namespace noveltea::core
