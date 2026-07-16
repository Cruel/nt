#pragma once

#include "noveltea/core/execution_primitives.hpp"
#include "noveltea/core/property.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/text_content.hpp"
#include "noveltea/core/wait.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

namespace noveltea::core::compiled {

template<class Id> struct PropertyBearingDefinition {
    Id id;
    std::optional<Id> extends;
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
};

struct ProjectIdentity {
    ProjectId id;
    std::string name;
    std::string version;
    std::string author;
    std::string description;
};
using Entrypoint = std::variant<RoomId, SceneId, DialogueId>;
struct StartupHook {
    std::string source;
};

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

struct VariableDefinition {
    VariableId id;
    PropertyValueType value_type;
    RuntimeValue default_value;
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
struct AssetResource {
    AssetId id;
    AssetKind kind;
    std::string path;
    std::vector<std::string> aliases;
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

struct AspectRatio {
    std::uint32_t width;
    std::uint32_t height;
};
enum class DisplayOrientation : std::uint8_t {
    Landscape,
    Portrait
};
struct DisplaySettings {
    AspectRatio aspect_ratio;
    std::string bar_color;
    DisplayOrientation orientation;
};
enum class SystemLayoutRole : std::uint8_t {
    Title,
    GameHud,
    PauseMenu,
    LoadMenu,
    SettingsMenu,
    Modal,
    DebugOverlay
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
    std::vector<SystemLayout> system_layouts;
    TextSettings text;
    TitleScreenSettings title_screen;
    RoomNavigationTransition room_navigation_transition{
        TransitionKind::Cut, 0, std::nullopt, true};
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
};
struct RoomPlacementRef {
    RoomId room;
    RoomPlacementId placement_id;
};

struct CharacterPose {
    CharacterPoseId id;
    Vector2 anchor;
    std::optional<MaterialId> material;
    Vector2 offset;
    double scale;
    std::optional<AssetId> sprite;
};
struct CharacterExpression {
    CharacterExpressionId id;
    std::optional<MaterialId> material;
    std::optional<CharacterPoseId> pose_id;
    std::optional<AssetId> sprite;
};
struct CharacterDialoguePresentation {
    std::string name;
    std::optional<std::string> name_color;
    std::string style_class;
    std::optional<std::string> text_color;
};
struct CharacterDefaults {
    CharacterExpressionId expression_id;
    CharacterPoseId pose_id;
};
struct NowhereCharacterLocation {};
using CharacterInitialWorldLocation = std::variant<NowhereCharacterLocation, RoomPlacementRef>;
struct CharacterInitialWorldState {
    CharacterInitialWorldLocation location;
    bool enabled;
    bool visible;
};
struct CharacterDefinition {
    PropertyBearingDefinition<CharacterId> identity;
    std::string display_name;
    CharacterDialoguePresentation dialogue;
    CharacterDefaults defaults;
    std::vector<CharacterPose> poses;
    std::vector<CharacterExpression> expressions;
    CharacterInitialWorldState initial_world_state;
};

struct RoomExitRef {
    RoomId room;
    RoomExitId exit_id;
};
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
};
enum class RoomHookKind : std::uint8_t {
    BeforeEnter,
    AfterEnter,
    BeforeLeave,
    AfterLeave
};
struct RoomHookProgram {
    RoomHookKind hook;
    std::vector<Effect> effects;
};
struct RoomLifecycle {
    Condition can_enter;
    Condition can_leave;
    std::vector<RoomHookProgram> hooks;
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
    std::optional<CharacterPoseId> pose_id;
    std::optional<CharacterExpressionId> expression_id;
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
struct RoomCompositionHook {
    ScriptId script;
};
struct RoomDefinition {
    PropertyBearingDefinition<RoomId> identity;
    std::string display_name;
    TextContent description;
    BackgroundPresentation background;
    RoomLifecycle lifecycle;
    std::vector<RoomOverlay> overlays;
    std::vector<RoomCastEntry> cast;
    std::vector<RoomProp> props;
    std::optional<RoomCompositionHook> compose;
    std::vector<RoomPlacement> placements;
    std::vector<RoomExit> exits;
};

struct InventoryLocation {};
struct NowhereLocation {};
using InteractableLocation = std::variant<InventoryLocation, NowhereLocation, RoomPlacementRef>;
struct InteractableInitialState {
    bool enabled;
    InteractableLocation location;
    bool visible;
};
struct InteractablePresentation {
    std::optional<MaterialId> material;
    std::optional<AssetId> sprite;
};
struct InteractableDefinition {
    PropertyBearingDefinition<InteractableId> identity;
    std::string display_name;
    InteractableInitialState initial_state;
    InteractablePresentation presentation;
};

struct ApplyEffectInstruction {
    InteractionInstructionId id;
    Effect effect;
};
struct MoveInteractableInstruction {
    InteractionInstructionId id;
    InteractableId interactable;
    InteractableLocation target;
};
struct SetInteractableStateInstruction {
    InteractionInstructionId id;
    InteractableId interactable;
    std::optional<bool> enabled;
    std::optional<bool> visible;
};
struct NotifyInstruction {
    InteractionInstructionId id;
    TextContent message;
};
struct CallSceneInteractionInstruction {
    InteractionInstructionId id;
    SceneId scene;
};
struct CallDialogueInteractionInstruction {
    InteractionInstructionId id;
    DialogueId dialogue;
};
using InteractionInstruction =
    std::variant<ApplyEffectInstruction, MoveInteractableInstruction,
                 SetInteractableStateInstruction, NotifyInstruction,
                 CallSceneInteractionInstruction, CallDialogueInteractionInstruction>;
enum class InteractionOutcome : std::uint8_t {
    Handled,
    Unhandled
};
struct InteractionProgram {
    std::vector<InteractionInstruction> instructions;
    FlowTarget completion;
    InteractionOutcome outcome;
};
struct AnyInteractionContext {};
struct ActiveRoomInteractionContext {
    RoomId room;
};
struct PlacementInteractionContext {
    RoomPlacementRef placement;
};
struct PredicateInteractionContext {
    Condition condition;
};
using InteractionContext = std::variant<AnyInteractionContext, ActiveRoomInteractionContext,
                                        PlacementInteractionContext, PredicateInteractionContext>;
struct CharacterInteractionSubject {
    CharacterId character;
    bool operator==(const CharacterInteractionSubject&) const = default;
};
struct InteractableInteractionSubject {
    InteractableId interactable;
    bool operator==(const InteractableInteractionSubject&) const = default;
};
using InteractionSubject =
    std::variant<CharacterInteractionSubject, InteractableInteractionSubject>;
struct ExactOperand {
    InteractionSubject subject;
};
struct AnyCharacterOperand {};
struct AnyInteractableOperand {};
struct AnyInteractionSubjectOperand {};
using InteractionOperand = std::variant<ExactOperand, AnyCharacterOperand, AnyInteractableOperand,
                                        AnyInteractionSubjectOperand>;
struct InteractionRule {
    InteractionRuleId id;
    VerbId verb;
    InteractionContext context;
    std::vector<InteractionOperand> operands;
    InteractionProgram program;
};
struct InteractionDefinition {
    PropertyBearingDefinition<InteractionId> identity;
    std::vector<InteractionRule> rules;
};
struct VerbDefinition {
    PropertyBearingDefinition<VerbId> identity;
    TextContent action_text;
    std::uint8_t arity;
    Condition availability;
    InteractionProgram default_program;
    std::vector<std::string> operand_roles;
    bool quick_action;
};

enum class BackgroundTransition : std::uint8_t {
    None,
    Fade,
    Cut
};
struct SetBackgroundInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    BackgroundPresentation background;
    BackgroundTransition transition;
};
enum class ActorCueAction : std::uint8_t {
    Show,
    Hide,
    Move,
    Pose,
    Expression
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
    ActorCueAction action;
    CharacterId character;
    std::optional<CharacterExpressionId> expression_id;
    Vector2 offset;
    std::optional<CharacterPoseId> pose_id;
    ActorPosition position;
    double scale;
    ActorSlotId slot_id;
    ActorTransition transition;
};
struct CallDialogueSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    bool autosave_safe_point;
    DialogueId dialogue;
    std::optional<DialogueBlockId> start_block_id;
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
enum class AudioChannel : std::uint8_t {
    SoundEffect,
    Music,
    Voice,
    Ambient
};
struct AudioCueInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    AudioAction action;
    std::optional<AssetId> asset;
    AudioChannel channel;
    std::uint64_t fade_ms;
    bool loop;
    double volume;
    AudioInstructionWait wait;
};
struct SetVariableSceneInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    VariableId variable;
    RuntimeValue value;
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
    std::vector<Effect> effects;
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
struct SetLayoutInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    LayoutAction action;
    std::optional<LayoutId> layout;
    LayoutSlot slot;
};
struct TransitionInstruction {
    SceneStepId id;
    std::optional<Condition> condition;
    std::optional<std::string> color;
    std::uint64_t duration_ms;
    TransitionKind transition_kind;
    PresentationInstructionWait wait;
};
using SceneInstruction =
    std::variant<SetBackgroundInstruction, ActorCueInstruction, CallDialogueSceneInstruction,
                 ShowTextInstruction, AudioCueInstruction, SetVariableSceneInstruction,
                 RunLuaSceneInstruction, WaitDurationInstruction, WaitInputInstruction,
                 ConditionalBranchInstruction, ChoiceSceneInstruction, SetLayoutInstruction,
                 TransitionInstruction>;
struct SceneProgram {
    std::vector<SceneInstruction> instructions;
};
struct SceneDefinition {
    PropertyBearingDefinition<SceneId> identity;
    std::string display_name;
    BackgroundPresentation default_background;
    std::optional<LayoutId> default_layout;
    SceneProgram program;
    FlowTarget continuation;
};

struct DialogueLineSegment {
    DialogueSegmentId id;
    bool autosave_safe_point;
    std::optional<Condition> condition;
    std::vector<Effect> effects;
    bool logged;
    bool show_once;
    std::optional<CharacterId> speaker;
    TextContent text;
};
struct DialogueRunLuaSegment {
    DialogueSegmentId id;
    std::optional<Condition> condition;
    bool may_yield;
    std::string source;
};
using DialogueSegment = std::variant<DialogueLineSegment, DialogueRunLuaSegment>;
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
    std::vector<Effect> effects;
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
    PropertyBearingDefinition<DialogueId> identity;
    std::string display_name;
    std::optional<CharacterId> default_speaker;
    DialogueProgram program;
    DialogueSettings settings;
    FlowTarget completion;
};

struct PointMapShape {};
struct CircleMapShape {
    double radius;
};
struct RectMapShape {
    double width;
    double height;
};
using MapShape = std::variant<PointMapShape, CircleMapShape, RectMapShape>;
struct MapLocation {
    MapLocationId id;
    std::optional<TextContent> label;
    Vector2 position;
    RoomId room;
    MapShape shape;
};
struct MapConnection {
    MapConnectionId id;
    RoomExitRef exit;
    MapLocationId source_location_id;
    MapLocationId target_location_id;
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
    PropertyBearingDefinition<MapId> identity;
    std::vector<MapConnection> connections;
    std::vector<MapLocation> locations;
    MapPresentation presentation;
};

struct CompiledProjectInput {
    ProjectIdentity identity;
    RuntimeSettings settings;
    Entrypoint entrypoint;
    std::optional<StartupHook> startup_hook;
    Localization localization;
    std::vector<VariableDefinition> variables;
    std::vector<PropertyDefinition> properties;
    std::vector<AssetResource> assets;
    std::vector<LayoutResource> layouts;
    std::vector<ScriptResource> scripts;
    std::vector<CharacterDefinition> characters;
    std::vector<RoomDefinition> rooms;
    std::vector<InteractableDefinition> interactables;
    std::vector<VerbDefinition> verbs;
    std::vector<InteractionDefinition> interactions;
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
    [[nodiscard]] const std::optional<compiled::StartupHook>& startup_hook() const noexcept
    {
        return m_startup_hook;
    }
    [[nodiscard]] const compiled::Localization& localization() const noexcept
    {
        return m_localization;
    }

    [[nodiscard]] const std::vector<compiled::VariableDefinition>& variables() const noexcept
    {
        return m_variables;
    }
    [[nodiscard]] const std::vector<PropertyDefinition>& properties() const noexcept
    {
        return m_properties;
    }
    [[nodiscard]] const std::vector<compiled::AssetResource>& assets() const noexcept
    {
        return m_assets;
    }
    [[nodiscard]] const std::vector<compiled::LayoutResource>& layouts() const noexcept
    {
        return m_layouts;
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
    [[nodiscard]] const std::vector<compiled::VerbDefinition>& verbs() const noexcept
    {
        return m_verbs;
    }
    [[nodiscard]] const std::vector<compiled::InteractionDefinition>& interactions() const noexcept
    {
        return m_interactions;
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

    [[nodiscard]] const compiled::VariableDefinition*
    find_variable(const VariableId& id) const noexcept;
    [[nodiscard]] const PropertyDefinition* find_property(const PropertyId& id) const noexcept;
    [[nodiscard]] const compiled::AssetResource* find_asset(const AssetId& id) const noexcept;
    [[nodiscard]] const compiled::LayoutResource* find_layout(const LayoutId& id) const noexcept;
    [[nodiscard]] const compiled::ScriptResource* find_script(const ScriptId& id) const noexcept;
    [[nodiscard]] const compiled::CharacterDefinition*
    find_character(const CharacterId& id) const noexcept;
    [[nodiscard]] const compiled::RoomDefinition* find_room(const RoomId& id) const noexcept;
    [[nodiscard]] const compiled::InteractableDefinition*
    find_interactable(const InteractableId& id) const noexcept;
    [[nodiscard]] const compiled::VerbDefinition* find_verb(const VerbId& id) const noexcept;
    [[nodiscard]] const compiled::InteractionDefinition*
    find_interaction(const InteractionId& id) const noexcept;
    [[nodiscard]] const compiled::SceneDefinition* find_scene(const SceneId& id) const noexcept;
    [[nodiscard]] const compiled::DialogueDefinition*
    find_dialogue(const DialogueId& id) const noexcept;
    [[nodiscard]] const compiled::MapDefinition* find_map(const MapId& id) const noexcept;

    [[nodiscard]] std::optional<std::size_t>
    character_parent_index(const CharacterId& id) const noexcept;
    [[nodiscard]] std::optional<std::size_t> room_parent_index(const RoomId& id) const noexcept;
    [[nodiscard]] std::optional<std::size_t>
    interactable_parent_index(const InteractableId& id) const noexcept;
    [[nodiscard]] std::optional<std::size_t> verb_parent_index(const VerbId& id) const noexcept;
    [[nodiscard]] std::optional<std::size_t>
    interaction_parent_index(const InteractionId& id) const noexcept;
    [[nodiscard]] std::optional<std::size_t> scene_parent_index(const SceneId& id) const noexcept;
    [[nodiscard]] std::optional<std::size_t>
    dialogue_parent_index(const DialogueId& id) const noexcept;
    [[nodiscard]] std::optional<std::size_t> map_parent_index(const MapId& id) const noexcept;

private:
    explicit CompiledProject(compiled::CompiledProjectInput input);

    compiled::ProjectIdentity m_identity;
    compiled::RuntimeSettings m_settings;
    compiled::Entrypoint m_entrypoint;
    std::optional<compiled::StartupHook> m_startup_hook;
    compiled::Localization m_localization;
    std::vector<compiled::VariableDefinition> m_variables;
    std::vector<PropertyDefinition> m_properties;
    std::vector<compiled::AssetResource> m_assets;
    std::vector<compiled::LayoutResource> m_layouts;
    std::vector<compiled::ScriptResource> m_scripts;
    std::vector<compiled::CharacterDefinition> m_characters;
    std::vector<compiled::RoomDefinition> m_rooms;
    std::vector<compiled::InteractableDefinition> m_interactables;
    std::vector<compiled::VerbDefinition> m_verbs;
    std::vector<compiled::InteractionDefinition> m_interactions;
    std::vector<compiled::SceneDefinition> m_scenes;
    std::vector<compiled::DialogueDefinition> m_dialogues;
    std::vector<compiled::MapDefinition> m_maps;

#define NOVELTEA_COMPILED_INDEX(type, name) std::unordered_map<type, std::size_t> m_##name##_index
    NOVELTEA_COMPILED_INDEX(VariableId, variable);
    NOVELTEA_COMPILED_INDEX(PropertyId, property);
    NOVELTEA_COMPILED_INDEX(AssetId, asset);
    NOVELTEA_COMPILED_INDEX(LayoutId, layout);
    NOVELTEA_COMPILED_INDEX(ScriptId, script);
    NOVELTEA_COMPILED_INDEX(CharacterId, character);
    NOVELTEA_COMPILED_INDEX(RoomId, room);
    NOVELTEA_COMPILED_INDEX(InteractableId, interactable);
    NOVELTEA_COMPILED_INDEX(VerbId, verb);
    NOVELTEA_COMPILED_INDEX(InteractionId, interaction);
    NOVELTEA_COMPILED_INDEX(SceneId, scene);
    NOVELTEA_COMPILED_INDEX(DialogueId, dialogue);
    NOVELTEA_COMPILED_INDEX(MapId, map);
#undef NOVELTEA_COMPILED_INDEX

#define NOVELTEA_COMPILED_PARENT_INDEX(type, name)                                                 \
    std::unordered_map<type, std::size_t> m_##name##_parent_index
    NOVELTEA_COMPILED_PARENT_INDEX(CharacterId, character);
    NOVELTEA_COMPILED_PARENT_INDEX(RoomId, room);
    NOVELTEA_COMPILED_PARENT_INDEX(InteractableId, interactable);
    NOVELTEA_COMPILED_PARENT_INDEX(VerbId, verb);
    NOVELTEA_COMPILED_PARENT_INDEX(InteractionId, interaction);
    NOVELTEA_COMPILED_PARENT_INDEX(SceneId, scene);
    NOVELTEA_COMPILED_PARENT_INDEX(DialogueId, dialogue);
    NOVELTEA_COMPILED_PARENT_INDEX(MapId, map);
#undef NOVELTEA_COMPILED_PARENT_INDEX
};

} // namespace noveltea::core
