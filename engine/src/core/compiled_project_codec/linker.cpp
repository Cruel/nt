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
              const std::unordered_map<TraitId, const compiled::TraitDefinition*>& traits,
              Diagnostics& diagnostics, std::string_view source_path, const std::string& path)
{
    const auto diagnostics_before = diagnostics.size();
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

    std::vector<TraitId> attachments;
    attachments.reserve(identity.traits.size());
    std::unordered_map<PropertyId, RuntimeValue> configured_values;
    for (std::size_t index = 0; index < identity.traits.size(); ++index) {
        auto& trait_id = identity.traits[index];
        const auto found = traits.find(trait_id);
        if (found == traits.end()) {
            diagnostics.push_back(
                Diagnostic{.code = "compiled_project.unresolved_reference",
                           .message = "Unresolved Trait reference '" + trait_id.text() + "'.",
                           .severity = ErrorSeverity::Error,
                           .source_path = std::string(source_path),
                           .json_pointer = path + "/traits/" + std::to_string(index)});
            continue;
        }
        const auto& trait = *found->second;
        if (std::find(trait.allowed_owners.begin(), trait.allowed_owners.end(), owner) ==
            trait.allowed_owners.end()) {
            diagnostics.push_back(Diagnostic{
                .code = "compiled_project.invalid_trait_attachment",
                .message = "Trait '" + trait_id.text() + "' cannot be attached to this owner kind.",
                .severity = ErrorSeverity::Error,
                .source_path = std::string(source_path),
                .json_pointer = path + "/traits/" + std::to_string(index)});
            continue;
        }
        for (const auto& member : trait.properties) {
            if (!member.configured_value)
                continue;
            const auto [configured, inserted] =
                configured_values.emplace(member.property_id, *member.configured_value);
            if (!inserted && configured->second != *member.configured_value) {
                diagnostics.push_back(
                    Diagnostic{.code = "compiled_project.conflicting_trait_configuration",
                               .message = "Attached Traits configure Property '" +
                                          member.property_id.text() + "' with conflicting values.",
                               .severity = ErrorSeverity::Error,
                               .source_path = std::string(source_path),
                               .json_pointer = path + "/traits/" + std::to_string(index)});
            }
        }
        attachments.push_back(trait_id);
    }
    if (attachments.size() != identity.traits.size())
        return std::nullopt;

    for (const auto& trait_id : attachments) {
        const auto found = traits.find(trait_id);
        if (found == traits.end())
            return std::nullopt;
        const auto* trait = found->second;
        for (const auto& member : trait->properties) {
            if (member.configured_value)
                continue;
            const auto own =
                std::find_if(assignments.begin(), assignments.end(), [&](const auto& value) {
                    return value.property_id() == member.property_id;
                });
            const auto property = properties.find(member.property_id);
            const bool has_default =
                property != properties.end() && property->second->default_value().has_value();
            if (own == assignments.end() &&
                configured_values.find(member.property_id) == configured_values.end() &&
                !has_default) {
                diagnostics.push_back(Diagnostic{
                    .code = "compiled_project.missing_trait_requirement",
                    .message = "Trait '" + trait_id.text() + "' requires Property '" +
                               member.property_id.text() + "' to have an authored value.",
                    .severity = ErrorSeverity::Error,
                    .source_path = std::string(source_path),
                    .json_pointer = path + "/traits"});
            }
        }
    }
    if (diagnostics.size() != diagnostics_before)
        return std::nullopt;
    return compiled::PropertyBearingDefinition<Id>{std::move(identity.id), std::move(attachments),
                                                   std::move(assignments)};
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
            .scope = declaration.scope,
            .allowed_owners = std::move(declaration.allowed_owners),
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

    std::vector<compiled::TraitDefinition> traits;
    traits.reserve(wire.traits.size());
    for (std::size_t index = 0; index < wire.traits.size(); ++index) {
        auto& declaration = wire.traits[index];
        const auto diagnostic_count = diagnostics.size();
        std::vector<compiled::TraitProperty> members;
        members.reserve(declaration.properties.size());
        for (std::size_t member_index = 0; member_index < declaration.properties.size();
             ++member_index) {
            auto& member = declaration.properties[member_index];
            const auto found = property_index.find(member.property_id);
            const auto member_path =
                "/traits/" + std::to_string(index) + "/properties/" + std::to_string(member_index);
            if (found == property_index.end()) {
                diagnostics.push_back(Diagnostic{.code = "compiled_project.unresolved_reference",
                                                 .message = "Unresolved property reference '" +
                                                            member.property_id.text() + "'.",
                                                 .severity = ErrorSeverity::Error,
                                                 .source_path = source_path,
                                                 .json_pointer = member_path + "/propertyId"});
                continue;
            }
            const auto& property = *found->second;
            const bool owners_compatible =
                std::all_of(declaration.allowed_owners.begin(), declaration.allowed_owners.end(),
                            [&](PropertyOwnerKind owner) {
                                return std::binary_search(property.allowed_owners().begin(),
                                                          property.allowed_owners().end(), owner);
                            });
            if (!owners_compatible) {
                diagnostics.push_back(
                    Diagnostic{.code = "compiled_project.invalid_trait_property",
                               .message = "Trait Property '" + member.property_id.text() +
                                          "' is not valid for every Trait owner kind.",
                               .severity = ErrorSeverity::Error,
                               .source_path = source_path,
                               .json_pointer = member_path + "/propertyId"});
                continue;
            }
            if (member.configured_value &&
                !property_value_matches(property, *member.configured_value)) {
                diagnostics.push_back(
                    Diagnostic{.code = "compiled_project.invalid_trait_property",
                               .message = "Configured Trait value does not match Property '" +
                                          member.property_id.text() + "'.",
                               .severity = ErrorSeverity::Error,
                               .source_path = source_path,
                               .json_pointer = member_path + "/value"});
                continue;
            }
            members.push_back(compiled::TraitProperty{std::move(member.property_id),
                                                      std::move(member.configured_value)});
        }
        if (diagnostics.size() != diagnostic_count)
            continue;
        std::sort(declaration.allowed_owners.begin(), declaration.allowed_owners.end());
        traits.push_back(
            compiled::TraitDefinition{std::move(declaration.id), std::move(declaration.label),
                                      std::move(declaration.description),
                                      std::move(declaration.allowed_owners), std::move(members)});
    }
    if (traits.size() != wire.traits.size())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

    std::unordered_map<TraitId, const compiled::TraitDefinition*> trait_index;
    trait_index.reserve(traits.size());
    for (const auto& trait : traits)
        trait_index.emplace(trait.id, &trait);

    auto link_features = [&](std::vector<compiled::wire::FeatureDefinition> values,
                             const std::string& path) {
        std::vector<compiled::FeatureDefinition> linked;
        linked.reserve(values.size());
        for (std::size_t index = 0; index < values.size(); ++index) {
            auto& value = values[index];
            auto identity = link_identity(std::move(value.identity), PropertyOwnerKind::Feature,
                                          property_index, trait_index, diagnostics, source_path,
                                          path + "/" + std::to_string(index));
            if (!identity)
                continue;
            linked.push_back(
                compiled::FeatureDefinition{std::move(*identity), std::move(value.label)});
        }
        return linked;
    };

#define LINK_PROPERTY_DEFINITIONS(wire_member, output_member, output_type, owner_kind, path_text,  \
                                  body)                                                            \
    std::vector<compiled::output_type> output_member;                                              \
    output_member.reserve(wire.wire_member.size());                                                \
    for (std::size_t index = 0; index < wire.wire_member.size(); ++index) {                        \
        auto& value = wire.wire_member[index];                                                     \
        auto identity = link_identity(std::move(value.identity), owner_kind, property_index,       \
                                      trait_index, diagnostics, source_path,                       \
                                      std::string(path_text) + "/" + std::to_string(index));       \
        if (!identity)                                                                             \
            continue;                                                                              \
        output_member.push_back(body);                                                             \
    }

#define LINK_DEFINITIONS(wire_member, output_member, output_type, id_type, body)                   \
    std::vector<compiled::output_type> output_member;                                              \
    output_member.reserve(wire.wire_member.size());                                                \
    for (auto& value : wire.wire_member) {                                                         \
        compiled::DefinitionIdentity<id_type> identity{std::move(value.identity.id)};              \
        output_member.push_back(body);                                                             \
    }

    LINK_PROPERTY_DEFINITIONS(
        characters, characters, CharacterDefinition, PropertyOwnerKind::Character,
        "/definitions/characters",
        (compiled::CharacterDefinition{
            std::move(*identity), std::move(value.display_name), std::move(value.dialogue),
            std::move(value.defaults), std::move(value.poses), std::move(value.expressions),
            std::move(value.idles), std::move(value.initial_world_state)}));
    LINK_PROPERTY_DEFINITIONS(
        rooms, rooms, RoomDefinition, PropertyOwnerKind::Room, "/definitions/rooms",
        (compiled::RoomDefinition{
            std::move(*identity), std::move(value.display_name), std::move(value.description),
            std::move(value.background),
            compiled::RoomLifecycle{std::move(value.lifecycle.can_enter),
                                    std::move(value.lifecycle.can_leave),
                                    std::move(value.lifecycle.hooks)},
            std::move(value.overlays), std::move(value.cast), std::move(value.props),
            std::move(value.environments), std::move(value.compose), std::move(value.placements),
            std::move(value.exits),
            link_features(std::move(value.features),
                          "/definitions/rooms/" + std::to_string(index) + "/features"),
            std::move(value.hotspots)}));
    LINK_PROPERTY_DEFINITIONS(
        interactables, interactables, InteractableDefinition, PropertyOwnerKind::Interactable,
        "/definitions/interactables",
        (compiled::InteractableDefinition{
            std::move(*identity), std::move(value.display_name),
            link_features(std::move(value.features),
                          "/definitions/interactables/" + std::to_string(index) + "/features"),
            std::move(value.initial_state), std::move(value.presentation)}));
    LINK_DEFINITIONS(
        verbs, verbs, VerbDefinition, VerbId,
        (compiled::VerbDefinition{std::move(identity), std::move(value.action_text), value.arity,
                                  std::move(value.availability), std::move(value.default_program),
                                  std::move(value.operand_roles), value.quick_action}));
    LINK_DEFINITIONS(
        interactions, interactions, InteractionDefinition, InteractionId,
        (compiled::InteractionDefinition{std::move(identity), std::move(value.rules)}));
    LINK_DEFINITIONS(scenes, scenes, SceneDefinition, SceneId,
                     (compiled::SceneDefinition{
                         std::move(identity), std::move(value.display_name),
                         std::move(value.default_background), std::move(value.default_layout),
                         std::move(value.program), std::move(value.continuation)}));
    LINK_DEFINITIONS(
        dialogues, dialogues, DialogueDefinition, DialogueId,
        (compiled::DialogueDefinition{std::move(identity), std::move(value.display_name),
                                      std::move(value.default_speaker), std::move(value.program),
                                      std::move(value.settings), std::move(value.completion)}));
    LINK_DEFINITIONS(
        maps, maps, MapDefinition, MapId,
        (compiled::MapDefinition{std::move(identity), std::move(value.connections),
                                 std::move(value.locations), std::move(value.presentation)}));
#undef LINK_DEFINITIONS
#undef LINK_PROPERTY_DEFINITIONS

    if (!diagnostics.empty())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

    auto result = CompiledProject::create(compiled::CompiledProjectInput{
        .identity = std::move(wire.identity),
        .settings = std::move(wire.settings),
        .entrypoint = std::move(wire.entrypoint),
        .startup_hook = std::move(wire.startup_hook),
        .localization = std::move(wire.localization),
        .properties = std::move(properties),
        .traits = std::move(traits),
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
