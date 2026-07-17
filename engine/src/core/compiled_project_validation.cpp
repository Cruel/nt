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
        INDEX(variables, input.variables[index].id);
        INDEX(properties, input.properties[index].id());
        INDEX(assets, input.assets[index].id);
        INDEX(layouts, input.layouts[index].id);
        INDEX(scripts, input.scripts[index].id);
        INDEX(characters, input.characters[index].identity.id);
        INDEX(rooms, input.rooms[index].identity.id);
        INDEX(interactables, input.interactables[index].identity.id);
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

    const VariableDefinition* variable(const VariableId& id) const
    {
        const auto found = m_variables.find(id);
        return found == m_variables.end() ? nullptr : &m_input.variables[found->second];
    }

    const RoomDefinition* room(const RoomId& id) const
    {
        const auto found = m_rooms.find(id);
        return found == m_rooms.end() ? nullptr : &m_input.rooms[found->second];
    }

    const DialogueDefinition* dialogue(const DialogueId& id) const
    {
        const auto found = m_dialogues.find(id);
        return found == m_dialogues.end() ? nullptr : &m_input.dialogues[found->second];
    }

    static bool value_matches(const PropertyValueType& type, const RuntimeValue& value)
    {
        if (!runtime_value_is_finite(value) || std::holds_alternative<std::monostate>(value))
            return false;
        return std::visit(
            [&value](const auto& typed) {
                using T = std::decay_t<decltype(typed)>;
                if constexpr (std::is_same_v<T, BooleanPropertyType>)
                    return std::holds_alternative<bool>(value);
                else if constexpr (std::is_same_v<T, IntegerPropertyType>)
                    return std::holds_alternative<std::int64_t>(value);
                else if constexpr (std::is_same_v<T, NumberPropertyType>)
                    return std::holds_alternative<std::int64_t>(value) ||
                           std::holds_alternative<double>(value);
                else if constexpr (std::is_same_v<T, StringPropertyType>)
                    return std::holds_alternative<std::string>(value);
                else {
                    const auto* text = std::get_if<std::string>(&value);
                    return text != nullptr && std::find(typed.values.begin(), typed.values.end(),
                                                        *text) != typed.values.end();
                }
            },
            type);
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
        const auto* comparison = std::get_if<VariableComparison>(&condition);
        if (!comparison)
            return;
        std::visit(
            [&](const auto& typed) {
                const auto* declaration = variable(typed.variable_id);
                if (!declaration) {
                    require(m_variables, typed.variable_id, "variable", path + "/variable");
                    return;
                }
                using T = std::decay_t<decltype(typed)>;
                if constexpr (std::is_same_v<T, VariableValueComparison>) {
                    if (!value_matches(declaration->value_type, typed.value))
                        error("compiled_project.variable_type_mismatch",
                              "Comparison value does not match variable '" +
                                  typed.variable_id.text() + "'.",
                              path + "/value");
                    const bool ordered = typed.operation != ValueComparisonOperator::Equal &&
                                         typed.operation != ValueComparisonOperator::NotEqual;
                    const bool orderable =
                        std::holds_alternative<IntegerPropertyType>(declaration->value_type) ||
                        std::holds_alternative<NumberPropertyType>(declaration->value_type) ||
                        std::holds_alternative<StringPropertyType>(declaration->value_type);
                    if (ordered && !orderable)
                        error("compiled_project.invalid_variable_operator",
                              "Ordered comparison is incompatible with variable '" +
                                  typed.variable_id.text() + "'.",
                              path + "/operator");
                }
            },
            *comparison);
    }

    void validate_effect(const Effect& effect, const std::string& path)
    {
        const auto* assignment = std::get_if<SetVariable>(&effect);
        if (!assignment)
            return;
        const auto* declaration = variable(assignment->variable_id);
        if (!declaration) {
            require(m_variables, assignment->variable_id, "variable", path + "/variable");
            return;
        }
        if (!value_matches(declaration->value_type, assignment->value))
            error("compiled_project.variable_type_mismatch",
                  "Assigned value does not match variable '" + assignment->variable_id.text() +
                      "'.",
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

    void validate_location(const InteractableLocation& location, const std::string& path)
    {
        const auto* reference = std::get_if<RoomPlacementRef>(&location);
        if (!reference)
            return;
        require(m_rooms, reference->room, "room", path + "/placement/room");
        const auto* linked = placement(*reference);
        if (!linked) {
            error("compiled_project.unresolved_nested_reference",
                  "Room placement '" + reference->placement_id.text() +
                      "' does not exist in room '" + reference->room.text() + "'.",
                  path + "/placement/placementId");
        }
    }

    void validate_character_location(const CharacterInitialWorldLocation& location,
                                     const std::string& path)
    {
        const auto* reference = std::get_if<RoomPlacementRef>(&location);
        if (!reference)
            return;
        validate_location(InteractableLocation{*reference}, path);
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
        for (std::size_t index = 0; index < definition.identity.property_assignments.size();
             ++index) {
            const auto& assignment = definition.identity.property_assignments[index];
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
            validate_text(value.description, path + "/description");
            validate_background(value.background, path + "/background");
            validate_condition(value.lifecycle.can_enter, path + "/lifecycle/canEnter");
            validate_condition(value.lifecycle.can_leave, path + "/lifecycle/canLeave");
            for (std::size_t hook = 0; hook < value.lifecycle.hooks.size(); ++hook)
                for (std::size_t effect = 0; effect < value.lifecycle.hooks[hook].effects.size();
                     ++effect)
                    validate_effect(value.lifecycle.hooks[hook].effects[effect],
                                    path + "/lifecycle/hooks/" + std::to_string(hook) +
                                        "/effects/" + std::to_string(effect));
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
            if (value.compose)
                require(m_scripts, value.compose->script, "script", path + "/compose/script");
            std::unordered_set<RoomExitId> exit_ids;
            for (std::size_t exit_index = 0; exit_index < value.exits.size(); ++exit_index) {
                const auto& linked_exit = value.exits[exit_index];
                const auto exit_path = path + "/exits/" + std::to_string(exit_index);
                if (!exit_ids.insert(linked_exit.id).second)
                    error("compiled_project.duplicate_nested_id", "Duplicate Room exit ID.",
                          exit_path + "/id");
                require(m_rooms, linked_exit.target, "room", exit_path + "/target");
                validate_condition(linked_exit.condition, exit_path + "/condition");
                validate_text(linked_exit.label, exit_path + "/label");
                if (linked_exit.transition)
                    validate_transition(*linked_exit.transition, exit_path + "/transition");
            }
        }
    }

    void validate_interactables()
    {
        for (std::size_t index = 0; index < m_input.interactables.size(); ++index) {
            const auto& value = m_input.interactables[index];
            const auto path = item("/definitions/interactables", index);
            validate_assignments(value, PropertyOwnerKind::Interactable, path);
            validate_location(value.initial_state.location, path + "/initialState/location");
            if (value.presentation.sprite)
                require(m_assets, *value.presentation.sprite, "asset",
                        path + "/presentation/sprite");
        }
    }

    void validate_verbs_and_interactions()
    {
        for (std::size_t index = 0; index < m_input.verbs.size(); ++index) {
            const auto& value = m_input.verbs[index];
            const auto path = item("/definitions/verbs", index);
            validate_assignments(value, PropertyOwnerKind::Verb, path);
            validate_text(value.action_text, path + "/actionText");
            validate_condition(value.availability, path + "/availability");
            validate_program(value.default_program, path + "/defaultProgram");
        }
        for (std::size_t index = 0; index < m_input.interactions.size(); ++index) {
            const auto& value = m_input.interactions[index];
            const auto path = item("/definitions/interactions", index);
            validate_assignments(value, PropertyOwnerKind::Interaction, path);
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
                        else if constexpr (std::is_same_v<T, PlacementInteractionContext>)
                            validate_location(InteractableLocation{context.placement},
                                              rule_path + "/context");
                        else if constexpr (std::is_same_v<T, PredicateInteractionContext>)
                            validate_condition(context.condition, rule_path + "/context/condition");
                    },
                    rule.context);
                for (std::size_t operand = 0; operand < rule.operands.size(); ++operand) {
                    const auto* exact = std::get_if<ExactOperand>(&rule.operands[operand]);
                    if (!exact)
                        continue;
                    const auto operand_path = rule_path + "/operands/" + std::to_string(operand);
                    std::visit(
                        [this, &operand_path](const auto& subject) {
                            using T = std::decay_t<decltype(subject)>;
                            if constexpr (std::is_same_v<T, CharacterInteractionSubject>)
                                require(m_characters, subject.character, "character",
                                        operand_path + "/subject/character");
                            else
                                require(m_interactables, subject.interactable, "interactable",
                                        operand_path + "/subject/interactable");
                        },
                        exact->subject);
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
            validate_assignments(scene, PropertyOwnerKind::Scene, path);
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
                            if (instruction.asset)
                                require(m_assets, *instruction.asset, "asset",
                                        instruction_path + "/asset");
                        } else if constexpr (std::is_same_v<T, SetVariableSceneInstruction>) {
                            const auto* declaration = variable(instruction.variable);
                            if (!declaration)
                                require(m_variables, instruction.variable, "variable",
                                        instruction_path + "/variable");
                            else if (!value_matches(declaration->value_type, instruction.value))
                                error("compiled_project.variable_type_mismatch",
                                      "Scene assignment does not match its variable.",
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
            validate_assignments(value, PropertyOwnerKind::Dialogue, path);
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
            validate_assignments(value, PropertyOwnerKind::Map, path);
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
    MAP(variables, VariableId);
    MAP(properties, PropertyId);
    MAP(assets, AssetId);
    MAP(layouts, LayoutId);
    MAP(scripts, ScriptId);
    MAP(characters, CharacterId);
    MAP(rooms, RoomId);
    MAP(interactables, InteractableId);
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
