#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <nlohmann/json_fwd.hpp>

#include <optional>
#include <string>
#include <vector>

namespace noveltea::core::compiled::wire {

// Phase 5B boundary DTOs. They are intentionally not CompiledProject inputs: program payloads are
// decoded in Phase 5C and semantic linking/publication belongs to Phase 5D.
struct PropertyAssignment {
    PropertyId property_id;
    RuntimeValue value;
};

template<class Id> struct PropertyBearingDefinition {
    Id id;
    std::optional<Id> extends;
    std::vector<PropertyAssignment> property_assignments;
};

struct VariableDeclaration {
    VariableId id;
    PropertyValueType value_type;
    RuntimeValue default_value;
    std::vector<std::string> enum_values;
};

struct PropertyDeclaration {
    PropertyId id;
    PropertyValueType value_type;
    bool nullable;
    std::optional<RuntimeValue> default_value;
    std::vector<std::string> enum_values;
    std::vector<PropertyOwnerKind> allowed_owners;
    PropertyPersistence persistence;
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
    std::vector<RoomPlacement> placements;
    std::vector<RoomExit> exits;
};

struct InteractableDefinition {
    PropertyBearingDefinition<InteractableId> identity;
    std::string display_name;
    InteractableInitialState initial_state;
    InteractablePresentation presentation;
};

struct VerbDefinition {
    PropertyBearingDefinition<VerbId> identity;
    TextContent action_text;
    std::uint8_t arity;
    std::vector<std::string> operand_roles;
    bool quick_action;
};
struct InteractionDefinition {
    PropertyBearingDefinition<InteractionId> identity;
};
struct SceneDefinition {
    PropertyBearingDefinition<SceneId> identity;
    std::string display_name;
    BackgroundPresentation default_background;
    std::optional<LayoutId> default_layout;
};
struct DialogueDefinition {
    PropertyBearingDefinition<DialogueId> identity;
    std::string display_name;
    std::optional<CharacterId> default_speaker;
    DialogueSettings settings;
};
struct MapDefinition {
    PropertyBearingDefinition<MapId> identity;
    std::vector<MapConnection> connections;
    std::vector<MapLocation> locations;
    MapPresentation presentation;
};

struct SharedProject {
    ProjectIdentity identity;
    RuntimeSettings settings;
    Entrypoint entrypoint;
    std::optional<StartupHook> startup_hook;
    Localization localization;
    std::vector<VariableDeclaration> variables;
    std::vector<PropertyDeclaration> properties;
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
