#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <nlohmann/json_fwd.hpp>

#include <optional>
#include <string>
#include <vector>

namespace noveltea::core::compiled::wire {

// Structural boundary DTOs. They are intentionally not direct CompiledProject inputs: structural
// decoding completes here, while semantic linking, validation, indexing, and atomic publication are
// separate responsibilities.
struct PropertyAssignment {
    PropertyId property_id;
    RuntimeValue value;
};

struct TraitProperty {
    PropertyId property_id;
    std::optional<RuntimeValue> configured_value;
};
struct TraitDeclaration {
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

struct PropertyDeclaration {
    PropertyId id;
    PropertyValueType value_type;
    bool nullable;
    std::optional<RuntimeValue> default_value;
    PropertyScope scope;
    std::vector<std::string> enum_values;
    std::vector<PropertyOwnerKind> allowed_owners;
    std::string label;
    std::string description;
};

struct CharacterDefinition {
    PropertyBearingDefinition<CharacterId> identity;
    std::string display_name;
    CharacterDialoguePresentation dialogue;
    CharacterDefaults defaults;
    std::vector<CharacterPose> poses;
    std::vector<CharacterExpression> expressions;
    std::vector<CharacterIdle> idles;
    std::vector<InventoryDefinition> inventories;
    CharacterInitialWorldState initial_world_state;
};

struct FeatureDefinition {
    PropertyBearingDefinition<FeatureId> identity;
    std::string label;
    std::vector<InventoryDefinition> inventories;
};

struct RoomLifecycle {
    Condition can_enter;
    Condition can_leave;
};
struct RoomDefinition {
    PropertyBearingDefinition<RoomId> identity;
    std::string display_name;
    TextContent description;
    BackgroundPresentation background;
    RoomLifecycle lifecycle;
    std::vector<RoomOverlay> overlays;
    std::vector<RoomCastEntry> cast;
    std::vector<RoomInteractableEntry> interactables;
    std::vector<RoomProp> props;
    std::vector<RoomEnvironment> environments;
    std::vector<RoomScriptHookMapping> script_hooks;
    std::vector<RoomPlacement> placements;
    std::vector<RoomExit> exits;
    std::vector<FeatureDefinition> features;
    std::vector<RoomHotspot> hotspots;
};

struct InteractableDefinition {
    PropertyBearingDefinition<InteractableId> identity;
    std::string display_name;
    std::vector<FeatureDefinition> features;
    std::vector<InventoryDefinition> inventories;
    InteractableInitialState initial_state;
    InteractablePresentation presentation;
};

struct ItemDefinition {
    PropertyBearingDefinition<ItemDefinitionId> identity;
    std::string display_name;
    std::string description;
    ItemDefinitionPresentation presentation;
    std::optional<std::uint64_t> stack_limit;
};

using ArchetypeConfiguration =
    std::variant<RoomDefinition, CharacterDefinition, InteractableDefinition>;
struct ArchetypeDefinition {
    ArchetypeId id;
    GameplayInstanceKind kind;
    ArchetypeConfiguration configuration;
};

struct VerbDefinition {
    DefinitionIdentity<VerbId> identity;
    TextContent action_text;
    TextContent completed_command_text;
    std::vector<VerbSlot> slots;
    std::vector<VerbSlotId> binding_order;
    Condition availability;
    InteractionProgram default_program;
    bool quick_action;
};
struct InteractionDefinition {
    DefinitionIdentity<InteractionId> identity;
    std::vector<InteractionRule> rules;
};
struct SceneDefinition {
    DefinitionIdentity<SceneId> identity;
    std::string display_name;
    BackgroundPresentation default_background;
    std::optional<LayoutId> default_layout;
    SceneProgram program;
    FlowTarget continuation;
};
struct DialogueDefinition {
    DefinitionIdentity<DialogueId> identity;
    std::string display_name;
    std::optional<CharacterId> default_speaker;
    DialogueProgram program;
    DialogueSettings settings;
    FlowTarget completion;
};
struct MapDefinition {
    DefinitionIdentity<MapId> identity;
    std::vector<MapConnection> connections;
    std::vector<MapLocation> locations;
    MapPresentation presentation;
};

struct SharedProject {
    ProjectIdentity identity;
    RuntimeSettings settings;
    Entrypoint entrypoint;
    ScriptId bootstrap_module;
    std::string save_contract;
    Localization localization;
    std::vector<PropertyDeclaration> properties;
    std::vector<TraitDeclaration> traits;
    std::vector<ArchetypeDefinition> archetypes;
    std::vector<InventoryDefinition> inventories;
    std::vector<AssetResource> assets;
    std::vector<LayoutResource> layouts;
    std::vector<ScriptResource> scripts;
    std::vector<CharacterDefinition> characters;
    std::vector<RoomDefinition> rooms;
    std::vector<InteractableDefinition> interactables;
    std::vector<ItemDefinition> item_definitions;
    std::vector<ItemStackDeclaration> item_stacks;
    std::vector<VerbDefinition> verbs;
    std::vector<InteractionDefinition> interactions;
    std::vector<SceneDefinition> scenes;
    std::vector<DialogueDefinition> dialogues;
    std::vector<MapDefinition> maps;
};

[[nodiscard]] Result<SharedProject, Diagnostics>
decode_shared_project(const nlohmann::json& document, std::string source_path = {});

// Shared closed primitives are exposed only from this codec namespace so 5C can reuse exactly these
// decoders instead of introducing program-local substitutes.
[[nodiscard]] Result<Condition, Diagnostics> decode_condition(const nlohmann::json& value,
                                                              std::string source_path = {},
                                                              std::string json_pointer = {});
[[nodiscard]] Result<Effect, Diagnostics> decode_effect(const nlohmann::json& value,
                                                        std::string source_path = {},
                                                        std::string json_pointer = {});
[[nodiscard]] Result<FlowTarget, Diagnostics> decode_flow_target(const nlohmann::json& value,
                                                                 std::string source_path = {},
                                                                 std::string json_pointer = {});

} // namespace noveltea::core::compiled::wire
