#include "../compiled_project_wire.hpp"

#include "noveltea/core/compiled_project_codec.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <unordered_map>
#include <utility>

namespace noveltea::core {
namespace {

void append(Diagnostics& destination, const Diagnostics& source, std::string_view source_path,
            std::string json_pointer = {})
{
    for (const auto& diagnostic : source) {
        auto linked = diagnostic;
        if (linked.source_path.empty())
            linked.source_path = source_path;
        if (linked.json_pointer.empty())
            linked.json_pointer = json_pointer;
        destination.push_back(std::move(linked));
    }
}

template<class Id>
std::optional<compiled::PropertyBearingDefinition<Id>>
link_identity(compiled::wire::PropertyBearingDefinition<Id> identity, PropertyOwnerKind owner,
              const std::unordered_map<PropertyId, const PropertyDefinition*>& properties,
              Diagnostics& diagnostics, std::string_view source_path, const std::string& path)
{
    std::vector<PropertyAssignment> assignments;
    assignments.reserve(identity.property_assignments.size());
    for (std::size_t index = 0; index < identity.property_assignments.size(); ++index) {
        auto& assignment = identity.property_assignments[index];
        const auto found = properties.find(assignment.property_id);
        if (found == properties.end()) {
            diagnostics.push_back(Diagnostic{
                .code = "compiled_project.unresolved_reference",
                .message = "Unresolved property reference '" + assignment.property_id.text() + "'.",
                .severity = ErrorSeverity::Error,
                .source_path = std::string(source_path),
                .json_pointer =
                    path + "/propertyAssignments/" + std::to_string(index) + "/propertyId"});
            continue;
        }
        auto linked = make_property_assignment(owner, *found->second, std::move(assignment.value));
        if (!linked) {
            append(diagnostics, linked.error(), source_path,
                   path + "/propertyAssignments/" + std::to_string(index));
            continue;
        }
        (void)linked.transform([&assignments](const PropertyAssignment& assignment) {
            assignments.push_back(assignment);
            return true;
        });
    }
    if (assignments.size() != identity.property_assignments.size())
        return std::nullopt;
    return compiled::PropertyBearingDefinition<Id>{
        std::move(identity.id), std::move(identity.extends), std::move(assignments)};
}

Result<CompiledProject, Diagnostics> link(compiled::wire::SharedProject wire,
                                          std::string source_path)
{
    Diagnostics diagnostics;
    std::vector<PropertyDefinition> properties;
    properties.reserve(wire.properties.size());
    for (std::size_t index = 0; index < wire.properties.size(); ++index) {
        auto& declaration = wire.properties[index];
        auto linked = make_property_definition(PropertyDefinitionInput{
            .id = std::move(declaration.id),
            .value_type = std::move(declaration.value_type),
            .nullable = declaration.nullable,
            .default_value = std::move(declaration.default_value),
            .allowed_owners = std::move(declaration.allowed_owners),
            .persistence = declaration.persistence,
            .label = std::move(declaration.label),
            .description = std::move(declaration.description),
        });
        if (!linked) {
            append(diagnostics, linked.error(), source_path,
                   "/properties/" + std::to_string(index));
            continue;
        }
        (void)linked.transform([&properties](const PropertyDefinition& property) {
            properties.push_back(property);
            return true;
        });
    }
    if (properties.size() != wire.properties.size())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

    std::unordered_map<PropertyId, const PropertyDefinition*> property_index;
    property_index.reserve(properties.size());
    for (const auto& property : properties)
        property_index.emplace(property.id(), &property);

    std::vector<compiled::VariableDefinition> variables;
    variables.reserve(wire.variables.size());
    for (std::size_t index = 0; index < wire.variables.size(); ++index) {
        auto& declaration = wire.variables[index];
        if (const auto* enumeration = std::get_if<EnumPropertyType>(&declaration.value_type)) {
            auto values = enumeration->values;
            std::sort(values.begin(), values.end());
            if (values.empty() ||
                std::any_of(values.begin(), values.end(),
                            [](const std::string& value) { return value.empty(); }) ||
                std::adjacent_find(values.begin(), values.end()) != values.end()) {
                diagnostics.push_back(Diagnostic{
                    .code = "compiled_project.invalid_variable_declaration",
                    .message = "Variable enum values must be non-empty and unique.",
                    .severity = ErrorSeverity::Error,
                    .source_path = source_path,
                    .json_pointer = "/variables/" + std::to_string(index) + "/enumValues"});
                continue;
            }
        }
        variables.push_back(compiled::VariableDefinition{std::move(declaration.id),
                                                         std::move(declaration.value_type),
                                                         std::move(declaration.default_value)});
    }
    if (variables.size() != wire.variables.size())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

#define LINK_DEFINITIONS(wire_member, output_member, output_type, owner_kind, path_text, body)     \
    std::vector<compiled::output_type> output_member;                                              \
    output_member.reserve(wire.wire_member.size());                                                \
    for (std::size_t index = 0; index < wire.wire_member.size(); ++index) {                        \
        auto& value = wire.wire_member[index];                                                     \
        auto identity =                                                                            \
            link_identity(std::move(value.identity), owner_kind, property_index, diagnostics,      \
                          source_path, std::string(path_text) + "/" + std::to_string(index));      \
        if (!identity)                                                                             \
            continue;                                                                              \
        output_member.push_back(body);                                                             \
    }

    LINK_DEFINITIONS(
        characters, characters, CharacterDefinition, PropertyOwnerKind::Character,
        "/definitions/characters",
        (compiled::CharacterDefinition{std::move(*identity), std::move(value.display_name),
                                       std::move(value.dialogue), std::move(value.defaults),
                                       std::move(value.poses), std::move(value.expressions)}));
    LINK_DEFINITIONS(
        rooms, rooms, RoomDefinition, PropertyOwnerKind::Room, "/definitions/rooms",
        (compiled::RoomDefinition{std::move(*identity), std::move(value.display_name),
                                  std::move(value.description), std::move(value.background),
                                  compiled::RoomLifecycle{std::move(value.lifecycle.can_enter),
                                                          std::move(value.lifecycle.can_leave),
                                                          std::move(value.lifecycle.hooks)},
                                  std::move(value.overlays), std::move(value.placements),
                                  std::move(value.exits)}));
    LINK_DEFINITIONS(interactables, interactables, InteractableDefinition,
                     PropertyOwnerKind::Interactable, "/definitions/interactables",
                     (compiled::InteractableDefinition{
                         std::move(*identity), std::move(value.display_name),
                         std::move(value.initial_state), std::move(value.presentation)}));
    LINK_DEFINITIONS(
        verbs, verbs, VerbDefinition, PropertyOwnerKind::Verb, "/definitions/verbs",
        (compiled::VerbDefinition{std::move(*identity), std::move(value.action_text), value.arity,
                                  std::move(value.availability), std::move(value.default_program),
                                  std::move(value.operand_roles), value.quick_action}));
    LINK_DEFINITIONS(
        interactions, interactions, InteractionDefinition, PropertyOwnerKind::Interaction,
        "/definitions/interactions",
        (compiled::InteractionDefinition{std::move(*identity), std::move(value.rules)}));
    LINK_DEFINITIONS(
        scenes, scenes, SceneDefinition, PropertyOwnerKind::Scene, "/definitions/scenes",
        (compiled::SceneDefinition{std::move(*identity), std::move(value.display_name),
                                   std::move(value.default_background),
                                   std::move(value.default_layout), std::move(value.program),
                                   std::move(value.continuation)}));
    LINK_DEFINITIONS(
        dialogues, dialogues, DialogueDefinition, PropertyOwnerKind::Dialogue,
        "/definitions/dialogues",
        (compiled::DialogueDefinition{std::move(*identity), std::move(value.display_name),
                                      std::move(value.default_speaker), std::move(value.program),
                                      std::move(value.settings), std::move(value.completion)}));
    LINK_DEFINITIONS(
        maps, maps, MapDefinition, PropertyOwnerKind::Map, "/definitions/maps",
        (compiled::MapDefinition{std::move(*identity), std::move(value.connections),
                                 std::move(value.locations), std::move(value.presentation)}));
#undef LINK_DEFINITIONS

    if (!diagnostics.empty())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

    auto result = CompiledProject::create(compiled::CompiledProjectInput{
        .identity = std::move(wire.identity),
        .settings = std::move(wire.settings),
        .entrypoint = std::move(wire.entrypoint),
        .startup_hook = std::move(wire.startup_hook),
        .localization = std::move(wire.localization),
        .variables = std::move(variables),
        .properties = std::move(properties),
        .assets = std::move(wire.assets),
        .layouts = std::move(wire.layouts),
        .scripts = std::move(wire.scripts),
        .characters = std::move(characters),
        .rooms = std::move(rooms),
        .interactables = std::move(interactables),
        .verbs = std::move(verbs),
        .interactions = std::move(interactions),
        .scenes = std::move(scenes),
        .dialogues = std::move(dialogues),
        .maps = std::move(maps),
    });
    if (result)
        return result;
    append(diagnostics, result.error(), source_path);
    return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));
}

} // namespace

Result<CompiledProject, Diagnostics> decode_compiled_project(const nlohmann::json& document,
                                                             std::string source_path)
{
    auto decoded = compiled::wire::decode_shared_project(document, source_path);
    if (!decoded)
        return Result<CompiledProject, Diagnostics>::failure(decoded.error());
    std::optional<compiled::wire::SharedProject> wire;
    (void)decoded.transform([&wire](const compiled::wire::SharedProject& project) {
        wire = project;
        return true;
    });
    return link(std::move(*wire), std::move(source_path));
}

} // namespace noveltea::core
