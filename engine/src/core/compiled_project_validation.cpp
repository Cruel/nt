#include "compiled_project_validation.hpp"

#include <algorithm>
#include <functional>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>

namespace noveltea::core::compiled::detail {
namespace {

class Validator {
public:
    explicit Validator(const CompiledProjectInput& input) : m_input(input)
    {
#define INDEX(member, id_expression)                                                               \
    for (std::size_t index = 0; index < input.member.size(); ++index)                              \
    m_##member.emplace(id_expression, index)
        INDEX(properties, input.properties[index].id());
        INDEX(traits, input.traits[index].id);
        INDEX(assets, input.assets[index].id);
        INDEX(layouts, input.layouts[index].id);
        INDEX(material_interfaces, input.material_interfaces[index].id);
        INDEX(scripts, input.scripts[index].id);
        INDEX(characters, input.characters[index].identity.id);
        INDEX(rooms, input.rooms[index].identity.id);
        INDEX(interactables, input.interactables[index].identity.id);
        INDEX(item_definitions, input.item_definitions[index].identity.id);
        INDEX(item_stacks, input.item_stacks[index].id);
        INDEX(verbs, input.verbs[index].identity.id);
        INDEX(interactions, input.interactions[index].identity.id);
        INDEX(scenes, input.scenes[index].identity.id);
        INDEX(dialogues, input.dialogues[index].identity.id);
        INDEX(maps, input.maps[index].identity.id);
#undef INDEX
    }

    Diagnostics run()
    {
        validate_localization();
        validate_traits();
        validate_root_and_resources();
        validate_definitions();
        return std::move(m_diagnostics);
    }

private:
    template<class Id>
    void require(const std::unordered_map<Id, std::size_t>& index, const Id& id,
                 std::string_view kind, std::string path)
    {
        if (!index.contains(id))
            error("compiled_project.unresolved_reference",
                  "Unresolved " + std::string(kind) + " reference '" + id.text() + "'.",
                  std::move(path));
    }

    void error(std::string code, std::string message, std::string path)
    {
        m_diagnostics.push_back(Diagnostic{.code = std::move(code),
                                           .message = std::move(message),
                                           .severity = ErrorSeverity::Error,
                                           .json_pointer = std::move(path)});
    }

    static std::string item(std::string_view collection, std::size_t index)
    {
        return std::string(collection) + "/" + std::to_string(index);
    }

    const PropertyDefinition* property(const PropertyId& id) const
    {
        const auto found = m_properties.find(id);
        return found == m_properties.end() ? nullptr : &m_input.properties[found->second];
    }

    const TraitDefinition* trait(const TraitId& id) const
    {
        const auto found = m_traits.find(id);
        return found == m_traits.end() ? nullptr : &m_input.traits[found->second];
    }

    const MaterialInterfaceResource* material_interface(const MaterialId& id) const
    {
        const auto found = m_material_interfaces.find(id);
        return found == m_material_interfaces.end() ? nullptr
                                                    : &m_input.material_interfaces[found->second];
    }

    static bool material_value_matches(MaterialParameterType type,
                                       const MaterialParameterValue& value) noexcept
    {
        switch (type) {
        case MaterialParameterType::Float:
            return std::holds_alternative<double>(value);
        case MaterialParameterType::Vec2:
            return std::holds_alternative<std::array<double, 2>>(value);
        case MaterialParameterType::Vec3:
            return std::holds_alternative<std::array<double, 3>>(value);
        case MaterialParameterType::Vec4:
            return std::holds_alternative<std::array<double, 4>>(value);
        case MaterialParameterType::Color:
            return std::holds_alternative<MaterialColorValue>(value);
        case MaterialParameterType::Int:
            return std::holds_alternative<std::int64_t>(value);
        case MaterialParameterType::Bool:
            return std::holds_alternative<bool>(value);
        }
        return false;
    }

    const CharacterDefinition* character(const CharacterId& id) const
    {
        const auto found = m_characters.find(id);
        return found == m_characters.end() ? nullptr : &m_input.characters[found->second];
    }

    const RoomDefinition* room(const RoomId& id) const
    {
        const auto found = m_rooms.find(id);
        return found == m_rooms.end() ? nullptr : &m_input.rooms[found->second];
    }

    const InteractableDefinition* interactable(const InteractableId& id) const
    {
        const auto found = m_interactables.find(id);
        return found == m_interactables.end() ? nullptr : &m_input.interactables[found->second];
    }

    const FeatureDefinition* feature(const RoomFeatureRef& reference) const
    {
        const auto* owner = room(reference.room);
        if (!owner)
            return nullptr;
        const auto found = std::ranges::find_if(owner->features, [&](const auto& value) {
            return value.identity.id == reference.feature_id;
        });
        return found == owner->features.end() ? nullptr : &*found;
    }

    const FeatureDefinition* feature(const InteractableFeatureRef& reference) const
    {
        const auto* owner = interactable(reference.interactable);
        if (!owner)
            return nullptr;
        const auto found = std::ranges::find_if(owner->features, [&](const auto& value) {
            return value.identity.id == reference.feature_id;
        });
        return found == owner->features.end() ? nullptr : &*found;
    }

    const std::vector<InventoryDefinition>* inventories(const InventoryOwnerRef& owner) const
    {
        return std::visit(
            [&](const auto& reference) -> const std::vector<InventoryDefinition>* {
                using T = std::decay_t<decltype(reference)>;
                if constexpr (std::is_same_v<T, ProjectInventoryOwner>)
                    return &m_input.inventories;
                else if constexpr (std::is_same_v<T, CharacterInventoryOwner>) {
                    const auto* definition = character(reference.character);
                    return definition ? &definition->inventories : nullptr;
                } else if constexpr (std::is_same_v<T, InteractableInventoryOwner>) {
                    const auto* definition = interactable(reference.interactable);
                    return definition ? &definition->inventories : nullptr;
                } else {
                    const auto* definition = feature(reference);
                    return definition ? &definition->inventories : nullptr;
                }
            },
            owner);
    }

    const InventoryDefinition* inventory(const InventoryRef& reference) const
    {
        const auto* owned = inventories(reference.owner);
        if (!owned)
            return nullptr;
        const auto found = std::ranges::find_if(*owned, [&](const InventoryDefinition& value) {
            return value.id == reference.inventory_id;
        });
        return found == owned->end() ? nullptr : &*found;
    }

    void validate_inventories(const std::vector<InventoryDefinition>& values,
                              const std::string& path)
    {
        std::unordered_set<InventoryId> ids;
        for (std::size_t index = 0; index < values.size(); ++index)
            if (!ids.insert(values[index].id).second)
                error("compiled_project.duplicate_nested_id", "Duplicate Inventory ID.",
                      path + "/" + std::to_string(index) + "/id");
    }

    void validate_inventory_ref(const InventoryRef& reference, const std::string& path)
    {
        std::visit(
            [&](const auto& owner) {
                using T = std::decay_t<decltype(owner)>;
                if constexpr (std::is_same_v<T, CharacterInventoryOwner>)
                    require(m_characters, owner.character, "character", path + "/owner/character");
                else if constexpr (std::is_same_v<T, InteractableInventoryOwner>)
                    require(m_interactables, owner.interactable, "interactable",
                            path + "/owner/interactable");
                else if constexpr (std::is_same_v<T, RoomFeatureRef>) {
                    require(m_rooms, owner.room, "room", path + "/owner/room");
                    if (!feature(owner))
                        error("compiled_project.unresolved_nested_reference",
                              "Inventory owner Feature does not exist in its Room.",
                              path + "/owner/featureId");
                } else if constexpr (std::is_same_v<T, InteractableFeatureRef>) {
                    require(m_interactables, owner.interactable, "interactable",
                            path + "/owner/interactable");
                    if (!feature(owner))
                        error("compiled_project.unresolved_nested_reference",
                              "Inventory owner Feature does not exist in its Interactable.",
                              path + "/owner/featureId");
                }
            },
            reference.owner);
        if (!inventory(reference))
            error("compiled_project.unresolved_nested_reference",
                  "Inventory reference does not identify an Inventory on its owner.",
                  path + "/inventoryId");
    }

    std::optional<InteractableId> inventory_interactable_owner(const InventoryRef& reference) const
    {
        return std::visit(
            [](const auto& owner) -> std::optional<InteractableId> {
                using T = std::decay_t<decltype(owner)>;
                if constexpr (std::is_same_v<T, InteractableInventoryOwner>)
                    return owner.interactable;
                else if constexpr (std::is_same_v<T, InteractableFeatureRef>)
                    return owner.interactable;
                else
                    return std::nullopt;
            },
            reference.owner);
    }

    const VerbDefinition* verb(const VerbId& id) const
    {
        const auto found = m_verbs.find(id);
        return found == m_verbs.end() ? nullptr : &m_input.verbs[found->second];
    }

    const DialogueDefinition* dialogue(const DialogueId& id) const
    {
        const auto found = m_dialogues.find(id);
        return found == m_dialogues.end() ? nullptr : &m_input.dialogues[found->second];
    }

    const AssetResource* asset(const AssetId& id) const
    {
        const auto found = m_assets.find(id);
        return found == m_assets.end() ? nullptr : &m_input.assets[found->second];
    }

    void validate_text(const TextContent& text, const std::string& path)
    {
        const auto* localized = std::get_if<LocalizedTextKey>(&text.source);
        if (localized && !m_default_localization_keys.contains(localized->value))
            error("compiled_project.unresolved_localization",
                  "Localized text key '" + localized->value +
                      "' is absent from the default locale catalog.",
                  path + "/source/key");
    }

    void validate_condition(const Condition& condition, const std::string& path)
    {
        const auto* comparison = std::get_if<GlobalPropertyComparison>(&condition);
        if (!comparison)
            return;
        std::visit(
            [&](const auto& typed) {
                const auto* declaration = property(typed.property_id);
                if (!declaration) {
                    require(m_properties, typed.property_id, "property", path + "/property");
                    return;
                }
                if (!declaration->is_global()) {
                    error("compiled_project.property_scope_mismatch",
                          "Condition requires Global Property '" + typed.property_id.text() + "'.",
                          path + "/property");
                    return;
                }
                using T = std::decay_t<decltype(typed)>;
                if constexpr (std::is_same_v<T, GlobalPropertyValueComparison>) {
                    if (!property_value_matches(*declaration, typed.value))
                        error("compiled_project.property_type_mismatch",
                              "Comparison value does not match Global Property '" +
                                  typed.property_id.text() + "'.",
                              path + "/value");
                    const bool ordered = typed.operation != ValueComparisonOperator::Equal &&
                                         typed.operation != ValueComparisonOperator::NotEqual;
                    const bool orderable =
                        std::holds_alternative<IntegerPropertyType>(declaration->value_type()) ||
                        std::holds_alternative<NumberPropertyType>(declaration->value_type()) ||
                        std::holds_alternative<StringPropertyType>(declaration->value_type());
                    if (ordered &&
                        (!orderable || std::holds_alternative<std::monostate>(typed.value)))
                        error("compiled_project.invalid_property_operator",
                              "Ordered comparison is incompatible with Global Property '" +
                                  typed.property_id.text() + "'.",
                              path + "/operator");
                }
            },
            *comparison);
    }

    void validate_effect(const Effect& effect, const std::string& path)
    {
        const auto* assignment = std::get_if<SetGlobalProperty>(&effect);
        if (!assignment)
            return;
        const auto* declaration = property(assignment->property_id);
        if (!declaration) {
            require(m_properties, assignment->property_id, "property", path + "/property");
            return;
        }
        if (!declaration->is_global()) {
            error("compiled_project.property_scope_mismatch",
                  "Effect requires Global Property '" + assignment->property_id.text() + "'.",
                  path + "/property");
            return;
        }
        if (!property_value_matches(*declaration, assignment->value))
            error("compiled_project.property_type_mismatch",
                  "Assigned value does not match Global Property '" +
                      assignment->property_id.text() + "'.",
                  path + "/value");
    }

    void validate_flow_target(const FlowTarget& target, const std::string& path)
    {
        std::visit(
            [&](const auto& typed) {
                using T = std::decay_t<decltype(typed)>;
                if constexpr (std::is_same_v<T, SceneId>)
                    require(m_scenes, typed, "scene", path);
                else if constexpr (std::is_same_v<T, DialogueId>)
                    require(m_dialogues, typed, "dialogue", path);
                else if constexpr (std::is_same_v<T, RoomId>)
                    require(m_rooms, typed, "room", path);
            },
            target);
    }

    void validate_background(const BackgroundPresentation& background, const std::string& path)
    {
        if (background.asset)
            require(m_assets, *background.asset, "asset", path + "/asset");
    }

    const RoomPlacement* placement(const RoomPlacementRef& reference) const
    {
        const auto* owner = room(reference.room);
        if (!owner)
            return nullptr;
        const auto found = std::find_if(
            owner->placements.begin(), owner->placements.end(),
            [&](const RoomPlacement& value) { return value.id == reference.placement_id; });
        return found == owner->placements.end() ? nullptr : &*found;
    }

    const RoomExit* exit(const RoomExitRef& reference) const
    {
        const auto* owner = room(reference.room);
        if (!owner)
            return nullptr;
        const auto found =
            std::find_if(owner->exits.begin(), owner->exits.end(),
                         [&](const RoomExit& value) { return value.id == reference.exit_id; });
        return found == owner->exits.end() ? nullptr : &*found;
    }

    const RoomHotspot* room_hotspot(const RoomHotspotRef& reference) const
    {
        const auto* owner = room(reference.room);
        if (!owner)
            return nullptr;
        const auto found = std::ranges::find_if(owner->hotspots, [&](const RoomHotspot& value) {
            return value.id == reference.hotspot_id;
        });
        return found == owner->hotspots.end() ? nullptr : &*found;
    }

    const InteractableHotspotBehavior*
    interactable_hotspot(const InteractableHotspotRef& reference) const
    {
        const auto* owner = interactable(reference.interactable);
        if (!owner)
            return nullptr;
        return std::visit(
            [&](const auto& definition) -> const InteractableHotspotBehavior* {
                using T = std::decay_t<decltype(definition)>;
                if constexpr (std::is_same_v<T, SpriteAlphaHotspots>)
                    return definition.hotspot.id == reference.hotspot_id ? &definition.hotspot
                                                                         : nullptr;
                else {
                    const auto found = std::ranges::find_if(
                        definition.hotspots, [&](const InteractableCustomHotspot& value) {
                            return value.id == reference.hotspot_id;
                        });
                    return found == definition.hotspots.end() ? nullptr : &*found;
                }
            },
            owner->presentation.hotspots);
    }

    void validate_interaction_subject(const InteractionSubject& subject, const std::string& path)
    {
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, CharacterInteractionSubject>)
                    require(m_characters, value.character, "character", path + "/character");
                else if constexpr (std::is_same_v<T, InteractableInteractionSubject>)
                    require(m_interactables, value.interactable, "interactable",
                            path + "/interactable");
                else if constexpr (std::is_same_v<T, ItemStackInteractionSubject>)
                    require(m_item_stacks, value.item_stack, "item stack", path + "/itemStack");
                else
                    std::visit(
                        [&](const auto& reference) {
                            using R = std::decay_t<decltype(reference)>;
                            if constexpr (std::is_same_v<R, RoomFeatureRef>) {
                                require(m_rooms, reference.room, "room", path + "/room");
                                if (!feature(reference))
                                    error("compiled_project.unresolved_nested_reference",
                                          "Feature reference does not identify a Feature in its "
                                          "owning Room.",
                                          path + "/featureId");
                            } else {
                                require(m_interactables, reference.interactable, "interactable",
                                        path + "/interactable");
                                if (!feature(reference))
                                    error("compiled_project.unresolved_nested_reference",
                                          "Feature reference does not identify a Feature in its "
                                          "owning Interactable.",
                                          path + "/featureId");
                            }
                        },
                        value.feature);
            },
            subject);
    }

    void validate_subject_selector(const SubjectSelector& selector, const std::string& path)
    {
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, TraitSubjectSelector>)
                    require(m_traits, value.trait, "Trait", path + "/trait");
                else if constexpr (std::is_same_v<T, ItemDefinitionSubjectSelector>)
                    require(m_item_definitions, value.item_definition, "item definition",
                            path + "/itemDefinition");
                else if constexpr (std::is_same_v<T, ExactSubjectSelector>)
                    validate_interaction_subject(value.subject, path + "/subject");
            },
            selector);
    }

    template<class Definition>
    void validate_features(const Definition& owner, const std::string& path)
    {
        std::unordered_set<FeatureId> ids;
        for (std::size_t index = 0; index < owner.features.size(); ++index) {
            const auto& feature = owner.features[index];
            const auto feature_path = path + "/features/" + std::to_string(index);
            if (!ids.insert(feature.identity.id).second)
                error("compiled_project.duplicate_nested_id", "Duplicate Feature ID.",
                      feature_path + "/id");
            validate_assignments(feature, PropertyOwnerKind::Feature, feature_path);
            validate_inventories(feature.inventories, feature_path + "/inventories");
        }
    }

    void validate_hotspot_common(const Condition& condition, const HotspotHighlight& highlight,
                                 const std::string& path)
    {
        validate_condition(condition, path + "/condition");
        if (const auto* material = std::get_if<MaterialHotspotHighlight>(&highlight);
            material && material->material.text().empty())
            error("compiled_project.invalid_hotspot_material",
                  "Hotspot Material reference must not be empty.", path + "/highlight/material");
    }

    void validate_location(const InteractableLocation& location, const std::string& path)
    {
        if (const auto* room_location = std::get_if<RoomLocation>(&location))
            require(m_rooms, room_location->room, "room", path + "/room");
        else if (const auto* inventory_location = std::get_if<InventoryLocation>(&location))
            validate_inventory_ref(inventory_location->inventory, path + "/inventory");
    }

    void validate_character_location(const CharacterInitialWorldLocation& location,
                                     const std::string& path)
    {
        if (const auto* room_location = std::get_if<RoomLocation>(&location))
            require(m_rooms, room_location->room, "room", path + "/room");
    }

    void validate_transition(const RoomNavigationTransition& transition, const std::string& path)
    {
        if (transition.kind == TransitionKind::Cut && transition.duration_ms != 0)
            error("compiled_project.invalid_navigation_transition",
                  "Cut transitions require zero duration.", path + "/durationMs");
        if (transition.kind != TransitionKind::Cut && transition.duration_ms == 0)
            error("compiled_project.invalid_navigation_transition",
                  "Animated transitions require a positive duration.", path + "/durationMs");
        if (transition.kind != TransitionKind::Fade && transition.color)
            error("compiled_project.invalid_navigation_transition",
                  "Only Fade transitions may specify a color.", path + "/color");
    }

    void validate_program(const InteractionProgram& program, const std::string& path)
    {
        for (std::size_t index = 0; index < program.instructions.size(); ++index) {
            const auto instruction_path = path + "/instructions/" + std::to_string(index);
            std::visit(
                [&](const auto& instruction) {
                    using T = std::decay_t<decltype(instruction)>;
                    if constexpr (std::is_same_v<T, ApplyEffectInstruction>)
                        validate_effect(instruction.effect, instruction_path + "/effect");
                    else if constexpr (std::is_same_v<T, MoveInteractableInstruction>) {
                        require(m_interactables, instruction.interactable, "interactable",
                                instruction_path + "/interactable");
                        validate_location(instruction.target, instruction_path + "/target");
                    } else if constexpr (std::is_same_v<T, SetInteractableStateInstruction>)
                        require(m_interactables, instruction.interactable, "interactable",
                                instruction_path + "/interactable");
                    else if constexpr (std::is_same_v<T, NotifyInstruction>)
                        validate_text(instruction.message, instruction_path + "/message");
                    else if constexpr (std::is_same_v<T, CallSceneInteractionInstruction>)
                        require(m_scenes, instruction.scene, "scene", instruction_path + "/scene");
                    else if constexpr (std::is_same_v<T, CallDialogueInteractionInstruction>)
                        require(m_dialogues, instruction.dialogue, "dialogue",
                                instruction_path + "/dialogue");
                },
                program.instructions[index]);
        }
        validate_flow_target(program.completion, path + "/completion");
    }

    template<class Definition>
    void validate_assignments(const Definition& definition, PropertyOwnerKind owner,
                              const std::string& path)
    {
        std::unordered_set<PropertyId> own_properties;
        for (std::size_t index = 0; index < definition.identity.property_assignments.size();
             ++index) {
            const auto& assignment = definition.identity.property_assignments[index];
            own_properties.insert(assignment.property_id());
            const auto found = m_properties.find(assignment.property_id());
            if (found == m_properties.end()) {
                require(m_properties, assignment.property_id(), "property",
                        path + "/propertyAssignments/" + std::to_string(index) + "/propertyId");
                continue;
            }
            const auto& declaration = m_input.properties[found->second];
            if (!std::binary_search(declaration.allowed_owners().begin(),
                                    declaration.allowed_owners().end(), owner) ||
                !property_value_matches(declaration, assignment.assigned_value()))
                error("compiled_project.invalid_property_assignment",
                      "Property assignment is incompatible with its declaration.",
                      path + "/propertyAssignments/" + std::to_string(index));
        }

        std::unordered_set<TraitId> seen_traits;
        std::unordered_map<PropertyId, RuntimeValue> configured_values;
        std::vector<const TraitDefinition*> attached_traits;
        for (std::size_t index = 0; index < definition.identity.traits.size(); ++index) {
            const auto& trait_id = definition.identity.traits[index];
            const auto trait_path = path + "/traits/" + std::to_string(index);
            if (!seen_traits.insert(trait_id).second) {
                error("compiled_project.duplicate_trait_attachment",
                      "Trait '" + trait_id.text() + "' is attached more than once.", trait_path);
                continue;
            }
            const auto* attached = trait(trait_id);
            if (!attached) {
                require(m_traits, trait_id, "Trait", trait_path);
                continue;
            }
            if (std::find(attached->allowed_owners.begin(), attached->allowed_owners.end(),
                          owner) == attached->allowed_owners.end()) {
                error("compiled_project.invalid_trait_attachment",
                      "Trait '" + trait_id.text() + "' cannot be attached to this owner kind.",
                      trait_path);
                continue;
            }
            attached_traits.push_back(attached);
            for (const auto& member : attached->properties) {
                if (!member.configured_value)
                    continue;
                const auto [existing, inserted] =
                    configured_values.emplace(member.property_id, *member.configured_value);
                if (!inserted && existing->second != *member.configured_value)
                    error("compiled_project.conflicting_trait_configuration",
                          "Attached Traits configure Property '" + member.property_id.text() +
                              "' with conflicting values.",
                          trait_path);
            }
        }
        for (const auto* attached : attached_traits) {
            for (const auto& member : attached->properties) {
                if (member.configured_value)
                    continue;
                const auto* declaration = property(member.property_id);
                const bool has_default = declaration && declaration->default_value().has_value();
                if (!own_properties.contains(member.property_id) &&
                    !configured_values.contains(member.property_id) && !has_default)
                    error("compiled_project.missing_trait_requirement",
                          "Trait '" + attached->id.text() + "' requires Property '" +
                              member.property_id.text() + "' to have an authored value.",
                          path + "/traits");
            }
        }
    }

    void validate_traits()
    {
        for (std::size_t index = 0; index < m_input.traits.size(); ++index) {
            const auto& definition = m_input.traits[index];
            const auto base = "/traits/" + std::to_string(index);
            if (definition.allowed_owners.empty())
                error("compiled_project.invalid_trait_definition",
                      "Trait must admit at least one owner kind.", base + "/ownerKinds");
            std::unordered_set<PropertyOwnerKind> owners;
            for (const auto owner : definition.allowed_owners) {
                if (owner > PropertyOwnerKind::ItemStack)
                    error("compiled_project.invalid_trait_definition",
                          "Trait owner kind is invalid.", base + "/ownerKinds");
                if (!owners.insert(owner).second)
                    error("compiled_project.invalid_trait_definition",
                          "Trait owner kinds must be unique.", base + "/ownerKinds");
            }
            if (definition.properties.empty())
                error("compiled_project.invalid_trait_definition",
                      "Trait must declare at least one Property.", base + "/properties");
            std::unordered_set<PropertyId> property_ids;
            for (std::size_t member_index = 0; member_index < definition.properties.size();
                 ++member_index) {
                const auto& member = definition.properties[member_index];
                const auto member_path = base + "/properties/" + std::to_string(member_index);
                if (!property_ids.insert(member.property_id).second)
                    error("compiled_project.invalid_trait_definition",
                          "Trait Properties must be unique.", member_path + "/propertyId");
                const auto* declaration = property(member.property_id);
                if (!declaration) {
                    require(m_properties, member.property_id, "property",
                            member_path + "/propertyId");
                    continue;
                }
                const bool owners_compatible = std::all_of(
                    definition.allowed_owners.begin(), definition.allowed_owners.end(),
                    [&](PropertyOwnerKind owner) {
                        return std::binary_search(declaration->allowed_owners().begin(),
                                                  declaration->allowed_owners().end(), owner);
                    });
                if (!owners_compatible)
                    error("compiled_project.invalid_trait_property",
                          "Trait Property is not valid for every Trait owner kind.",
                          member_path + "/propertyId");
                if (member.configured_value &&
                    !property_value_matches(*declaration, *member.configured_value))
                    error("compiled_project.invalid_trait_property",
                          "Configured Trait value does not match its Property declaration.",
                          member_path + "/value");
            }
        }
    }

    void validate_localization()
    {
        const LocalizationCatalog* default_catalog = nullptr;
        bool fallback_found = !m_input.localization.fallback_locale.has_value();
        for (const auto& catalog : m_input.localization.catalogs) {
            if (catalog.locale == m_input.localization.default_locale)
                default_catalog = &catalog;
            if (m_input.localization.fallback_locale &&
                catalog.locale == *m_input.localization.fallback_locale)
                fallback_found = true;
        }
        if (!default_catalog)
            error("compiled_project.unresolved_localization", "Default locale has no catalog.",
                  "/localization/defaultLocale");
        else
            for (const auto& entry : default_catalog->entries)
                m_default_localization_keys.insert(entry.key);
        if (!fallback_found)
            error("compiled_project.unresolved_localization", "Fallback locale has no catalog.",
                  "/localization/fallbackLocale");
    }

    void validate_root_and_resources()
    {
        validate_inventories(m_input.inventories, "/inventories");
        validate_transition(m_input.settings.room_navigation_transition,
                            "/settings/roomNavigationTransition");
        std::visit(
            [&](const auto& id) {
                using T = std::decay_t<decltype(id)>;
                if constexpr (std::is_same_v<T, RoomId>)
                    require(m_rooms, id, "room", "/entrypoint");
                else if constexpr (std::is_same_v<T, SceneId>)
                    require(m_scenes, id, "scene", "/entrypoint");
                else
                    require(m_dialogues, id, "dialogue", "/entrypoint");
            },
            m_input.entrypoint);
        require(m_scripts, m_input.bootstrap_module, "script", "/bootstrapModule");
        for (std::size_t index = 0; index < m_input.settings.system_layouts.size(); ++index) {
            if (!m_input.settings.system_layouts[index].layout)
                continue;
            const auto& layout_id = *m_input.settings.system_layouts[index].layout;
            const auto path = "/settings/systemLayouts/" + std::to_string(index) + "/layout";
            require(m_layouts, layout_id, "layout", path);
            const auto layout =
                std::find_if(m_input.layouts.begin(), m_input.layouts.end(),
                             [&](const LayoutResource& value) { return value.id == layout_id; });
            if (layout != m_input.layouts.end() &&
                (!layout->contract.inputs.empty() || !layout->contract.signals.empty() ||
                 layout->contract.state.has_value()))
                error("compiled_project.system_layout_custom_contract",
                      "System Layout Roles use fixed engine contracts; project Layouts assigned to "
                      "a System Layout Role must not declare custom inputs, signals, or State "
                      "Shapes.",
                      path);
        }
        if (m_input.settings.text.default_font)
            require(m_assets, *m_input.settings.text.default_font, "asset",
                    "/settings/text/defaultFont");
        if (m_input.settings.title_screen.title_image)
            require(m_assets, *m_input.settings.title_screen.title_image, "asset",
                    "/settings/titleScreen/titleImage");
        for (std::size_t index = 0; index < m_input.layouts.size(); ++index) {
            const auto path = item("/resources/layouts", index);
            const auto& layout = m_input.layouts[index];
            auto source = [&](const LayoutSource& value, const std::string& source_path) {
                if (const auto* asset = std::get_if<AssetLayoutSource>(&value))
                    require(m_assets, asset->asset, "asset", source_path);
            };
            source(layout.rml, path + "/rml");
            source(layout.rcss, path + "/rcss");
            source(layout.lua, path + "/lua");
            auto assets = [&](const std::vector<AssetId>& values, std::string_view field) {
                for (std::size_t dependency = 0; dependency < values.size(); ++dependency)
                    require(m_assets, values[dependency], "asset",
                            path + "/dependencies/" + std::string(field) + "/" +
                                std::to_string(dependency));
            };
            assets(layout.dependencies.fonts, "fonts");
            assets(layout.dependencies.images, "images");
            assets(layout.dependencies.scripts, "scripts");
            assets(layout.dependencies.stylesheets, "stylesheets");

            std::unordered_set<LayoutInputId> input_ids;
            for (std::size_t input_index = 0; input_index < layout.contract.inputs.size();
                 ++input_index) {
                const auto& input = layout.contract.inputs[input_index];
                if (!input_ids.insert(input.id).second)
                    error("compiled_project.duplicate_layout_input",
                          "Layout contract input IDs must be unique.",
                          path + "/contract/inputs/" + std::to_string(input_index) + "/id");
                if (input.default_value &&
                    !layout_contract_value_matches(input.shape, *input.default_value))
                    error("compiled_project.invalid_layout_input_default",
                          "Layout input default must match its declared type and nullability.",
                          path + "/contract/inputs/" + std::to_string(input_index) +
                              "/defaultValue");
            }
            if (layout.contract.state && !layout_state_shape_valid(*layout.contract.state))
                error("compiled_project.invalid_layout_state_shape",
                      "Layout State Shape defaults and recursive members must be valid.",
                      path + "/contract/state");
            std::unordered_set<LayoutSignalId> signal_ids;
            for (std::size_t signal_index = 0; signal_index < layout.contract.signals.size();
                 ++signal_index) {
                const auto& signal = layout.contract.signals[signal_index];
                if (!signal_ids.insert(signal.id).second)
                    error("compiled_project.duplicate_layout_signal",
                          "Layout contract signal IDs must be unique.",
                          path + "/contract/signals/" + std::to_string(signal_index) + "/id");
                std::unordered_set<LayoutSignalFieldId> field_ids;
                for (std::size_t field_index = 0; field_index < signal.fields.size(); ++field_index)
                    if (!field_ids.insert(signal.fields[field_index].id).second)
                        error("compiled_project.duplicate_layout_signal_field",
                              "Layout signal field IDs must be unique.",
                              path + "/contract/signals/" + std::to_string(signal_index) +
                                  "/fields/" + std::to_string(field_index) + "/id");
            }
        }
        for (std::size_t index = 0; index < m_input.scripts.size(); ++index)
            if (const auto* source = std::get_if<AssetScriptSource>(&m_input.scripts[index].source))
                require(m_assets, source->asset, "asset",
                        item("/resources/scripts", index) + "/source/asset");
    }

    void validate_definitions()
    {
        validate_characters();
        validate_rooms();
        validate_interactables();
        validate_items();
        validate_inventory_cycles();
        validate_verbs_and_interactions();
        validate_scenes();
        validate_dialogues();
        validate_maps();
        validate_direct_entrypoint();
    }

    void validate_characters()
    {
        for (std::size_t index = 0; index < m_input.characters.size(); ++index) {
            const auto& character = m_input.characters[index];
            const auto path = item("/definitions/characters", index);
            validate_assignments(character, PropertyOwnerKind::Character, path);
            validate_inventories(character.inventories, path + "/inventories");
            std::unordered_set<CharacterPresentationProfileId> profiles;
            std::unordered_set<CharacterExpressionId> expressions;
            std::unordered_set<CharacterAppearanceId> appearances;
            std::unordered_set<CharacterIdleId> idles;
            for (std::size_t profile_index = 0; profile_index < character.profiles.size();
                 ++profile_index) {
                const auto& profile = character.profiles[profile_index];
                const auto profile_path = path + "/profiles/" + std::to_string(profile_index);
                if (!profiles.insert(profile.id).second)
                    error("compiled_project.duplicate_nested_id",
                          "Duplicate Character presentation profile ID.", profile_path + "/id");
                std::unordered_set<CharacterPresentationLayerId> layers;
                std::unordered_set<std::string> roles;
                for (std::size_t layer_index = 0; layer_index < profile.layers.size();
                     ++layer_index) {
                    if (!layers.insert(profile.layers[layer_index].id).second)
                        error("compiled_project.duplicate_nested_id",
                              "Duplicate Character presentation layer ID.",
                              profile_path + "/layers/" + std::to_string(layer_index) + "/id");
                    if (profile.layers[layer_index].role)
                        roles.insert(*profile.layers[layer_index].role);
                }
                std::unordered_set<CharacterPoseId> poses;
                for (std::size_t pose_index = 0; pose_index < profile.poses.size(); ++pose_index) {
                    const auto& pose = profile.poses[pose_index];
                    const auto pose_path = profile_path + "/poses/" + std::to_string(pose_index);
                    if (!poses.insert(pose.id).second)
                        error("compiled_project.duplicate_nested_id",
                              "Duplicate Character pose ID.", pose_path + "/id");
                    std::unordered_set<CharacterPresentationLayerId> pose_layers;
                    for (std::size_t layer_index = 0; layer_index < pose.layers.size();
                         ++layer_index) {
                        const auto& layer = pose.layers[layer_index];
                        const auto layer_path =
                            pose_path + "/layers/" + std::to_string(layer_index);
                        if (!pose_layers.insert(layer.layer_id).second)
                            error("compiled_project.duplicate_nested_id",
                                  "Duplicate Character pose layer ID.", layer_path + "/layerId");
                        if (!layers.contains(layer.layer_id))
                            error("compiled_project.unresolved_nested_reference",
                                  "Character pose references a missing presentation layer.",
                                  layer_path + "/layerId");
                        if (layer.sprite)
                            require(m_assets, *layer.sprite, "asset", layer_path + "/sprite");
                        if (layer.material)
                            require(m_material_interfaces, *layer.material, "material",
                                    layer_path + "/material");
                    }
                }
                if (!poses.contains(profile.default_pose_id))
                    error("compiled_project.unresolved_nested_reference",
                          "Character presentation profile default pose is missing.",
                          profile_path + "/defaultPoseId");
                std::unordered_set<CharacterAnimationClipId> clips;
                for (std::size_t clip_index = 0; clip_index < profile.animation_clips.size();
                     ++clip_index) {
                    const auto& clip = profile.animation_clips[clip_index];
                    const auto clip_path =
                        profile_path + "/animationClips/" + std::to_string(clip_index);
                    if (!clips.insert(clip.id).second)
                        error("compiled_project.duplicate_nested_id",
                              "Duplicate Character animation clip ID.", clip_path + "/id");
                    if (clip.frames.empty())
                        error("compiled_project.invalid_character_animation_clip",
                              "Character animation clip requires at least one frame.",
                              clip_path + "/frames");
                    for (std::size_t frame_index = 0; frame_index < clip.frames.size();
                         ++frame_index) {
                        const auto& frame = clip.frames[frame_index];
                        const auto frame_path =
                            clip_path + "/frames/" + std::to_string(frame_index);
                        if (frame.duration_ms == 0)
                            error("compiled_project.invalid_character_animation_clip",
                                  "Character animation frame duration must be positive.",
                                  frame_path + "/durationMs");
                        std::unordered_set<CharacterPresentationLayerId> frame_layers;
                        for (std::size_t layer_index = 0; layer_index < frame.layers.size();
                             ++layer_index) {
                            const auto& layer = frame.layers[layer_index];
                            const auto layer_path =
                                frame_path + "/layers/" + std::to_string(layer_index);
                            if (!frame_layers.insert(layer.layer_id).second)
                                error("compiled_project.duplicate_nested_id",
                                      "Duplicate Character animation frame layer ID.",
                                      layer_path + "/layerId");
                            if (!layers.contains(layer.layer_id))
                                error("compiled_project.unresolved_nested_reference",
                                      "Character animation frame references a missing layer.",
                                      layer_path + "/layerId");
                            if (layer.sprite.specified && layer.sprite.value)
                                require(m_assets, *layer.sprite.value, "asset",
                                        layer_path + "/sprite");
                            if (layer.material.specified && layer.material.value)
                                require(m_material_interfaces, *layer.material.value, "material",
                                        layer_path + "/material");
                        }
                    }
                }
                const auto validate_automatic = [&](const auto& automatic,
                                                    const std::string& automatic_path) {
                    if (!clips.contains(automatic.clip_id))
                        error("compiled_project.unresolved_nested_reference",
                              "Character automatic animation references a missing clip.",
                              automatic_path + "/clipId");
                    if (!roles.contains(automatic.role))
                        error("compiled_project.unresolved_nested_reference",
                              "Character automatic animation references an unused semantic role.",
                              automatic_path + "/role");
                };
                if (profile.automatic_animations.blink) {
                    validate_automatic(*profile.automatic_animations.blink,
                                       profile_path + "/automaticAnimations/blink");
                    if (profile.automatic_animations.blink->interval_ms == 0)
                        error("compiled_project.invalid_character_animation_clip",
                              "Automatic blink interval must be positive.",
                              profile_path + "/automaticAnimations/blink/intervalMs");
                }
                if (profile.automatic_animations.speaking)
                    validate_automatic(*profile.automatic_animations.speaking,
                                       profile_path + "/automaticAnimations/speaking");
            }
            const auto validate_overrides = [&](const auto& entry, const std::string& entry_path) {
                std::unordered_set<CharacterPresentationProfileId> seen_profiles;
                for (std::size_t profile_index = 0; profile_index < entry.profiles.size();
                     ++profile_index) {
                    const auto& profile_override = entry.profiles[profile_index];
                    const auto override_path =
                        entry_path + "/profiles/" + std::to_string(profile_index);
                    if (!seen_profiles.insert(profile_override.profile_id).second)
                        error("compiled_project.duplicate_nested_id",
                              "Duplicate Character semantic profile override.",
                              override_path + "/profileId");
                    const auto profile =
                        std::ranges::find_if(character.profiles, [&](const auto& candidate) {
                            return candidate.id == profile_override.profile_id;
                        });
                    if (profile == character.profiles.end()) {
                        error("compiled_project.unresolved_nested_reference",
                              "Character semantic override references a missing profile.",
                              override_path + "/profileId");
                        continue;
                    }
                    std::unordered_set<CharacterPresentationLayerId> seen_layers;
                    for (std::size_t layer_index = 0; layer_index < profile_override.layers.size();
                         ++layer_index) {
                        const auto& layer = profile_override.layers[layer_index];
                        const auto layer_path =
                            override_path + "/layers/" + std::to_string(layer_index);
                        if (!seen_layers.insert(layer.layer_id).second)
                            error("compiled_project.duplicate_nested_id",
                                  "Duplicate Character semantic layer override.",
                                  layer_path + "/layerId");
                        if (std::ranges::none_of(profile->layers, [&](const auto& candidate) {
                                return candidate.id == layer.layer_id;
                            }))
                            error("compiled_project.unresolved_nested_reference",
                                  "Character semantic override references a missing layer.",
                                  layer_path + "/layerId");
                        if (layer.sprite.specified && layer.sprite.value)
                            require(m_assets, *layer.sprite.value, "asset", layer_path + "/sprite");
                        if (layer.material.specified && layer.material.value)
                            require(m_material_interfaces, *layer.material.value, "material",
                                    layer_path + "/material");
                    }
                }
            };
            for (std::size_t expression_index = 0; expression_index < character.expressions.size();
                 ++expression_index) {
                const auto& expression = character.expressions[expression_index];
                if (!expressions.insert(expression.id).second)
                    error("compiled_project.duplicate_nested_id",
                          "Duplicate Character expression ID.",
                          path + "/expressions/" + std::to_string(expression_index) + "/id");
                validate_overrides(expression,
                                   path + "/expressions/" + std::to_string(expression_index));
            }
            for (std::size_t appearance_index = 0; appearance_index < character.appearances.size();
                 ++appearance_index) {
                const auto& appearance = character.appearances[appearance_index];
                if (!appearances.insert(appearance.id).second)
                    error("compiled_project.duplicate_nested_id",
                          "Duplicate Character appearance ID.",
                          path + "/appearances/" + std::to_string(appearance_index) + "/id");
                validate_overrides(appearance,
                                   path + "/appearances/" + std::to_string(appearance_index));
            }
            std::unordered_set<CharacterGestureId> gestures;
            for (std::size_t gesture_index = 0; gesture_index < character.gestures.size();
                 ++gesture_index) {
                const auto& gesture = character.gestures[gesture_index];
                const auto gesture_path = path + "/gestures/" + std::to_string(gesture_index);
                if (!gestures.insert(gesture.id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Character gesture ID.",
                          gesture_path + "/id");
                std::unordered_set<CharacterPresentationProfileId> gesture_profiles;
                for (std::size_t profile_index = 0; profile_index < gesture.profiles.size();
                     ++profile_index) {
                    const auto& gesture_profile = gesture.profiles[profile_index];
                    const auto gesture_profile_path =
                        gesture_path + "/profiles/" + std::to_string(profile_index);
                    if (!gesture_profiles.insert(gesture_profile.profile_id).second)
                        error("compiled_project.duplicate_nested_id",
                              "Duplicate Character gesture profile mapping.",
                              gesture_profile_path + "/profileId");
                    const auto profile =
                        std::ranges::find_if(character.profiles, [&](const auto& candidate) {
                            return candidate.id == gesture_profile.profile_id;
                        });
                    if (profile == character.profiles.end()) {
                        error("compiled_project.unresolved_nested_reference",
                              "Character gesture references a missing presentation profile.",
                              gesture_profile_path + "/profileId");
                        continue;
                    }
                    const auto clip =
                        std::ranges::find_if(profile->animation_clips, [&](const auto& candidate) {
                            return candidate.id == gesture_profile.clip_id;
                        });
                    if (clip == profile->animation_clips.end()) {
                        error("compiled_project.unresolved_nested_reference",
                              "Character gesture references a missing animation clip.",
                              gesture_profile_path + "/clipId");
                        continue;
                    }
                    std::uint64_t duration_ms = 0;
                    for (const auto& frame : clip->frames)
                        duration_ms += frame.duration_ms;
                    std::unordered_set<CharacterGestureCueId> cues;
                    for (std::size_t cue_index = 0; cue_index < gesture_profile.cues.size();
                         ++cue_index) {
                        const auto& cue = gesture_profile.cues[cue_index];
                        const auto cue_path =
                            gesture_profile_path + "/cues/" + std::to_string(cue_index);
                        std::visit(
                            [&](const auto& value) {
                                if (!cues.insert(value.id).second)
                                    error("compiled_project.duplicate_nested_id",
                                          "Duplicate Character gesture cue ID.", cue_path + "/id");
                                if (value.at_ms > duration_ms)
                                    error("compiled_project.invalid_character_gesture_cue",
                                          "Character gesture cue occurs after its animation clip.",
                                          cue_path + "/atMs");
                                using T = std::decay_t<decltype(value)>;
                                if constexpr (std::is_same_v<T, CharacterAudioGestureCue>)
                                    require(m_assets, value.asset, "asset", cue_path + "/asset");
                            },
                            cue);
                    }
                }
            }
            for (const auto& idle : character.idles)
                idles.insert(idle.id);
            if (!profiles.contains(character.defaults.profile_id))
                error("compiled_project.unresolved_nested_reference", "Default profile is missing.",
                      path + "/defaults/profileId");
            if (!expressions.contains(character.defaults.expression_id))
                error("compiled_project.unresolved_nested_reference",
                      "Default expression is missing.", path + "/defaults/expressionId");
            if (character.defaults.appearance_id &&
                !appearances.contains(*character.defaults.appearance_id))
                error("compiled_project.unresolved_nested_reference",
                      "Default appearance is missing.", path + "/defaults/appearanceId");
            if (character.defaults.idle_id && !idles.contains(*character.defaults.idle_id))
                error("compiled_project.unresolved_nested_reference", "Default idle is missing.",
                      path + "/defaults/idleId");
            validate_character_location(character.initial_world_state.location,
                                        path + "/initialWorldState/location");
        }
    }

    void validate_rooms()
    {
        for (std::size_t index = 0; index < m_input.rooms.size(); ++index) {
            const auto& value = m_input.rooms[index];
            const auto path = item("/definitions/rooms", index);
            validate_assignments(value, PropertyOwnerKind::Room, path);
            validate_features(value, path);
            validate_text(value.description, path + "/description");
            validate_background(value.background, path + "/background");
            validate_condition(value.lifecycle.can_enter, path + "/lifecycle/canEnter");
            validate_condition(value.lifecycle.can_leave, path + "/lifecycle/canLeave");
            std::unordered_set<RoomOverlayId> overlay_ids;
            for (std::size_t overlay = 0; overlay < value.overlays.size(); ++overlay) {
                if (!overlay_ids.insert(value.overlays[overlay].id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Room overlay ID.",
                          path + "/overlays/" + std::to_string(overlay) + "/id");
                require(m_layouts, value.overlays[overlay].layout, "layout",
                        path + "/overlays/" + std::to_string(overlay) + "/layout");
                validate_condition(value.overlays[overlay].condition,
                                   path + "/overlays/" + std::to_string(overlay) + "/condition");
            }
            std::unordered_set<RoomPlacementId> placement_ids;
            for (std::size_t placement_index = 0; placement_index < value.placements.size();
                 ++placement_index) {
                const auto& placed = value.placements[placement_index];
                const auto placement_path = path + "/placements/" + std::to_string(placement_index);
                if (!placement_ids.insert(placed.id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Room placement ID.",
                          placement_path + "/id");
                if (placed.presentation.layout)
                    require(m_layouts, *placed.presentation.layout, "layout",
                            placement_path + "/presentation/layout");
                if (placed.presentation.label)
                    validate_text(*placed.presentation.label,
                                  placement_path + "/presentation/label");
            }
            std::unordered_set<RoomCastEntryId> cast_ids;
            for (std::size_t cast_index = 0; cast_index < value.cast.size(); ++cast_index) {
                const auto& entry = value.cast[cast_index];
                const auto cast_path = path + "/cast/" + std::to_string(cast_index);
                if (!cast_ids.insert(entry.id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Room cast ID.",
                          cast_path + "/id");
                require(m_characters, entry.character, "character", cast_path + "/character");
                if (!placement(RoomPlacementRef{value.identity.id, entry.placement_id}))
                    error("compiled_project.unresolved_nested_reference",
                          "Room cast references a missing placement.", cast_path + "/placementId");
                validate_condition(entry.condition, cast_path + "/condition");
                const auto character = m_characters.find(entry.character);
                if (character != m_characters.end()) {
                    const auto& definition = m_input.characters[character->second];
                    const auto profile_id =
                        entry.profile_id.value_or(definition.defaults.profile_id);
                    const auto profile =
                        std::ranges::find_if(definition.profiles, [&](const auto& candidate) {
                            return candidate.id == profile_id;
                        });
                    if (profile == definition.profiles.end())
                        error("compiled_project.unresolved_nested_reference",
                              "Room cast profile is absent from its Character.",
                              cast_path + "/profileId");
                    if (entry.pose_id && profile != definition.profiles.end() &&
                        std::ranges::none_of(profile->poses, [&](const auto& pose) {
                            return pose.id == *entry.pose_id;
                        }))
                        error("compiled_project.unresolved_nested_reference",
                              "Room cast pose is absent from its Character.",
                              cast_path + "/poseId");
                    if (entry.expression_id) {
                        const auto found = std::ranges::find_if(
                            definition.expressions, [&](const auto& candidate) {
                                return candidate.id == *entry.expression_id;
                            });
                        if (found == definition.expressions.end())
                            error("compiled_project.unresolved_nested_reference",
                                  "Room cast expression is absent from its Character.",
                                  cast_path + "/expressionId");
                    }
                    if (entry.appearance_id &&
                        std::ranges::none_of(definition.appearances, [&](const auto& appearance) {
                            return appearance.id == *entry.appearance_id;
                        }))
                        error("compiled_project.unresolved_nested_reference",
                              "Room cast appearance is absent from its Character.",
                              cast_path + "/appearanceId");
                    if (entry.idle_id &&
                        std::ranges::none_of(definition.idles, [&](const auto& idle) {
                            return idle.id == *entry.idle_id;
                        }))
                        error("compiled_project.unresolved_nested_reference",
                              "Room cast idle is absent from its Character.",
                              cast_path + "/idleId");
                }
            }
            std::unordered_set<RoomInteractableEntryId> interactable_ids;
            for (std::size_t interactable_index = 0;
                 interactable_index < value.interactables.size(); ++interactable_index) {
                const auto& entry = value.interactables[interactable_index];
                const auto entry_path =
                    path + "/interactables/" + std::to_string(interactable_index);
                if (!interactable_ids.insert(entry.id).second)
                    error("compiled_project.duplicate_nested_id",
                          "Duplicate Room interactable occurrence ID.", entry_path + "/id");
                require(m_interactables, entry.interactable, "interactable",
                        entry_path + "/interactable");
                if (!placement(RoomPlacementRef{value.identity.id, entry.placement_id}))
                    error("compiled_project.unresolved_nested_reference",
                          "Room interactable occurrence references a missing placement.",
                          entry_path + "/placementId");
                validate_condition(entry.condition, entry_path + "/condition");
            }
            std::unordered_set<RoomPropId> prop_ids;
            for (std::size_t prop_index = 0; prop_index < value.props.size(); ++prop_index) {
                const auto& prop = value.props[prop_index];
                const auto prop_path = path + "/props/" + std::to_string(prop_index);
                if (!prop_ids.insert(prop.id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Room prop ID.",
                          prop_path + "/id");
                if (!placement(RoomPlacementRef{value.identity.id, prop.placement_id}))
                    error("compiled_project.unresolved_nested_reference",
                          "Room prop references a missing placement.", prop_path + "/placementId");
                if (!prop.asset && !prop.material)
                    error("compiled_project.invalid_room_prop",
                          "Room prop requires an asset and/or material.", prop_path);
                if (prop.asset)
                    require(m_assets, *prop.asset, "asset", prop_path + "/asset");
                validate_condition(prop.condition, prop_path + "/condition");
            }
            std::unordered_set<RoomEnvironmentId> environment_ids;
            for (std::size_t environment_index = 0; environment_index < value.environments.size();
                 ++environment_index) {
                const auto& environment = value.environments[environment_index];
                const auto environment_path =
                    path + "/environments/" + std::to_string(environment_index);
                if (!environment_ids.insert(environment.id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Room environment ID.",
                          environment_path + "/id");
                if (environment.asset)
                    require(m_assets, *environment.asset, "asset", environment_path + "/asset");
                validate_condition(environment.condition, environment_path + "/condition");
            }
            std::unordered_set<RoomScriptHookKind> script_hook_kinds;
            for (std::size_t hook_index = 0; hook_index < value.script_hooks.size(); ++hook_index) {
                const auto& mapping = value.script_hooks[hook_index];
                const auto hook_path = path + "/scriptHooks/" + std::to_string(hook_index);
                if (!script_hook_kinds.insert(mapping.hook).second)
                    error("compiled_project.duplicate_hook_mapping",
                          "Duplicate Room script hook mapping.", hook_path + "/hook");
                require(m_scripts, mapping.handler.module, "script", hook_path + "/handler/module");
            }
            std::unordered_set<RoomExitId> exit_ids;
            std::unordered_set<RoomExitDirection> exit_directions;
            for (std::size_t exit_index = 0; exit_index < value.exits.size(); ++exit_index) {
                const auto& linked_exit = value.exits[exit_index];
                const auto exit_path = path + "/exits/" + std::to_string(exit_index);
                if (!exit_ids.insert(linked_exit.id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Room exit ID.",
                          exit_path + "/id");
                if (!exit_directions.insert(linked_exit.direction).second)
                    error("compiled_project.duplicate_room_exit_direction",
                          "Each Room exit direction may be used once.", exit_path + "/direction");
                require(m_rooms, linked_exit.target, "room", exit_path + "/target");
                validate_condition(linked_exit.condition, exit_path + "/condition");
                validate_text(linked_exit.label, exit_path + "/label");
                if (linked_exit.transition)
                    validate_transition(*linked_exit.transition, exit_path + "/transition");
            }
            if (!value.hotspots.empty()) {
                if (!value.background.asset)
                    error("compiled_project.hotspot_source_image_required",
                          "Room hotspots require a background image Asset.",
                          path + "/background/asset");
                else if (const auto* source = asset(*value.background.asset);
                         source && source->kind != AssetKind::Image)
                    error("compiled_project.hotspot_source_image_invalid",
                          "Room hotspot source Asset must be an image.",
                          path + "/background/asset");
            }
            std::unordered_set<HotspotId> hotspot_ids;
            for (std::size_t hotspot_index = 0; hotspot_index < value.hotspots.size();
                 ++hotspot_index) {
                const auto& hotspot = value.hotspots[hotspot_index];
                const auto hotspot_path = path + "/hotspots/" + std::to_string(hotspot_index);
                if (!hotspot_ids.insert(hotspot.id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Room hotspot ID.",
                          hotspot_path + "/id");
                validate_hotspot_common(hotspot.condition, hotspot.highlight, hotspot_path);
                std::visit(
                    [&](const auto& target) {
                        using T = std::decay_t<decltype(target)>;
                        if constexpr (std::is_same_v<T, HotspotOwnerFeatureTarget>) {
                            if (!feature(RoomFeatureRef{value.identity.id, target.feature_id}))
                                error("compiled_project.unresolved_nested_reference",
                                      "Room hotspot references a Feature outside its owning Room.",
                                      hotspot_path + "/target/featureId");
                        } else if constexpr (std::is_same_v<T, HotspotSubjectTarget>)
                            validate_interaction_subject(target.subject,
                                                         hotspot_path + "/target/subject");
                        else if (!exit_ids.contains(target.exit_id))
                            error("compiled_project.unresolved_nested_reference",
                                  "Room hotspot references an exit outside its owning Room.",
                                  hotspot_path + "/target/exitId");
                    },
                    hotspot.target);
            }
        }
    }

    void validate_interactables()
    {
        for (std::size_t index = 0; index < m_input.interactables.size(); ++index) {
            const auto& value = m_input.interactables[index];
            const auto path = item("/definitions/interactables", index);
            validate_assignments(value, PropertyOwnerKind::Interactable, path);
            validate_features(value, path);
            validate_inventories(value.inventories, path + "/inventories");
            validate_location(value.initial_state.location, path + "/initialState/location");
            if (value.presentation.sprite)
                require(m_assets, *value.presentation.sprite, "asset",
                        path + "/presentation/sprite");
            const bool requires_sprite = std::visit(
                [](const auto& definition) {
                    using T = std::decay_t<decltype(definition)>;
                    if constexpr (std::is_same_v<T, SpriteAlphaHotspots>)
                        return true;
                    else
                        return !definition.hotspots.empty();
                },
                value.presentation.hotspots);
            if (requires_sprite && !value.presentation.sprite)
                error("compiled_project.hotspot_source_image_required",
                      "Interactable hotspots require a sprite image Asset.",
                      path + "/presentation/sprite");
            else if (requires_sprite && value.presentation.sprite) {
                const auto* source = asset(*value.presentation.sprite);
                if (source && source->kind != AssetKind::Image)
                    error("compiled_project.hotspot_source_image_invalid",
                          "Interactable hotspot source Asset must be an image.",
                          path + "/presentation/sprite");
            }
            std::unordered_set<HotspotId> hotspot_ids;
            std::visit(
                [&](const auto& definition) {
                    using T = std::decay_t<decltype(definition)>;
                    const auto validate_target = [&](const auto& hotspot,
                                                     const std::string& hotspot_path) {
                        std::visit(
                            [&](const auto& target) {
                                using H = std::decay_t<decltype(target)>;
                                if constexpr (std::is_same_v<H, HotspotOwnerFeatureTarget>) {
                                    if (!feature(InteractableFeatureRef{value.identity.id,
                                                                        target.feature_id}))
                                        error("compiled_project.unresolved_nested_reference",
                                              "Interactable hotspot references a Feature outside "
                                              "its owning Interactable.",
                                              hotspot_path + "/target/featureId");
                                } else if constexpr (std::is_same_v<H, HotspotSubjectTarget>)
                                    validate_interaction_subject(target.subject,
                                                                 hotspot_path + "/target/subject");
                            },
                            hotspot.target);
                    };
                    if constexpr (std::is_same_v<T, SpriteAlphaHotspots>) {
                        const auto& hotspot = definition.hotspot;
                        const auto hotspot_path = path + "/presentation/hotspots/hotspot";
                        validate_hotspot_common(hotspot.condition, hotspot.highlight, hotspot_path);
                        validate_target(hotspot, hotspot_path);
                    } else {
                        for (std::size_t hotspot_index = 0;
                             hotspot_index < definition.hotspots.size(); ++hotspot_index) {
                            const auto& hotspot = definition.hotspots[hotspot_index];
                            const auto hotspot_path = path + "/presentation/hotspots/hotspots/" +
                                                      std::to_string(hotspot_index);
                            if (!hotspot_ids.insert(hotspot.id).second)
                                error("compiled_project.duplicate_nested_id",
                                      "Duplicate Interactable hotspot ID.", hotspot_path + "/id");
                            validate_hotspot_common(hotspot.condition, hotspot.highlight,
                                                    hotspot_path);
                            validate_target(hotspot, hotspot_path);
                        }
                    }
                },
                value.presentation.hotspots);
        }
    }

    void validate_items()
    {
        for (std::size_t index = 0; index < m_input.item_definitions.size(); ++index) {
            const auto& value = m_input.item_definitions[index];
            const auto path = item("/definitions/itemDefinitions", index);
            validate_assignments(value, PropertyOwnerKind::ItemStack, path);
            if (value.presentation.sprite)
                require(m_assets, *value.presentation.sprite, "asset",
                        path + "/presentation/sprite");
            if (value.stack_limit &&
                (*value.stack_limit == 0 || *value.stack_limit > max_item_stack_quantity))
                error("compiled_project.invalid_item_stack_limit",
                      "Item Definition Stack limit must be in the portable positive range.",
                      path + "/stackLimit");
        }
        for (std::size_t index = 0; index < m_input.item_stacks.size(); ++index) {
            const auto& value = m_input.item_stacks[index];
            const auto path = item("/itemStacks", index);
            require(m_item_definitions, value.definition, "item definition", path + "/definition");
            validate_location(value.location, path + "/location");
            if (value.quantity == 0 || value.quantity > max_item_stack_quantity)
                error("compiled_project.invalid_item_stack_quantity",
                      "Item Stack quantity must be in the portable positive range.",
                      path + "/quantity");
            const auto definition = m_item_definitions.find(value.definition);
            if (definition != m_item_definitions.end()) {
                const auto& item_definition = m_input.item_definitions[definition->second];
                if (item_definition.stack_limit && value.quantity > *item_definition.stack_limit)
                    error("compiled_project.item_stack_limit_exceeded",
                          "Declared Item Stack quantity exceeds its Item Definition limit.",
                          path + "/quantity");
            }
        }
    }

    void validate_inventory_cycles()
    {
        for (std::size_t index = 0; index < m_input.interactables.size(); ++index) {
            const auto& start = m_input.interactables[index];
            std::unordered_set<InteractableId> visited;
            visited.insert(start.identity.id);
            const InteractableDefinition* current = &start;
            while (const auto* location =
                       std::get_if<InventoryLocation>(&current->initial_state.location)) {
                const auto owner = inventory_interactable_owner(location->inventory);
                if (!owner)
                    break;
                if (!visited.insert(*owner).second) {
                    error("compiled_project.inventory_containment_cycle",
                          "Inventory containment must be acyclic.",
                          item("/definitions/interactables", index) +
                              "/initialState/location/inventory");
                    break;
                }
                current = interactable(*owner);
                if (!current)
                    break;
            }
        }
    }

    void validate_verbs_and_interactions()
    {
        for (std::size_t index = 0; index < m_input.verbs.size(); ++index) {
            const auto& value = m_input.verbs[index];
            const auto path = item("/definitions/verbs", index);
            validate_text(value.action_text, path + "/actionText");
            validate_text(value.completed_command_text, path + "/completedCommandText");
            std::unordered_set<VerbSlotId> slot_ids;
            for (std::size_t slot_index = 0; slot_index < value.slots.size(); ++slot_index) {
                const auto& slot = value.slots[slot_index];
                const auto slot_path = path + "/slots/" + std::to_string(slot_index);
                slot_ids.insert(slot.id);
                validate_text(slot.label, slot_path + "/label");
                validate_text(slot.prompt, slot_path + "/prompt");
                for (std::size_t selector_index = 0; selector_index < slot.selectors.size();
                     ++selector_index)
                    validate_subject_selector(slot.selectors[selector_index],
                                              slot_path + "/selectors/" +
                                                  std::to_string(selector_index));
            }
            std::unordered_set<VerbSlotId> binding_ids;
            for (std::size_t order_index = 0; order_index < value.binding_order.size();
                 ++order_index) {
                const auto& slot_id = value.binding_order[order_index];
                const auto order_path = path + "/bindingOrder/" + std::to_string(order_index);
                if (!binding_ids.insert(slot_id).second || !slot_ids.contains(slot_id))
                    error("compiled_project.invalid_verb_binding_order",
                          "Verb bindingOrder must contain every slot exactly once.", order_path);
            }
            if (binding_ids.size() != slot_ids.size())
                error("compiled_project.invalid_verb_binding_order",
                      "Verb bindingOrder must contain every slot exactly once.",
                      path + "/bindingOrder");
            std::unordered_set<VerbOfferId> offer_ids;
            for (std::size_t offer_index = 0; offer_index < value.offers.size(); ++offer_index) {
                const auto& offer = value.offers[offer_index];
                const auto offer_path = path + "/offers/" + std::to_string(offer_index);
                if (!offer_ids.insert(offer.id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Verb Offer ID.",
                          offer_path + "/id");
                if (!slot_ids.contains(offer.slot_id))
                    error("compiled_project.invalid_verb_offer_slot",
                          "Verb Offer starting slot must name a Verb slot.",
                          offer_path + "/slotId");
                for (std::size_t selector_index = 0; selector_index < offer.selectors.size();
                     ++selector_index)
                    validate_subject_selector(offer.selectors[selector_index],
                                              offer_path + "/selectors/" +
                                                  std::to_string(selector_index));
                if (offer.condition)
                    validate_condition(*offer.condition, offer_path + "/condition");
            }
            validate_condition(value.availability, path + "/availability");
            validate_program(value.default_program, path + "/defaultProgram");
        }
        if (m_input.undefined_interaction_program)
            validate_program(*m_input.undefined_interaction_program,
                             "/undefinedInteractionProgram");
        for (std::size_t index = 0; index < m_input.interactions.size(); ++index) {
            const auto& value = m_input.interactions[index];
            const auto path = item("/definitions/interactions", index);
            for (std::size_t rule_index = 0; rule_index < value.rules.size(); ++rule_index) {
                const auto& rule = value.rules[rule_index];
                const auto rule_path = path + "/rules/" + std::to_string(rule_index);
                require(m_verbs, rule.verb, "verb", rule_path + "/verb");
                const auto verb = m_verbs.find(rule.verb);
                std::unordered_set<VerbSlotId> rule_slots;
                for (std::size_t slot_index = 0; slot_index < rule.slots.size(); ++slot_index) {
                    const auto& slot = rule.slots[slot_index];
                    const auto slot_path = rule_path + "/slots/" + std::to_string(slot_index);
                    if (!rule_slots.insert(slot.slot_id).second)
                        error("compiled_project.duplicate_nested_id",
                              "Duplicate Interaction slot ID.", slot_path + "/slotId");
                    for (std::size_t selector_index = 0; selector_index < slot.selectors.size();
                         ++selector_index)
                        validate_subject_selector(slot.selectors[selector_index],
                                                  slot_path + "/selectors/" +
                                                      std::to_string(selector_index));
                }
                if (verb != m_verbs.end()) {
                    const auto& verb_definition = m_input.verbs[verb->second];
                    const bool all_known =
                        std::all_of(rule_slots.begin(), rule_slots.end(), [&](const auto& slot_id) {
                            return std::any_of(
                                verb_definition.slots.begin(), verb_definition.slots.end(),
                                [&](const auto& slot) { return slot.id == slot_id; });
                        });
                    if (!all_known || rule_slots.size() != verb_definition.slots.size())
                        error("compiled_project.interaction_slot_mismatch",
                              "Interaction rule must define every named Verb slot exactly once.",
                              rule_path + "/slots");
                    if (rule.offer && !rule_slots.contains(rule.offer->slot_id))
                        error("compiled_project.invalid_interaction_offer_slot",
                              "Rule-derived Offer starting slot must name a rule slot.",
                              rule_path + "/offer/slotId");
                }
                if (rule.offer && rule.offer->condition)
                    validate_condition(*rule.offer->condition, rule_path + "/offer/condition");
                validate_condition(rule.guard, rule_path + "/guard");
                validate_program(rule.program, rule_path + "/program");
            }
        }
    }

    void validate_scenes()
    {
        const auto scene_input_value_matches = [](SceneInputType type, bool nullable,
                                                  const RuntimeValue& value) {
            if (std::holds_alternative<std::monostate>(value))
                return nullable;
            switch (type) {
            case SceneInputType::Boolean:
                return std::holds_alternative<bool>(value);
            case SceneInputType::Integer:
                return std::holds_alternative<std::int64_t>(value);
            case SceneInputType::Number:
                return std::holds_alternative<std::int64_t>(value) ||
                       std::holds_alternative<double>(value);
            case SceneInputType::String:
                return std::holds_alternative<std::string>(value);
            }
            return false;
        };
        const auto validate_bindings = [&](SceneId target_id,
                                           const std::vector<SceneInputBinding>& bindings,
                                           const std::string& target_path) {
            require(m_scenes, target_id, "scene", target_path + "/scene");
            const auto target = m_scenes.find(target_id);
            if (target == m_scenes.end())
                return;
            const auto& target_scene = m_input.scenes[target->second];
            std::unordered_set<SceneInputId> supplied;
            for (std::size_t binding_index = 0; binding_index < bindings.size(); ++binding_index) {
                const auto& binding = bindings[binding_index];
                const auto binding_path = target_path + "/inputs/" + std::to_string(binding_index);
                if (!supplied.insert(binding.input_id).second)
                    error("compiled_project.duplicate_scene_input_binding",
                          "Scene input bindings must be unique.", binding_path + "/inputId");
                const auto declaration = std::ranges::find_if(
                    target_scene.inputs, [&](const SceneInputDefinition& input) {
                        return input.id == binding.input_id;
                    });
                if (declaration == target_scene.inputs.end()) {
                    error("compiled_project.unknown_scene_input",
                          "Scene input binding names an undeclared input.",
                          binding_path + "/inputId");
                } else if (!scene_input_value_matches(declaration->type, declaration->nullable,
                                                      binding.value)) {
                    error("compiled_project.scene_input_type_mismatch",
                          "Scene input value does not match its declaration.",
                          binding_path + "/value");
                }
            }
            for (const auto& input : target_scene.inputs) {
                if (!input.nullable && !input.default_value && !supplied.contains(input.id))
                    error("compiled_project.missing_scene_input",
                          "Scene invocation is missing a required input.", target_path + "/inputs");
            }
        };
        std::function<bool(SceneId, std::unordered_set<SceneId>&)> detached_scene_safe;
        detached_scene_safe = [&](SceneId scene_id, std::unordered_set<SceneId>& visiting) {
            const auto found = m_scenes.find(scene_id);
            if (found == m_scenes.end())
                return false;
            if (!visiting.insert(scene_id).second)
                return true;
            const auto& candidate = m_input.scenes[found->second];
            bool safe = true;
            for (const auto& instruction : candidate.program.instructions) {
                safe = safe &&
                       std::visit(
                           [&](const auto& value) {
                               using T = std::decay_t<decltype(value)>;
                               if constexpr (std::is_same_v<T, CallDialogueSceneInstruction> ||
                                             std::is_same_v<T, ChoiceSceneInstruction> ||
                                             std::is_same_v<T, WaitInputInstruction>)
                                   return false;
                               else if constexpr (std::is_same_v<T, ShowTextInstruction>)
                                   return !std::holds_alternative<InputWait>(value.wait);
                               else if constexpr (std::is_same_v<T, RunLuaSceneInstruction>)
                                   return !value.may_yield;
                               else if constexpr (std::is_same_v<T, CallSceneSceneInstruction> ||
                                                  std::is_same_v<T, StartDetachedSceneInstruction>)
                                   return detached_scene_safe(value.scene, visiting);
                               else if constexpr (std::is_same_v<T, SetBackgroundInstruction> ||
                                                  std::is_same_v<T, ActorCueInstruction> ||
                                                  std::is_same_v<T, SetLayoutInstruction> ||
                                                  std::is_same_v<T, MaterialParameterInstruction> ||
                                                  std::is_same_v<T, TransitionGroupInstruction>)
                                   return std::holds_alternative<ImmediateWait>(value.wait);
                               else if constexpr (std::is_same_v<T, AudioCueInstruction>)
                                   return std::holds_alternative<ImmediateWait>(value.wait);
                               else
                                   return true;
                           },
                           instruction);
                if (!safe)
                    break;
            }
            if (safe) {
                safe = std::visit(
                    [&](const auto& terminal) {
                        using T = std::decay_t<decltype(terminal)>;
                        if constexpr (std::is_same_v<T, ReturnSceneTerminal>)
                            return true;
                        else if constexpr (std::is_same_v<T, ContinueSceneTerminal>)
                            return detached_scene_safe(terminal.scene, visiting);
                        else
                            return false;
                    },
                    candidate.terminal);
            }
            visiting.erase(scene_id);
            return safe;
        };
        for (std::size_t scene_index = 0; scene_index < m_input.scenes.size(); ++scene_index) {
            const auto& scene = m_input.scenes[scene_index];
            const auto path = item("/definitions/scenes", scene_index);
            std::unordered_set<SceneInputId> input_ids;
            for (std::size_t input_index = 0; input_index < scene.inputs.size(); ++input_index) {
                const auto& input = scene.inputs[input_index];
                const auto input_path = path + "/inputs/" + std::to_string(input_index);
                if (!input_ids.insert(input.id).second)
                    error("compiled_project.duplicate_id", "Scene input IDs must be unique.",
                          input_path + "/id");
                if (input.default_value &&
                    !scene_input_value_matches(input.type, input.nullable, *input.default_value))
                    error("compiled_project.scene_input_type_mismatch",
                          "Scene input default does not match its declaration.",
                          input_path + "/defaultValue");
            }
            std::unordered_set<SceneOutcomeId> outcome_ids;
            for (std::size_t outcome_index = 0; outcome_index < scene.outcomes.size();
                 ++outcome_index) {
                if (!outcome_ids.insert(scene.outcomes[outcome_index].id).second)
                    error("compiled_project.duplicate_id", "Scene Outcome IDs must be unique.",
                          path + "/outcomes/" + std::to_string(outcome_index) + "/id");
            }
            std::visit(
                [&](const auto& stage) {
                    using Stage = std::decay_t<decltype(stage)>;
                    if constexpr (std::is_same_v<Stage, StagedRoomSceneStage>)
                        require(m_rooms, stage.room, "room", path + "/stage/room");
                    else if constexpr (std::is_same_v<Stage, BlankSceneStage>) {
                        validate_background(stage.background, path + "/stage/background");
                        if (stage.layout)
                            require(m_layouts, *stage.layout, "layout", path + "/stage/layout");
                    }
                },
                scene.stage);
            std::unordered_set<SceneStepId> steps;
            for (const auto& instruction : scene.program.instructions)
                std::visit([&](const auto& typed) { steps.insert(typed.id); }, instruction);
            std::unordered_set<SceneStepId> completed;
            for (std::size_t instruction_index = 0;
                 instruction_index < scene.program.instructions.size(); ++instruction_index) {
                const auto instruction_path =
                    path + "/program/events/" + std::to_string(instruction_index) + "/instruction";
                if (instruction_index < scene.program.events.size()) {
                    const auto& event = scene.program.events[instruction_index];
                    const auto event_path =
                        path + "/program/events/" + std::to_string(instruction_index);
                    for (std::size_t dependency_index = 0;
                         dependency_index < event.completion_dependencies.size();
                         ++dependency_index) {
                        if (!completed.contains(event.completion_dependencies[dependency_index]))
                            error("project.scene_completion_dependency_order",
                                  "Scene Event completion dependency must reference an earlier "
                                  "Event.",
                                  event_path + "/completionDependencies/" +
                                      std::to_string(dependency_index));
                    }
                    completed.insert(event.id);
                }
                std::visit(
                    [&](const auto& instruction) {
                        using T = std::decay_t<decltype(instruction)>;
                        if (instruction.condition)
                            validate_condition(*instruction.condition,
                                               instruction_path + "/condition");
                        if constexpr (std::is_same_v<T, SetBackgroundInstruction>)
                            validate_background(instruction.background,
                                                instruction_path + "/background");
                        else if constexpr (std::is_same_v<T, ActorCueInstruction>) {
                            require(m_characters, instruction.character, "character",
                                    instruction_path + "/character");
                            const auto found = m_characters.find(instruction.character);
                            if (found != m_characters.end()) {
                                const auto& character = m_input.characters[found->second];
                                const auto profile_id =
                                    instruction.profile_id.value_or(character.defaults.profile_id);
                                const auto profile = std::ranges::find_if(
                                    character.profiles, [&](const auto& candidate) {
                                        return candidate.id == profile_id;
                                    });
                                if (profile == character.profiles.end())
                                    error("compiled_project.unresolved_nested_reference",
                                          "Actor cue profile is absent from its Character.",
                                          instruction_path + "/profileId");
                                if (instruction.pose_id && profile != character.profiles.end() &&
                                    std::ranges::none_of(profile->poses,
                                                         [&](const CharacterPose& p) {
                                                             return p.id == *instruction.pose_id;
                                                         }))
                                    error("compiled_project.unresolved_nested_reference",
                                          "Actor cue pose is absent from its Character.",
                                          instruction_path + "/poseId");
                                if (instruction.expression_id &&
                                    std::ranges::none_of(
                                        character.expressions,
                                        [&](const CharacterExpression& expression) {
                                            return expression.id == *instruction.expression_id;
                                        }))
                                    error("compiled_project.unresolved_nested_reference",
                                          "Actor cue expression is absent from its Character.",
                                          instruction_path + "/expressionId");
                                if (instruction.appearance_id &&
                                    std::ranges::none_of(
                                        character.appearances,
                                        [&](const CharacterAppearance& appearance) {
                                            return appearance.id == *instruction.appearance_id;
                                        }))
                                    error("compiled_project.unresolved_nested_reference",
                                          "Actor cue appearance is absent from its Character.",
                                          instruction_path + "/appearanceId");
                            }
                        } else if constexpr (std::is_same_v<T, CallSceneSceneInstruction>) {
                            validate_bindings(instruction.scene, instruction.inputs,
                                              instruction_path);
                        } else if constexpr (std::is_same_v<T, StartDetachedSceneInstruction>) {
                            validate_bindings(instruction.scene, instruction.inputs,
                                              instruction_path);
                            if (instruction.owner == DetachedSceneOwner::ActiveRoom &&
                                std::holds_alternative<SceneId>(m_input.entrypoint) &&
                                std::get<SceneId>(m_input.entrypoint) == scene.identity.id)
                                error("compiled_project.detached_scene_owner_unavailable",
                                      "Active Room detached ownership requires a Current Room.",
                                      instruction_path + "/owner");
                            std::unordered_set<SceneId> visiting;
                            if (!detached_scene_safe(instruction.scene, visiting))
                                error("compiled_project.detached_scene_not_background_safe",
                                      "Detached Scene target must be background-safe and must not "
                                      "capture exclusive player input or await foreground-only "
                                      "presentation/audio completion.",
                                      instruction_path + "/scene");
                        } else if constexpr (std::is_same_v<T, CallDialogueSceneInstruction>) {
                            require(m_dialogues, instruction.dialogue, "dialogue",
                                    instruction_path + "/dialogue");
                            if (instruction.start_block_id) {
                                const auto* target = dialogue(instruction.dialogue);
                                if (target &&
                                    std::ranges::none_of(
                                        target->program.blocks, [&](const DialogueBlock& block) {
                                            return std::visit(
                                                [&](const auto& typed) {
                                                    return typed.id == *instruction.start_block_id;
                                                },
                                                block);
                                        }))
                                    error("compiled_project.unresolved_nested_reference",
                                          "Dialogue start block is missing.",
                                          instruction_path + "/startBlockId");
                            }
                        } else if constexpr (std::is_same_v<T, ShowTextInstruction>) {
                            if (instruction.speaker)
                                require(m_characters, *instruction.speaker, "character",
                                        instruction_path + "/speaker");
                            validate_text(instruction.text, instruction_path + "/text");
                        } else if constexpr (std::is_same_v<T, AudioCueInstruction>) {
                            const bool playing = instruction.action == AudioAction::Play ||
                                                 instruction.action == AudioAction::FadeIn;
                            if (playing != instruction.asset.has_value())
                                error("compiled_project.invalid_audio_cue",
                                      playing
                                          ? "Audio playback requires an audio Asset."
                                          : "Audio stop and fade-out must not include an Asset.",
                                      instruction_path + "/asset");
                            if (instruction.asset) {
                                require(m_assets, *instruction.asset, "asset",
                                        instruction_path + "/asset");
                                const auto* resource = asset(*instruction.asset);
                                if (resource && resource->kind != AssetKind::Audio)
                                    error("compiled_project.invalid_audio_cue",
                                          "Audio cue Asset must have kind Audio.",
                                          instruction_path + "/asset");
                            }
                            const bool desired = instruction.lifetime == AudioLifetime::DesiredLoop;
                            if (desired && !instruction.instance_id)
                                error("compiled_project.invalid_audio_cue",
                                      "Desired looping audio requires a stable instance ID.",
                                      instruction_path + "/instanceId");
                            if (desired && instruction.purpose != AudioPurpose::Music &&
                                instruction.purpose != AudioPurpose::Ambience)
                                error("compiled_project.invalid_audio_cue",
                                      "Desired looping audio is supported only for Music and "
                                      "Ambience.",
                                      instruction_path + "/purpose");
                            if (desired &&
                                std::holds_alternative<AudioCompletionWait>(instruction.wait))
                                error("compiled_project.invalid_audio_cue",
                                      "Desired looping audio cannot wait for decoder completion.",
                                      instruction_path + "/waitForCompletion");
                            if (desired && (instruction.causality != AudioCausality::Causal ||
                                            instruction.synchronized ||
                                            instruction.skip_behavior != AudioSkipBehavior::Stop))
                                error("compiled_project.invalid_audio_cue",
                                      "Desired looping audio must use reconstructible causal state "
                                      "semantics.",
                                      instruction_path + "/lifetime");
                            if (!desired && !playing)
                                error("compiled_project.invalid_audio_cue",
                                      "One-shot audio starts a new playback and cannot use "
                                      "stop/fade-out.",
                                      instruction_path + "/action");
                            if (!desired && instruction.instance_id)
                                error("compiled_project.invalid_audio_cue",
                                      "One-shot audio does not use a desired instance ID.",
                                      instruction_path + "/instanceId");
                            if (!desired && instruction.replacement_group)
                                error("compiled_project.invalid_audio_cue",
                                      "One-shot audio cannot declare a replacement group.",
                                      instruction_path + "/replacementGroup");
                            if (!desired &&
                                (std::holds_alternative<AudioCompletionWait>(instruction.wait) ||
                                 instruction.synchronized) &&
                                instruction.causality != AudioCausality::Causal)
                                error("compiled_project.invalid_audio_cue",
                                      "Awaited or synchronized one-shot audio must be causal.",
                                      instruction_path + "/causality");
                            if (instruction.purpose == AudioPurpose::UiSound &&
                                (desired || instruction.causality != AudioCausality::Disposable ||
                                 std::holds_alternative<AudioCompletionWait>(instruction.wait) ||
                                 instruction.synchronized ||
                                 instruction.pause_policy != AudioPausePolicy::Unscaled))
                                error("compiled_project.invalid_audio_cue",
                                      "UI Sound is disposable, unscaled, and cannot control "
                                      "gameplay.",
                                      instruction_path + "/purpose");
                            if (instruction.pan_source) {
                                std::visit(
                                    [&](const auto& source) {
                                        using S = std::decay_t<decltype(source)>;
                                        if constexpr (std::is_same_v<S, RoomAnchorAudioPanSource>) {
                                            require(m_rooms, source.room, "room",
                                                    instruction_path + "/panSource/room");
                                            const auto found = m_rooms.find(source.room);
                                            if (found != m_rooms.end()) {
                                                const auto& room = m_input.rooms[found->second];
                                                if (std::ranges::none_of(
                                                        room.anchors,
                                                        [&](const RoomAnchor& anchor) {
                                                            return anchor.id == source.anchor;
                                                        }))
                                                    error(
                                                        "compiled_project.unresolved_nested_"
                                                        "reference",
                                                        "Audio Pan Source Room Anchor is missing.",
                                                        instruction_path + "/panSource/anchorId");
                                            }
                                        }
                                    },
                                    *instruction.pan_source);
                            }
                        } else if constexpr (std::is_same_v<T, SetGlobalPropertySceneInstruction>) {
                            const auto* declaration = property(instruction.property);
                            if (!declaration)
                                require(m_properties, instruction.property, "property",
                                        instruction_path + "/property");
                            else if (!declaration->is_global())
                                error("compiled_project.property_scope_mismatch",
                                      "Scene assignment requires a Global Property.",
                                      instruction_path + "/property");
                            else if (!property_value_matches(*declaration, instruction.value))
                                error("compiled_project.property_type_mismatch",
                                      "Scene assignment does not match its Global Property.",
                                      instruction_path + "/value");
                        } else if constexpr (std::is_same_v<T, ConditionalBranchInstruction>) {
                            for (std::size_t branch = 0; branch < instruction.branches.size();
                                 ++branch) {
                                validate_condition(instruction.branches[branch].condition,
                                                   instruction_path + "/branches/" +
                                                       std::to_string(branch) + "/condition");
                                if (!steps.contains(
                                        instruction.branches[branch].target_instruction_id))
                                    error("compiled_project.unresolved_nested_reference",
                                          "Scene branch target is missing.",
                                          instruction_path + "/branches/" + std::to_string(branch) +
                                              "/targetInstructionId");
                            }
                            if (!steps.contains(instruction.fallback_instruction_id))
                                error("compiled_project.unresolved_nested_reference",
                                      "Scene fallback target is missing.",
                                      instruction_path + "/fallbackInstructionId");
                        } else if constexpr (std::is_same_v<T, ChoiceSceneInstruction>) {
                            for (std::size_t option = 0; option < instruction.options.size();
                                 ++option) {
                                const auto option_path =
                                    instruction_path + "/options/" + std::to_string(option);
                                if (instruction.options[option].condition)
                                    validate_condition(*instruction.options[option].condition,
                                                       option_path + "/condition");
                                for (std::size_t effect = 0;
                                     effect < instruction.options[option].effects.size(); ++effect)
                                    validate_effect(instruction.options[option].effects[effect],
                                                    option_path + "/effects/" +
                                                        std::to_string(effect));
                                validate_text(instruction.options[option].label,
                                              option_path + "/label");
                                if (!steps.contains(
                                        instruction.options[option].target_instruction_id))
                                    error("compiled_project.unresolved_nested_reference",
                                          "Scene choice target is missing.",
                                          option_path + "/targetInstructionId");
                            }
                            if (instruction.prompt)
                                validate_text(*instruction.prompt, instruction_path + "/prompt");
                        } else if constexpr (std::is_same_v<T, SetLayoutInstruction>) {
                            if (instruction.layout)
                                require(m_layouts, *instruction.layout, "layout",
                                        instruction_path + "/layout");
                        } else if constexpr (std::is_same_v<T, MaterialParameterInstruction>) {
                            const auto* material = material_interface(instruction.material);
                            if (!material) {
                                require(m_material_interfaces, instruction.material,
                                        "material interface", instruction_path + "/material");
                            } else {
                                const auto declaration = std::ranges::find_if(
                                    material->parameters, [&](const auto& parameter) {
                                        return parameter.name == instruction.parameter;
                                    });
                                if (declaration == material->parameters.end())
                                    error("compiled_project.material_parameter_unknown_uniform",
                                          "Material Parameter names an undeclared Shader uniform.",
                                          instruction_path + "/parameter");
                                else if (declaration->renderer_binding)
                                    error(
                                        "compiled_project.material_parameter_renderer_bound",
                                        "Renderer-bound uniforms cannot be occurrence-controlled.",
                                        instruction_path + "/parameter");
                                else if (!material_value_matches(declaration->type,
                                                                 instruction.value))
                                    error(
                                        "compiled_project.material_parameter_type_mismatch",
                                        "Material Parameter value does not match the uniform type.",
                                        instruction_path + "/value");
                                const auto role_valid = std::visit(
                                    [&](const auto& target) {
                                        using Target = std::decay_t<decltype(target)>;
                                        if constexpr (std::is_same_v<
                                                          Target, LayoutMaterialInstructionTarget>)
                                            return material->role == MaterialRole::RmlUiDecorator;
                                        else if constexpr (
                                            std::is_same_v<Target,
                                                           PostprocessMaterialInstructionTarget>)
                                            return material->role == MaterialRole::Postprocess;
                                        else
                                            return material->role == MaterialRole::Engine2D;
                                    },
                                    instruction.target);
                                if (!role_valid)
                                    error(
                                        "compiled_project.material_parameter_role_mismatch",
                                        "Material role is incompatible with the occurrence target.",
                                        instruction_path + "/material");
                            }
                            if (instruction.transition == MaterialParameterTransition::Tween &&
                                (std::holds_alternative<std::int64_t>(instruction.value) ||
                                 std::holds_alternative<bool>(instruction.value)))
                                error("compiled_project.material_parameter_not_interpolable",
                                      "Boolean and integer Material Parameters cannot be tweened.",
                                      instruction_path + "/transition");
                        } else if constexpr (std::is_same_v<T, PostprocessEffectInstruction>) {
                            if (instruction.action == PostprocessEffectAction::Upsert &&
                                instruction.material) {
                                const auto* material = material_interface(*instruction.material);
                                if (!material) {
                                    require(m_material_interfaces, *instruction.material,
                                            "material interface", instruction_path + "/material");
                                } else {
                                    if (material->role != MaterialRole::Postprocess)
                                        error("compiled_project.postprocess_role_mismatch",
                                              "Postprocess Effect requires a postprocess Material.",
                                              instruction_path + "/material");
                                    if (material->postprocess_scope != instruction.scope)
                                        error("compiled_project.postprocess_scope_mismatch",
                                              "Postprocess Effect scope must match its Material.",
                                              instruction_path + "/scope");
                                    for (std::size_t parameter_index = 0;
                                         parameter_index < instruction.parameters.size();
                                         ++parameter_index) {
                                        const auto& parameter =
                                            instruction.parameters[parameter_index];
                                        const auto parameter_path = instruction_path +
                                                                    "/parameters/" +
                                                                    std::to_string(parameter_index);
                                        const auto declaration = std::ranges::find_if(
                                            material->parameters, [&](const auto& candidate) {
                                                return candidate.name == parameter.name;
                                            });
                                        if (declaration == material->parameters.end())
                                            error("compiled_project.material_parameter_unknown_"
                                                  "uniform",
                                                  "Postprocess parameter names an undeclared "
                                                  "Shader uniform.",
                                                  parameter_path + "/name");
                                        else if (declaration->renderer_binding)
                                            error("compiled_project.material_parameter_renderer_"
                                                  "bound",
                                                  "Renderer-bound uniforms cannot be "
                                                  "occurrence-controlled.",
                                                  parameter_path + "/name");
                                        else if (!material_value_matches(declaration->type,
                                                                         parameter.value))
                                            error(
                                                "compiled_project.material_parameter_type_mismatch",
                                                "Postprocess parameter value does not match the "
                                                "uniform type.",
                                                parameter_path + "/value");
                                    }
                                }
                            }
                        } else if constexpr (std::is_same_v<T, TransitionGroupInstruction>) {
                            std::unordered_set<TransitionGroupChildId> child_ids;
                            for (std::size_t child_index = 0;
                                 child_index < instruction.children.size(); ++child_index) {
                                const auto child_path =
                                    instruction_path + "/children/" + std::to_string(child_index);
                                std::visit(
                                    [&](const auto& child) {
                                        if (!child_ids.insert(child.id).second)
                                            error("compiled_project.duplicate_id",
                                                  "TransitionGroup child IDs must be unique.",
                                                  child_path + "/id");
                                        using C = std::decay_t<decltype(child)>;
                                        if constexpr (std::is_same_v<
                                                          C,
                                                          TransitionGroupSetBackgroundMutation>) {
                                            validate_background(child.background,
                                                                child_path + "/background");
                                        } else if constexpr (std::is_same_v<
                                                                 C, TransitionGroupActorMutation>) {
                                            require(m_characters, child.character, "character",
                                                    child_path + "/character");
                                            const auto found = m_characters.find(child.character);
                                            if (found != m_characters.end()) {
                                                const auto& character =
                                                    m_input.characters[found->second];
                                                const auto profile_id = child.profile_id.value_or(
                                                    character.defaults.profile_id);
                                                const auto profile = std::ranges::find_if(
                                                    character.profiles, [&](const auto& candidate) {
                                                        return candidate.id == profile_id;
                                                    });
                                                if (profile == character.profiles.end())
                                                    error("compiled_project.unresolved_nested_"
                                                          "reference",
                                                          "TransitionGroup actor profile is absent "
                                                          "from its Character.",
                                                          child_path + "/profileId");
                                                if (child.pose_id &&
                                                    profile != character.profiles.end() &&
                                                    std::ranges::none_of(
                                                        profile->poses,
                                                        [&](const CharacterPose& pose) {
                                                            return pose.id == *child.pose_id;
                                                        }))
                                                    error(
                                                        "compiled_project.unresolved_nested_"
                                                        "reference",
                                                        "TransitionGroup actor pose is absent from "
                                                        "its Character.",
                                                        child_path + "/poseId");
                                                if (child.expression_id &&
                                                    std::ranges::none_of(
                                                        character.expressions,
                                                        [&](const CharacterExpression& expression) {
                                                            return expression.id ==
                                                                   *child.expression_id;
                                                        }))
                                                    error("compiled_project.unresolved_nested_"
                                                          "reference",
                                                          "TransitionGroup actor expression is "
                                                          "absent "
                                                          "from its Character.",
                                                          child_path + "/expressionId");
                                                if (child.appearance_id &&
                                                    std::ranges::none_of(
                                                        character.appearances,
                                                        [&](const CharacterAppearance& appearance) {
                                                            return appearance.id ==
                                                                   *child.appearance_id;
                                                        }))
                                                    error("compiled_project.unresolved_nested_"
                                                          "reference",
                                                          "TransitionGroup actor appearance is "
                                                          "absent from its Character.",
                                                          child_path + "/appearanceId");
                                            }
                                        } else if constexpr (std::is_same_v<
                                                                 C,
                                                                 TransitionGroupLayoutMutation>) {
                                            if (!child.layout)
                                                return;
                                            require(m_layouts, *child.layout, "layout",
                                                    child_path + "/layout");
                                            const auto found = m_layouts.find(*child.layout);
                                            if (found == m_layouts.end())
                                                return;
                                            const auto target =
                                                m_input.layouts[found->second].target;
                                            if (target != LayoutTarget::SceneOverlay &&
                                                target != LayoutTarget::RoomOverlay &&
                                                target != LayoutTarget::CustomOverlay)
                                                error(
                                                    "compiled_project.excluded_transition_plane",
                                                    "TransitionGroup Layout children must resolve "
                                                    "to WorldOverlay.",
                                                    child_path + "/layout");
                                        }
                                    },
                                    instruction.children[child_index]);
                            }
                        }
                    },
                    scene.program.instructions[instruction_index]);
            }
            std::visit(
                [&](const auto& terminal) {
                    using T = std::decay_t<decltype(terminal)>;
                    if constexpr (std::is_same_v<T, ReturnSceneTerminal>) {
                        if (terminal.outcome && !outcome_ids.contains(*terminal.outcome))
                            error("compiled_project.unknown_scene_outcome",
                                  "Scene Return names an undeclared Outcome.",
                                  path + "/terminal/outcome");
                    } else if constexpr (std::is_same_v<T, ContinueSceneTerminal>) {
                        validate_bindings(terminal.scene, terminal.inputs, path + "/terminal");
                    } else if constexpr (std::is_same_v<T, ContinueDialogueSceneTerminal>) {
                        require(m_dialogues, terminal.dialogue, "dialogue",
                                path + "/terminal/dialogue");
                    }
                },
                scene.terminal);
        }

        enum class Visit : std::uint8_t {
            Fresh,
            Visiting,
            Done
        };
        std::unordered_map<SceneId, Visit> visits;
        std::function<bool(SceneId)> visits_unconditional_cycle;
        visits_unconditional_cycle = [&](SceneId scene_id) {
            const auto state = visits[scene_id];
            if (state == Visit::Visiting)
                return true;
            if (state == Visit::Done)
                return false;
            visits[scene_id] = Visit::Visiting;
            const auto found = m_scenes.find(scene_id);
            if (found == m_scenes.end()) {
                visits[scene_id] = Visit::Done;
                return false;
            }
            const auto& scene = m_input.scenes[found->second];
            const bool has_dynamic_control = std::ranges::any_of(
                scene.program.instructions, [](const SceneInstruction& instruction) {
                    return std::holds_alternative<ConditionalBranchInstruction>(instruction) ||
                           std::holds_alternative<ChoiceSceneInstruction>(instruction);
                });
            if (!has_dynamic_control) {
                for (const auto& instruction : scene.program.instructions) {
                    const auto* call = std::get_if<CallSceneSceneInstruction>(&instruction);
                    if (call != nullptr && !call->condition &&
                        visits_unconditional_cycle(call->scene))
                        return true;
                }
            }
            if (const auto* continuation = std::get_if<ContinueSceneTerminal>(&scene.terminal);
                continuation != nullptr && visits_unconditional_cycle(continuation->scene))
                return true;
            visits[scene_id] = Visit::Done;
            return false;
        };
        for (std::size_t scene_index = 0; scene_index < m_input.scenes.size(); ++scene_index) {
            const auto& scene = m_input.scenes[scene_index];
            if (visits_unconditional_cycle(scene.identity.id)) {
                error("compiled_project.unconditional_scene_cycle",
                      "Scene participates in a statically unconditional Scene call/continue cycle.",
                      item("/definitions/scenes", scene_index) + "/terminal");
                break;
            }
        }
    }

    void validate_dialogues()
    {
        for (std::size_t dialogue_index = 0; dialogue_index < m_input.dialogues.size();
             ++dialogue_index) {
            const auto& value = m_input.dialogues[dialogue_index];
            const auto path = item("/definitions/dialogues", dialogue_index);
            const auto validate_character_presentation =
                [&](const CharacterId& character_id,
                    const CharacterPresentationProfileId& profile_id,
                    const CharacterPoseId& pose_id, const CharacterExpressionId& expression_id,
                    const std::optional<CharacterAppearanceId>& appearance_id,
                    const std::string& presentation_path) {
                    require(m_characters, character_id, "character",
                            presentation_path + "/character");
                    const auto character = m_characters.find(character_id);
                    if (character == m_characters.end())
                        return;
                    const auto& definition = m_input.characters[character->second];
                    const auto profile =
                        std::ranges::find_if(definition.profiles, [&](const auto& candidate) {
                            return candidate.id == profile_id;
                        });
                    if (profile == definition.profiles.end()) {
                        error("compiled_project.unresolved_nested_reference",
                              "Dialogue presentation Profile is absent from its Character.",
                              presentation_path + "/profileId");
                    } else if (std::ranges::none_of(profile->poses, [&](const auto& pose) {
                                   return pose.id == pose_id;
                               })) {
                        error("compiled_project.unresolved_nested_reference",
                              "Dialogue presentation Pose is absent from its Profile.",
                              presentation_path + "/poseId");
                    }
                    if (std::ranges::none_of(definition.expressions, [&](const auto& expression) {
                            return expression.id == expression_id;
                        }))
                        error("compiled_project.unresolved_nested_reference",
                              "Dialogue presentation Expression is absent from its Character.",
                              presentation_path + "/expressionId");
                    if (appearance_id &&
                        std::ranges::none_of(definition.appearances, [&](const auto& appearance) {
                            return appearance.id == *appearance_id;
                        }))
                        error("compiled_project.unresolved_nested_reference",
                              "Dialogue presentation Appearance is absent from its Character.",
                              presentation_path + "/appearanceId");
                };
            const auto validate_media = [&](const compiled::DialogueMediaContent& media,
                                            const std::string& media_path) {
                std::visit(
                    [&](const auto& content) {
                        using M = std::decay_t<decltype(content)>;
                        if constexpr (std::is_same_v<M, DialogueImageMedia>) {
                            require(m_assets, content.asset, "asset", media_path + "/asset");
                            const auto asset = m_assets.find(content.asset);
                            if (asset != m_assets.end() &&
                                m_input.assets[asset->second].kind != AssetKind::Image)
                                error("compiled_project.invalid_asset_kind",
                                      "Dialogue image Media Slot content must use an image Asset.",
                                      media_path + "/asset");
                        } else {
                            validate_character_presentation(content.character, content.profile_id,
                                                            content.pose_id, content.expression_id,
                                                            content.appearance_id, media_path);
                        }
                    },
                    media);
            };
            const auto dialogue_scene_input_matches = [](SceneInputType type, bool nullable,
                                                         const RuntimeValue& runtime_value) {
                if (std::holds_alternative<std::monostate>(runtime_value))
                    return nullable;
                switch (type) {
                case SceneInputType::Boolean:
                    return std::holds_alternative<bool>(runtime_value);
                case SceneInputType::Integer:
                    return std::holds_alternative<std::int64_t>(runtime_value);
                case SceneInputType::Number:
                    return std::holds_alternative<std::int64_t>(runtime_value) ||
                           std::holds_alternative<double>(runtime_value);
                case SceneInputType::String:
                    return std::holds_alternative<std::string>(runtime_value);
                }
                return false;
            };
            const auto validate_dialogue_scene_call = [&](const DialogueCallSceneSegment& call,
                                                          const std::string& call_path) {
                require(m_scenes, call.scene, "scene", call_path + "/scene");
                const auto found = m_scenes.find(call.scene);
                if (found == m_scenes.end())
                    return;
                const auto& target = m_input.scenes[found->second];
                std::unordered_set<SceneInputId> supplied;
                for (std::size_t input_index = 0; input_index < call.inputs.size(); ++input_index) {
                    const auto& binding = call.inputs[input_index];
                    const auto binding_path = call_path + "/inputs/" + std::to_string(input_index);
                    if (!supplied.insert(binding.input_id).second)
                        error("compiled_project.duplicate_scene_input_binding",
                              "Scene input bindings must be unique.", binding_path + "/inputId");
                    const auto declaration =
                        std::ranges::find_if(target.inputs, [&](const SceneInputDefinition& input) {
                            return input.id == binding.input_id;
                        });
                    if (declaration == target.inputs.end()) {
                        error("compiled_project.unknown_scene_input",
                              "Dialogue child Scene input names an undeclared input.",
                              binding_path + "/inputId");
                    } else if (!dialogue_scene_input_matches(
                                   declaration->type, declaration->nullable, binding.value)) {
                        error("compiled_project.scene_input_type_mismatch",
                              "Dialogue child Scene input value does not match its declaration.",
                              binding_path + "/value");
                    }
                }
                for (const auto& input : target.inputs)
                    if (!input.nullable && !input.default_value && !supplied.contains(input.id))
                        error("compiled_project.missing_scene_input",
                              "Dialogue child Scene invocation is missing a required input.",
                              call_path + "/inputs");
            };
            if (value.default_speaker)
                require(m_characters, *value.default_speaker, "character",
                        path + "/defaultSpeaker");
            std::unordered_set<DialogueStageSlotId> stage_slots;
            for (std::size_t slot_index = 0; slot_index < value.stage_slots.size(); ++slot_index) {
                const auto& slot = value.stage_slots[slot_index];
                const auto slot_path = path + "/stageSlots/" + std::to_string(slot_index);
                if (!stage_slots.insert(slot.id).second)
                    error("compiled_project.duplicate_nested_id",
                          "Duplicate Dialogue Stage Slot ID.", slot_path + "/id");
                if (slot.initial)
                    validate_character_presentation(
                        slot.initial->character, slot.initial->profile_id, slot.initial->pose_id,
                        slot.initial->expression_id, slot.initial->appearance_id,
                        slot_path + "/initial");
            }
            std::unordered_set<DialogueMediaSlotId> media_slots;
            for (std::size_t slot_index = 0; slot_index < value.media_slots.size(); ++slot_index) {
                const auto& slot = value.media_slots[slot_index];
                const auto slot_path = path + "/mediaSlots/" + std::to_string(slot_index);
                if (!media_slots.insert(slot.id).second)
                    error("compiled_project.duplicate_nested_id",
                          "Duplicate Dialogue Media Slot ID.", slot_path + "/id");
                if (slot.initial)
                    validate_media(*slot.initial, slot_path + "/initial");
            }
            std::unordered_map<DialogueBlockId, std::size_t> blocks;
            for (std::size_t index = 0; index < value.program.blocks.size(); ++index)
                std::visit([&](const auto& block) { blocks.emplace(block.id, index); },
                           value.program.blocks[index]);
            if (!blocks.contains(value.program.entry_block_id))
                error("compiled_project.unresolved_nested_reference",
                      "Dialogue entry block is missing.", path + "/program/entryBlockId");
            std::unordered_set<DialogueCueId> cue_ids;
            for (std::size_t block_index = 0; block_index < value.program.blocks.size();
                 ++block_index) {
                const auto block_path = path + "/program/blocks/" + std::to_string(block_index);
                std::visit(
                    [&](const auto& block) {
                        using T = std::decay_t<decltype(block)>;
                        if constexpr (std::is_same_v<T, DialogueSequenceBlock>) {
                            if (block.default_speaker)
                                require(m_characters, *block.default_speaker, "character",
                                        block_path + "/defaultSpeaker");
                            for (std::size_t segment = 0; segment < block.segments.size();
                                 ++segment)
                                std::visit(
                                    [&](const auto& typed) {
                                        const auto segment_path =
                                            block_path + "/segments/" + std::to_string(segment);
                                        if (typed.condition)
                                            validate_condition(*typed.condition,
                                                               segment_path + "/condition");
                                        using S = std::decay_t<decltype(typed)>;
                                        if constexpr (std::is_same_v<S, DialogueLineSegment>) {
                                            if (typed.speaker)
                                                require(m_characters, *typed.speaker, "character",
                                                        segment_path + "/speaker");
                                            validate_text(typed.text, segment_path + "/text");
                                            std::optional<DialogueCuePosition> previous_position;
                                            for (std::size_t cue_index = 0;
                                                 cue_index < typed.cues.size(); ++cue_index) {
                                                const auto cue_path = segment_path + "/cues/" +
                                                                      std::to_string(cue_index);
                                                std::visit(
                                                    [&](const auto& cue) {
                                                        if (!cue_ids.insert(cue.id).second)
                                                            error("compiled_project.duplicate_"
                                                                  "nested_id",
                                                                  "Duplicate Dialogue cue ID.",
                                                                  cue_path + "/id");
                                                        if (previous_position &&
                                                            cue.position == *previous_position)
                                                            error("compiled_project.duplicate_"
                                                                  "dialogue_cue_position",
                                                                  "Dialogue cue offset/order must "
                                                                  "be unique within a line.",
                                                                  cue_path + "/position");
                                                        else if (previous_position &&
                                                                 cue.position < *previous_position)
                                                            error("compiled_project.invalid_"
                                                                  "dialogue_cue_order",
                                                                  "Dialogue cues must be ordered "
                                                                  "by offset and order.",
                                                                  cue_path + "/position");
                                                        previous_position = cue.position;
                                                        using C = std::decay_t<decltype(cue)>;
                                                        if constexpr (std::is_same_v<
                                                                          C, DialogueStageCue>) {
                                                            const auto& mutation = cue.mutation;
                                                            if (!stage_slots.contains(
                                                                    mutation.slot_id))
                                                                error(
                                                                    "compiled_project.unresolved_"
                                                                    "nested_reference",
                                                                    "Dialogue Stage cue references "
                                                                    "a missing Slot.",
                                                                    cue_path + "/mutation/slotId");
                                                            if (mutation.character)
                                                                require(m_characters,
                                                                        *mutation.character,
                                                                        "character",
                                                                        cue_path +
                                                                            "/mutation/character");
                                                            if (mutation.scale &&
                                                                *mutation.scale <= 0.0)
                                                                error(
                                                                    "compiled_project.invalid_"
                                                                    "dialogue_presentation",
                                                                    "Dialogue Stage scale must be "
                                                                    "positive.",
                                                                    cue_path + "/mutation/scale");
                                                        } else if constexpr (
                                                            std::is_same_v<C, DialogueMediaCue>) {
                                                            const auto& mutation = cue.mutation;
                                                            if (!media_slots.contains(
                                                                    mutation.slot_id))
                                                                error(
                                                                    "compiled_project.unresolved_"
                                                                    "nested_reference",
                                                                    "Dialogue Media cue references "
                                                                    "a missing Slot.",
                                                                    cue_path + "/mutation/slotId");
                                                            if (mutation.content)
                                                                validate_media(
                                                                    *mutation.content,
                                                                    cue_path + "/mutation/content");
                                                        } else if constexpr (
                                                            std::is_same_v<C, DialogueGestureCue>) {
                                                            if (!stage_slots.contains(cue.slot_id))
                                                                error("compiled_project.unresolved_"
                                                                      "nested_reference",
                                                                      "Dialogue Gesture cue "
                                                                      "references "
                                                                      "a missing Stage Slot.",
                                                                      cue_path + "/slotId");
                                                        } else if constexpr (
                                                            std::is_same_v<C, DialogueVoiceCue> ||
                                                            std::is_same_v<
                                                                C, DialogueSoundEffectCue>) {
                                                            require(m_assets, cue.asset, "asset",
                                                                    cue_path + "/asset");
                                                            const auto asset =
                                                                m_assets.find(cue.asset);
                                                            if (asset != m_assets.end() &&
                                                                m_input.assets[asset->second]
                                                                        .kind != AssetKind::Audio)
                                                                error("compiled_project.invalid_"
                                                                      "asset_kind",
                                                                      "Dialogue audio cues require "
                                                                      "an audio Asset.",
                                                                      cue_path + "/asset");
                                                            if (!std::isfinite(cue.gain) ||
                                                                cue.gain < 0.0 || cue.gain > 1.0 ||
                                                                !std::isfinite(cue.pan) ||
                                                                cue.pan < -1.0 || cue.pan > 1.0)
                                                                error(
                                                                    "compiled_project.invalid_"
                                                                    "dialogue_audio",
                                                                    "Dialogue audio cue mix values "
                                                                    "are invalid.",
                                                                    cue_path);
                                                            if constexpr (
                                                                std::is_same_v<
                                                                    C, DialogueSoundEffectCue>) {
                                                                if ((cue.wait_for_completion ||
                                                                     cue.synchronized ||
                                                                     cue.skip_behavior ==
                                                                         AudioSkipBehavior::Play) &&
                                                                    cue.causality !=
                                                                        AudioCausality::Causal)
                                                                    error(
                                                                        "compiled_project.invalid_"
                                                                        "audio_causality",
                                                                        "Awaited, synchronized, "
                                                                        "and "
                                                                        "play-on-skip Dialogue SFX "
                                                                        "must "
                                                                        "be causal.",
                                                                        cue_path + "/causality");
                                                            }
                                                        } else if constexpr (
                                                            std::is_same_v<C, DialogueCameraCue>) {
                                                            std::visit(
                                                                [&](const auto& emphasis) {
                                                                    if (emphasis.duration_ms == 0)
                                                                        error("compiled_project."
                                                                              "invalid_"
                                                                              "dialogue_camera",
                                                                              "Dialogue camera "
                                                                              "emphasis "
                                                                              "duration must be "
                                                                              "positive.",
                                                                              cue_path +
                                                                                  "/emphasis/"
                                                                                  "durationMs");
                                                                    using E = std::decay_t<
                                                                        decltype(emphasis)>;
                                                                    if constexpr (
                                                                        std::is_same_v<
                                                                            E,
                                                                            DialogueCameraShakeEmphasis>) {
                                                                        if (!std::isfinite(
                                                                                emphasis
                                                                                    .frequency_hz) ||
                                                                            emphasis.frequency_hz <=
                                                                                0.0)
                                                                            error(
                                                                                "compiled_project."
                                                                                "invalid_"
                                                                                "dialogue_camera",
                                                                                "Dialogue camera "
                                                                                "shake "
                                                                                "frequency must be "
                                                                                "positive.",
                                                                                cue_path +
                                                                                    "/emphasis/"
                                                                                    "frequencyHz");
                                                                    } else if constexpr (
                                                                        std::is_same_v<
                                                                            E,
                                                                            DialogueCameraFlashEmphasis>) {
                                                                        if (!std::isfinite(
                                                                                emphasis.opacity) ||
                                                                            emphasis.opacity <
                                                                                0.0 ||
                                                                            emphasis.opacity >
                                                                                1.0 ||
                                                                            emphasis.color.empty())
                                                                            error(
                                                                                "compiled_project."
                                                                                "invalid_"
                                                                                "dialogue_camera",
                                                                                "Dialogue camera "
                                                                                "flash "
                                                                                "requires a color "
                                                                                "and "
                                                                                "opacity in [0,1].",
                                                                                cue_path +
                                                                                    "/emphasis");
                                                                    }
                                                                },
                                                                cue.emphasis);
                                                        }
                                                    },
                                                    typed.cues[cue_index]);
                                            }
                                            for (std::size_t effect = 0;
                                                 effect < typed.effects.size(); ++effect)
                                                validate_effect(typed.effects[effect],
                                                                segment_path + "/effects/" +
                                                                    std::to_string(effect));
                                        } else if constexpr (std::is_same_v<
                                                                 S, DialogueCallSceneSegment>) {
                                            validate_dialogue_scene_call(typed, segment_path);
                                        }
                                    },
                                    block.segments[segment]);
                        } else if constexpr (std::is_same_v<T, DialogueRedirectBlock>) {
                            if (!blocks.contains(block.target_block_id))
                                error("compiled_project.unresolved_nested_reference",
                                      "Dialogue redirect target is missing.",
                                      block_path + "/targetBlockId");
                        }
                    },
                    value.program.blocks[block_index]);
            }
            for (const auto& candidate : value.program.blocks) {
                const auto* redirect = std::get_if<DialogueRedirectBlock>(&candidate);
                if (!redirect)
                    continue;
                std::unordered_set<DialogueBlockId> visited;
                const DialogueRedirectBlock* current = redirect;
                while (current) {
                    if (!visited.insert(current->id).second) {
                        error("compiled_project.invalid_dialogue_graph",
                              "Dialogue contains a redirect-only cycle.", path + "/program/blocks");
                        break;
                    }
                    const auto target = blocks.find(current->target_block_id);
                    current = target == blocks.end() ? nullptr
                                                     : std::get_if<DialogueRedirectBlock>(
                                                           &value.program.blocks[target->second]);
                }
            }
            std::unordered_map<DialogueBlockId, std::size_t> next_counts;
            for (std::size_t edge_index = 0; edge_index < value.program.edges.size();
                 ++edge_index) {
                const auto edge_path = path + "/program/edges/" + std::to_string(edge_index);
                std::visit(
                    [&](const auto& edge) {
                        if (!blocks.contains(edge.from_block_id))
                            error("compiled_project.unresolved_nested_reference",
                                  "Dialogue edge source is missing.", edge_path + "/fromBlockId");
                        if (!blocks.contains(edge.to_block_id))
                            error("compiled_project.unresolved_nested_reference",
                                  "Dialogue edge target is missing.", edge_path + "/toBlockId");
                        using T = std::decay_t<decltype(edge)>;
                        if constexpr (std::is_same_v<T, DialogueNextEdge>) {
                            ++next_counts[edge.from_block_id];
                            const auto source = blocks.find(edge.from_block_id);
                            if (source != blocks.end() &&
                                !std::holds_alternative<DialogueSequenceBlock>(
                                    value.program.blocks[source->second]))
                                error("compiled_project.invalid_dialogue_graph",
                                      "Next edges must originate from Sequence blocks.", edge_path);
                        } else {
                            const auto source = blocks.find(edge.from_block_id);
                            if (source != blocks.end() &&
                                !std::holds_alternative<DialogueChoiceBlock>(
                                    value.program.blocks[source->second]))
                                error("compiled_project.invalid_dialogue_graph",
                                      "Choice edges must originate from Choice blocks.", edge_path);
                            if (edge.condition)
                                validate_condition(*edge.condition, edge_path + "/condition");
                            for (std::size_t effect = 0; effect < edge.effects.size(); ++effect)
                                validate_effect(edge.effects[effect],
                                                edge_path + "/effects/" + std::to_string(effect));
                            validate_text(edge.label, edge_path + "/label");
                        }
                    },
                    value.program.edges[edge_index]);
            }
            for (const auto& [block, count] : next_counts)
                if (count > 1)
                    error("compiled_project.invalid_dialogue_graph",
                          "A Sequence block may have at most one Next edge.",
                          path + "/program/blocks/" + block.text());
            validate_flow_target(value.completion, path + "/completion");
        }
    }

    void validate_maps()
    {
        for (std::size_t map_index = 0; map_index < m_input.maps.size(); ++map_index) {
            const auto& value = m_input.maps[map_index];
            const auto path = item("/definitions/maps", map_index);
            std::unordered_map<MapLocationId, const MapLocation*> locations;
            std::unordered_map<RoomId, const MapLocation*> locations_by_room;
            for (std::size_t location_index = 0; location_index < value.locations.size();
                 ++location_index) {
                const auto& location = value.locations[location_index];
                const auto location_path = path + "/locations/" + std::to_string(location_index);
                locations.emplace(location.id, &location);
                require(m_rooms, location.room, "room", location_path + "/room");
                if (!locations_by_room.emplace(location.room, &location).second)
                    error("compiled_project.duplicate_map_room",
                          "A Room may have only one Map Location in a Map.",
                          location_path + "/room");
                if (location.label)
                    validate_text(*location.label, location_path + "/label");
                if (location.icon)
                    require(m_assets, *location.icon, "asset", location_path + "/icon");
                validate_condition(location.visibility, location_path + "/visibility");
            }
            for (std::size_t connection_index = 0; connection_index < value.connections.size();
                 ++connection_index) {
                const auto& connection = value.connections[connection_index];
                const auto connection_path =
                    path + "/connections/" + std::to_string(connection_index);
                const auto source = locations.find(connection.source_location_id);
                const auto target = locations.find(connection.target_location_id);
                if (source == locations.end())
                    error("compiled_project.unresolved_nested_reference",
                          "Map source location is missing.", connection_path + "/sourceLocationId");
                if (target == locations.end())
                    error("compiled_project.unresolved_nested_reference",
                          "Map target location is missing.", connection_path + "/targetLocationId");
                if (connection.exits.empty() || connection.exits.size() > 2) {
                    error("compiled_project.invalid_map_connection",
                          "Map Connection must reference one directed Exit or one reciprocal pair.",
                          connection_path + "/exits");
                    continue;
                }
                std::vector<const RoomExit*> linked_exits;
                linked_exits.reserve(connection.exits.size());
                for (std::size_t exit_index = 0; exit_index < connection.exits.size();
                     ++exit_index) {
                    const auto& reference = connection.exits[exit_index];
                    const auto exit_path = connection_path + "/exits/" + std::to_string(exit_index);
                    require(m_rooms, reference.room, "room", exit_path + "/room");
                    const auto* linked_exit = exit(reference);
                    if (!linked_exit)
                        error("compiled_project.unresolved_nested_reference",
                              "Map Connection Exit is missing from its Room.",
                              exit_path + "/exitId");
                    linked_exits.push_back(linked_exit);
                }
                if (!linked_exits.empty() && linked_exits.front() != nullptr) {
                    if (source != locations.end() &&
                        source->second->room != connection.exits.front().room)
                        error("compiled_project.inconsistent_map_topology",
                              "Map Connection source must be derived from its first Exit Room.",
                              connection_path + "/sourceLocationId");
                    if (target != locations.end() &&
                        target->second->room != linked_exits.front()->target)
                        error("compiled_project.inconsistent_map_topology",
                              "Map Connection target must be derived from its first Exit target "
                              "Room.",
                              connection_path + "/targetLocationId");
                }
                if (connection.exits.size() == 2 && linked_exits.size() == 2 &&
                    linked_exits[0] != nullptr && linked_exits[1] != nullptr &&
                    (connection.exits[1].room != linked_exits[0]->target ||
                     connection.exits[0].room != linked_exits[1]->target ||
                     connection.exits[0].room == connection.exits[1].room))
                    error("compiled_project.invalid_map_connection",
                          "Two-Exit Map Connections must be an explicit reciprocal pair.",
                          connection_path + "/exits");
                if (connection.label)
                    validate_text(*connection.label, connection_path + "/label");
                if (connection.icon)
                    require(m_assets, *connection.icon, "asset", connection_path + "/icon");
                validate_condition(connection.visibility, connection_path + "/visibility");
            }
            if (value.presentation.background)
                require(m_assets, *value.presentation.background, "asset",
                        path + "/presentation/background");
            if (value.presentation.layout)
                require(m_layouts, *value.presentation.layout, "layout",
                        path + "/presentation/layout");
            if (value.presentation.title)
                validate_text(*value.presentation.title, path + "/presentation/title");
        }
    }

    void validate_direct_entrypoint()
    {
        std::visit(
            [&](const auto& entrypoint) {
                using T = std::decay_t<decltype(entrypoint)>;
                if constexpr (std::is_same_v<T, SceneId>) {
                    const auto found = m_scenes.find(entrypoint);
                    if (found != m_scenes.end()) {
                        const auto& scene = m_input.scenes[found->second];
                        const auto& terminal = scene.terminal;
                        for (const auto& input : scene.inputs) {
                            if (!input.nullable && !input.default_value)
                                error("compiled_project.invalid_entrypoint_scene_input",
                                      "A direct Scene entrypoint input must be nullable or declare "
                                      "a default value.",
                                      "/entrypoint");
                        }
                        if (std::holds_alternative<ReturnSceneTerminal>(terminal))
                            error("compiled_project.invalid_entrypoint_terminal",
                                  "A direct Scene entrypoint cannot Return.", "/entrypoint");
                        if (std::holds_alternative<ReleaseToExplorationSceneTerminal>(terminal))
                            error("compiled_project.invalid_entrypoint_terminal",
                                  "A direct Scene entrypoint cannot Release to Exploration before "
                                  "a Current Room exists.",
                                  "/entrypoint");
                    }
                } else if constexpr (std::is_same_v<T, DialogueId>) {
                    const auto found = m_dialogues.find(entrypoint);
                    if (found != m_dialogues.end() &&
                        std::holds_alternative<ReturnFlow>(
                            m_input.dialogues[found->second].completion))
                        error("compiled_project.invalid_entrypoint_continuation",
                              "A direct Dialogue entrypoint cannot return.", "/entrypoint");
                }
            },
            m_input.entrypoint);
    }

    const CompiledProjectInput& m_input;
    Diagnostics m_diagnostics;
    std::unordered_set<std::string> m_default_localization_keys;
#define MAP(member, id_type) std::unordered_map<id_type, std::size_t> m_##member
    MAP(properties, PropertyId);
    MAP(traits, TraitId);
    MAP(assets, AssetId);
    MAP(layouts, LayoutId);
    MAP(material_interfaces, MaterialId);
    MAP(scripts, ScriptId);
    MAP(characters, CharacterId);
    MAP(rooms, RoomId);
    MAP(interactables, InteractableId);
    MAP(item_definitions, ItemDefinitionId);
    MAP(item_stacks, ItemStackId);
    MAP(verbs, VerbId);
    MAP(interactions, InteractionId);
    MAP(scenes, SceneId);
    MAP(dialogues, DialogueId);
    MAP(maps, MapId);
#undef MAP
};

} // namespace

Diagnostics validate_semantics(const CompiledProjectInput& input) { return Validator(input).run(); }

} // namespace noveltea::core::compiled::detail
