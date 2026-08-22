#include "compiled_project_validation.hpp"

#include <algorithm>
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
        for (std::size_t index = 0; index < m_input.settings.system_layouts.size(); ++index)
            if (m_input.settings.system_layouts[index].layout)
                require(m_layouts, *m_input.settings.system_layouts[index].layout, "layout",
                        "/settings/systemLayouts/" + std::to_string(index) + "/layout");
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
            std::unordered_set<CharacterPoseId> poses;
            std::unordered_set<CharacterExpressionId> expressions;
            std::unordered_set<CharacterIdleId> idles;
            for (const auto& pose : character.poses) {
                poses.insert(pose.id);
                if (pose.sprite)
                    require(m_assets, *pose.sprite, "asset", path + "/poses/sprite");
            }
            for (const auto& expression : character.expressions) {
                expressions.insert(expression.id);
                if (expression.pose_id && !poses.contains(*expression.pose_id))
                    error("compiled_project.unresolved_nested_reference",
                          "Character expression references a missing pose.",
                          path + "/expressions/poseId");
                if (expression.sprite)
                    require(m_assets, *expression.sprite, "asset", path + "/expressions/sprite");
            }
            for (const auto& idle : character.idles)
                idles.insert(idle.id);
            if (!poses.contains(character.defaults.pose_id))
                error("compiled_project.unresolved_nested_reference", "Default pose is missing.",
                      path + "/defaults/poseId");
            if (!expressions.contains(character.defaults.expression_id))
                error("compiled_project.unresolved_nested_reference",
                      "Default expression is missing.", path + "/defaults/expressionId");
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
                    const CharacterExpression* expression = nullptr;
                    if (entry.pose_id &&
                        std::ranges::none_of(definition.poses, [&](const auto& pose) {
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
                        else
                            expression = &*found;
                    }
                    if (entry.pose_id && expression && expression->pose_id &&
                        *entry.pose_id != *expression->pose_id)
                        error("compiled_project.incompatible_character_presentation",
                              "Room cast pose and expression are incompatible.", cast_path);
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
            validate_condition(value.availability, path + "/availability");
            validate_program(value.default_program, path + "/defaultProgram");
        }
        for (std::size_t index = 0; index < m_input.interactions.size(); ++index) {
            const auto& value = m_input.interactions[index];
            const auto path = item("/definitions/interactions", index);
            for (std::size_t rule_index = 0; rule_index < value.rules.size(); ++rule_index) {
                const auto& rule = value.rules[rule_index];
                const auto rule_path = path + "/rules/" + std::to_string(rule_index);
                require(m_verbs, rule.verb, "verb", rule_path + "/verb");
                const auto verb = m_verbs.find(rule.verb);
                if (verb != m_verbs.end() &&
                    rule.operands.size() != m_input.verbs[verb->second].arity)
                    error("compiled_project.interaction_arity_mismatch",
                          "Interaction operand count does not match its Verb arity.",
                          rule_path + "/operands");
                std::visit(
                    [&](const auto& context) {
                        using T = std::decay_t<decltype(context)>;
                        if constexpr (std::is_same_v<T, ActiveRoomInteractionContext>)
                            require(m_rooms, context.room, "room", rule_path + "/context/room");
                        else if constexpr (std::is_same_v<T, PlacementInteractionContext>) {
                            require(m_rooms, context.placement.room, "room",
                                    rule_path + "/context/placement/room");
                            if (!placement(context.placement))
                                error("compiled_project.unresolved_nested_reference",
                                      "Interaction context references a missing Room placement.",
                                      rule_path + "/context/placement/placementId");
                        } else if constexpr (std::is_same_v<T, PredicateInteractionContext>)
                            validate_condition(context.condition, rule_path + "/context/condition");
                    },
                    rule.context);
                for (std::size_t operand = 0; operand < rule.operands.size(); ++operand) {
                    const auto* exact = std::get_if<ExactOperand>(&rule.operands[operand]);
                    if (!exact)
                        continue;
                    const auto operand_path = rule_path + "/operands/" + std::to_string(operand);
                    validate_interaction_subject(exact->subject, operand_path + "/subject");
                }
                validate_program(rule.program, rule_path + "/program");
            }
        }
    }

    void validate_scenes()
    {
        for (std::size_t scene_index = 0; scene_index < m_input.scenes.size(); ++scene_index) {
            const auto& scene = m_input.scenes[scene_index];
            const auto path = item("/definitions/scenes", scene_index);
            validate_background(scene.default_background, path + "/defaultBackground");
            if (scene.default_layout)
                require(m_layouts, *scene.default_layout, "layout", path + "/defaultLayout");
            std::unordered_set<SceneStepId> steps;
            for (const auto& instruction : scene.program.instructions)
                std::visit([&](const auto& typed) { steps.insert(typed.id); }, instruction);
            for (std::size_t instruction_index = 0;
                 instruction_index < scene.program.instructions.size(); ++instruction_index) {
                const auto instruction_path =
                    path + "/program/instructions/" + std::to_string(instruction_index);
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
                                if (instruction.pose_id &&
                                    std::ranges::none_of(character.poses,
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
                            }
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
                            if (instruction.loop &&
                                (!playing || (instruction.channel != AudioChannel::Music &&
                                              instruction.channel != AudioChannel::Ambient)))
                                error("compiled_project.invalid_audio_cue",
                                      "Only playing Music or Ambient cues may declare a persistent "
                                      "loop.",
                                      instruction_path + "/loop");
                            if (instruction.loop &&
                                std::holds_alternative<AudioCompletionWait>(instruction.wait))
                                error(
                                    "compiled_project.invalid_audio_cue",
                                    "Persistent desired audio cannot wait for playback completion.",
                                    instruction_path + "/waitForCompletion");
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
                                                if (child.pose_id &&
                                                    std::ranges::none_of(
                                                        character.poses,
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
            validate_flow_target(scene.continuation, path + "/continuation");
        }
    }

    void validate_dialogues()
    {
        for (std::size_t dialogue_index = 0; dialogue_index < m_input.dialogues.size();
             ++dialogue_index) {
            const auto& value = m_input.dialogues[dialogue_index];
            const auto path = item("/definitions/dialogues", dialogue_index);
            if (value.default_speaker)
                require(m_characters, *value.default_speaker, "character",
                        path + "/defaultSpeaker");
            std::unordered_map<DialogueBlockId, std::size_t> blocks;
            for (std::size_t index = 0; index < value.program.blocks.size(); ++index)
                std::visit([&](const auto& block) { blocks.emplace(block.id, index); },
                           value.program.blocks[index]);
            if (!blocks.contains(value.program.entry_block_id))
                error("compiled_project.unresolved_nested_reference",
                      "Dialogue entry block is missing.", path + "/program/entryBlockId");
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
                                            for (std::size_t effect = 0;
                                                 effect < typed.effects.size(); ++effect)
                                                validate_effect(typed.effects[effect],
                                                                segment_path + "/effects/" +
                                                                    std::to_string(effect));
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
            for (std::size_t location_index = 0; location_index < value.locations.size();
                 ++location_index) {
                const auto& location = value.locations[location_index];
                locations.emplace(location.id, &location);
                require(m_rooms, location.room, "room",
                        path + "/locations/" + std::to_string(location_index) + "/room");
                if (location.label)
                    validate_text(*location.label,
                                  path + "/locations/" + std::to_string(location_index) + "/label");
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
                require(m_rooms, connection.exit.room, "room", connection_path + "/exit/room");
                const auto* linked_exit = exit(connection.exit);
                if (!linked_exit)
                    error("compiled_project.unresolved_nested_reference",
                          "Map connection exit is missing from its Room.",
                          connection_path + "/exit/exitId");
                if (source != locations.end() && source->second->room != connection.exit.room)
                    error("compiled_project.inconsistent_map_topology",
                          "Map connection source Room does not own its exit.", connection_path);
                if (linked_exit && target != locations.end() &&
                    target->second->room != linked_exit->target)
                    error("compiled_project.inconsistent_map_topology",
                          "Map connection target does not match the Room exit target.",
                          connection_path);
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
                    if (found != m_scenes.end() && std::holds_alternative<ReturnFlow>(
                                                       m_input.scenes[found->second].continuation))
                        error("compiled_project.invalid_entrypoint_continuation",
                              "A direct Scene entrypoint cannot return.", "/entrypoint");
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
