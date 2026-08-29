#include "internal.hpp"

#include <unordered_map>

namespace noveltea::core::save_state_codec {
namespace {

const SavedRuntimeRoomConfiguration* saved_room(const SaveState& save, const RoomId& id) noexcept
{
    const auto found = std::find_if(save.runtime_rooms.begin(), save.runtime_rooms.end(),
                                    [&](const auto& value) { return value.id == id; });
    return found == save.runtime_rooms.end() ? nullptr : &*found;
}

const SavedRuntimeCharacterConfiguration* saved_character(const SaveState& save,
                                                          const CharacterId& id) noexcept
{
    const auto found = std::find_if(save.runtime_characters.begin(), save.runtime_characters.end(),
                                    [&](const auto& value) { return value.id == id; });
    return found == save.runtime_characters.end() ? nullptr : &*found;
}

const SavedRuntimeInteractableConfiguration*
saved_interactable(const SaveState& save, const InteractableInstanceId& id) noexcept
{
    const auto found =
        std::find_if(save.runtime_interactables.begin(), save.runtime_interactables.end(),
                     [&](const auto& value) { return value.id == id; });
    return found == save.runtime_interactables.end() ? nullptr : &*found;
}

std::optional<compiled::RoomDefinition>
materialize_room_source(const CompiledProject& project, const RuntimeConfigurationSource& source,
                        const RoomId& id)
{
    std::optional<compiled::RoomDefinition> result;
    std::visit(
        [&](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, CompiledRoomConfigurationSource>) {
                if (const auto* definition = project.find_room(value.room))
                    result = *definition;
            } else if constexpr (std::is_same_v<T, ArchetypeConfigurationSource>) {
                const auto* archetype = project.find_archetype(value.archetype);
                if (archetype != nullptr && archetype->kind == compiled::GameplayInstanceKind::Room)
                    if (const auto* definition =
                            std::get_if<compiled::RoomDefinition>(&archetype->configuration))
                        result = *definition;
            }
        },
        source);
    if (result)
        result->identity.id = id;
    return result;
}

std::optional<compiled::CharacterDefinition>
materialize_character_source(const CompiledProject& project,
                             const RuntimeConfigurationSource& source, const CharacterId& id)
{
    std::optional<compiled::CharacterDefinition> result;
    std::visit(
        [&](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, CompiledCharacterConfigurationSource>) {
                if (const auto* definition = project.find_character(value.character))
                    result = *definition;
            } else if constexpr (std::is_same_v<T, ArchetypeConfigurationSource>) {
                const auto* archetype = project.find_archetype(value.archetype);
                if (archetype != nullptr &&
                    archetype->kind == compiled::GameplayInstanceKind::Character)
                    if (const auto* definition =
                            std::get_if<compiled::CharacterDefinition>(&archetype->configuration))
                        result = *definition;
            }
        },
        source);
    if (result)
        result->identity.id = id;
    return result;
}

std::optional<compiled::InteractableDefinition>
materialize_interactable_source(const CompiledProject& project,
                                const RuntimeConfigurationSource& source,
                                const InteractableInstanceId& id)
{
    std::optional<compiled::InteractableDefinition> result;
    std::visit(
        [&](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, CompiledInteractableConfigurationSource>) {
                if (const auto* definition = project.find_interactable_definition(value.definition))
                    result = *definition;
            } else if constexpr (std::is_same_v<T, ArchetypeConfigurationSource>) {
                const auto* archetype = project.find_archetype(value.archetype);
                if (archetype != nullptr &&
                    archetype->kind == compiled::GameplayInstanceKind::Interactable)
                    if (const auto* definition = std::get_if<compiled::InteractableDefinition>(
                            &archetype->configuration))
                        result = *definition;
            }
        },
        source);
    (void)id;
    return result;
}

std::optional<compiled::RoomDefinition> resolved_room(const CompiledProject& project,
                                                      const SaveState& save, const RoomId& id)
{
    const auto* record = saved_room(save, id);
    if (record == nullptr)
        return std::nullopt;
    auto birth = materialize_room_source(project, record->birth_source, id);
    if (!birth)
        return std::nullopt;
    for (const auto& edit : record->birth_exit_target_overrides) {
        const auto found = std::find_if(birth->exits.begin(), birth->exits.end(),
                                        [&](const auto& value) { return value.id == edit.exit; });
        if (found == birth->exits.end())
            return std::nullopt;
        found->target = edit.target;
    }
    auto configuration =
        record->structural_override_source
            ? materialize_room_source(project, *record->structural_override_source, id)
            : std::move(birth);
    if (!configuration)
        return std::nullopt;
    if (record->structural_override_source) {
        for (const auto& edit : record->structural_override_exit_target_overrides) {
            const auto found =
                std::find_if(configuration->exits.begin(), configuration->exits.end(),
                             [&](const auto& value) { return value.id == edit.exit; });
            if (found == configuration->exits.end())
                return std::nullopt;
            found->target = edit.target;
        }
    }
    for (const auto& edit : record->exit_target_overrides) {
        const auto found = std::find_if(configuration->exits.begin(), configuration->exits.end(),
                                        [&](const auto& value) { return value.id == edit.exit; });
        if (found == configuration->exits.end())
            return std::nullopt;
        found->target = edit.target;
    }
    return configuration;
}

std::optional<compiled::CharacterDefinition>
resolved_character(const CompiledProject& project, const SaveState& save, const CharacterId& id)
{
    const auto* record = saved_character(save, id);
    return record == nullptr
               ? std::nullopt
               : materialize_character_source(
                     project, record->structural_override_source.value_or(record->birth_source),
                     id);
}

std::optional<compiled::InteractableDefinition>
resolved_interactable(const CompiledProject& project, const SaveState& save,
                      const InteractableInstanceId& id)
{
    const auto* record = saved_interactable(save, id);
    if (record == nullptr)
        return std::nullopt;
    auto configuration = materialize_interactable_source(
        project, record->structural_override_source.value_or(record->birth_source), id);
    if (!configuration)
        return std::nullopt;
    if (record->declared && !record->structural_override_source) {
        const auto* declaration = project.find_interactable_instance(id);
        if (declaration == nullptr)
            return std::nullopt;
        *configuration = realize_declared_interactable_configuration(*configuration, *declaration);
    }
    return configuration;
}

std::optional<PropertyDefinition> resolved_property_definition(const CompiledProject& project,
                                                               const SaveState& save,
                                                               const PropertyOwnerRef& owner,
                                                               const PropertyId& property)
{
    if (const auto* declaration = project.find_property(owner, property))
        return *declaration;
    const auto* interactable = std::get_if<InteractableInstanceId>(&owner);
    if (interactable == nullptr)
        return std::nullopt;
    auto configuration = resolved_interactable(project, save, *interactable);
    if (!configuration)
        return std::nullopt;

    const compiled::OwnerPropertyContract* contract = nullptr;
    const auto own = std::ranges::find_if(configuration->properties, [&](const auto& candidate) {
        return candidate.property_id == property;
    });
    if (own != configuration->properties.end())
        contract = &*own;
    if (contract == nullptr) {
        for (const auto& trait_id : configuration->identity.traits) {
            const auto* trait = project.find_trait(trait_id);
            if (trait == nullptr)
                continue;
            const auto member = std::ranges::find_if(trait->properties, [&](const auto& candidate) {
                return candidate.property_id == property;
            });
            if (member != trait->properties.end()) {
                contract = &*member;
                break;
            }
        }
    }
    if (contract == nullptr)
        return std::nullopt;
    auto declaration = make_property_definition(PropertyDefinitionInput{
        .id = contract->property_id,
        .value_type = contract->value_type,
        .nullable = contract->nullable,
        .default_value = contract->configured_value,
        .scope = PropertyScope::Identity,
        .allowed_owners = {PropertyOwnerKind::Interactable},
        .exact_owner = std::nullopt,
        .label = contract->label,
        .description = contract->description,
    });
    return declaration ? std::optional<PropertyDefinition>{*declaration.value_if()} : std::nullopt;
}

bool feature_exists(const CompiledProject& project, const SaveState& save,
                    const RoomFeatureRef& reference)
{
    auto room = resolved_room(project, save, reference.room);
    return room && std::ranges::any_of(room->features, [&](const auto& feature) {
               return feature.identity.id == reference.feature_id;
           });
}

bool feature_exists(const CompiledProject& project, const SaveState& save,
                    const InteractableFeatureRef& reference)
{
    auto interactable = resolved_interactable(project, save, reference.interactable);
    return interactable && std::ranges::any_of(interactable->features, [&](const auto& feature) {
               return feature.identity.id == reference.feature_id;
           });
}

} // namespace

bool owner_exists(const CompiledProject& project, const SaveState& save,
                  const PropertyOwnerRef& owner)
{
    return std::visit(
        [&project, &save](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>)
                return resolved_room(project, save, id).has_value();
            else if constexpr (std::is_same_v<T, CharacterId>)
                return resolved_character(project, save, id).has_value();
            else if constexpr (std::is_same_v<T, InteractableInstanceId>)
                return resolved_interactable(project, save, id).has_value();
            else if constexpr (std::is_same_v<T, ItemStackId>)
                return std::ranges::any_of(save.item_stacks,
                                           [&](const auto& value) { return value.id == id; });
            else
                return feature_exists(project, save, id);
        },
        owner);
}

bool target_exists(const CompiledProject& project, const SaveState& save,
                   const PropertyTargetRef& target)
{
    return std::visit(
        [&project, &save](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, GlobalPropertyTarget>)
                return true;
            else
                return owner_exists(project, save, PropertyOwnerRef{value});
        },
        target);
}

template<class T> const auto* instruction_by_id(const std::vector<T>& values, const auto& id)
{
    const auto found = std::find_if(values.begin(), values.end(), [&id](const T& value) {
        if constexpr (std::is_same_v<T, GameplayCommand>)
            return value.id == id;
        else
            return std::visit([&id](const auto& item) { return item.id == id; }, value);
    });
    return found == values.end() ? nullptr : &*found;
}

bool has_scene_step(const compiled::SceneDefinition& scene, const SceneStepId& id)
{
    return instruction_by_id(scene.program.instructions, id) != nullptr;
}

const compiled::ChoiceSceneInstruction* scene_choice(const compiled::SceneDefinition& scene,
                                                     const SceneStepId& id)
{
    const auto* instruction = instruction_by_id(scene.program.instructions, id);
    return instruction ? std::get_if<compiled::ChoiceSceneInstruction>(instruction) : nullptr;
}

const compiled::DialogueBlock* dialogue_block(const compiled::DialogueDefinition& dialogue,
                                              const DialogueBlockId& id)
{
    const auto found = std::find_if(
        dialogue.program.blocks.begin(), dialogue.program.blocks.end(),
        [&id](const compiled::DialogueBlock& block) {
            return std::visit([&id](const auto& item) { return item.id == id; }, block);
        });
    return found == dialogue.program.blocks.end() ? nullptr : &*found;
}

const compiled::DialogueSegment* dialogue_segment(const compiled::DialogueBlock& block,
                                                  const DialogueSegmentId& id)
{
    const auto* sequence = std::get_if<compiled::DialogueSequenceBlock>(&block);
    if (!sequence)
        return nullptr;
    return instruction_by_id(sequence->segments, id);
}

const compiled::DialogueEdge* dialogue_edge(const compiled::DialogueDefinition& dialogue,
                                            const DialogueEdgeId& id)
{
    const auto found =
        std::find_if(dialogue.program.edges.begin(), dialogue.program.edges.end(),
                     [&id](const compiled::DialogueEdge& edge) {
                         return std::visit([&id](const auto& item) { return item.id == id; }, edge);
                     });
    return found == dialogue.program.edges.end() ? nullptr : &*found;
}

const compiled::InteractionProgram* interaction_program(const CompiledProject& project,
                                                        const InteractionProgramRef& reference)
{
    return std::visit(
        [&project](const auto& item) -> const compiled::InteractionProgram* {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, InteractionRuleProgramRef>) {
                const auto* interaction = project.find_interaction(item.interaction);
                if (!interaction)
                    return nullptr;
                const auto found =
                    std::find_if(interaction->rules.begin(), interaction->rules.end(),
                                 [&item](const compiled::InteractionRule& rule) {
                                     return rule.id == item.rule;
                                 });
                return found == interaction->rules.end() ? nullptr : &found->program;
            } else if constexpr (std::is_same_v<T, VerbDefaultProgramRef>) {
                const auto* verb = project.find_verb(item.verb);
                return verb ? &verb->default_program : nullptr;
            } else {
                const auto& fallback = project.undefined_interaction_program();
                return fallback ? &*fallback : nullptr;
            }
        },
        reference);
}

bool has_interaction_instruction(const compiled::InteractionProgram& program,
                                 const InteractionInstructionId& id)
{
    const auto contains = [&id](const auto& self,
                                std::span<const GameplayCommand> commands) -> bool {
        for (const auto& command : commands) {
            if (command.id == id)
                return true;
            if (const auto* branch = std::get_if<IfGameplayCommand>(&command.value);
                branch && (self(self, branch->then_commands) || self(self, branch->else_commands)))
                return true;
        }
        return false;
    };
    return contains(contains, program.instructions);
}

bool inventory_exists(const CompiledProject& project, const SaveState& save,
                      const compiled::InventoryRef& inventory)
{
    return std::visit(
        [&](const auto& owner) {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, compiled::ProjectInventoryOwner>)
                return project.find_inventory(inventory) != nullptr;
            else if constexpr (std::is_same_v<T, compiled::CharacterInventoryOwner>) {
                auto definition = resolved_character(project, save, owner.character);
                return definition &&
                       std::ranges::any_of(definition->inventories, [&](const auto& value) {
                           return value.id == inventory.inventory_id;
                       });
            } else if constexpr (std::is_same_v<T, compiled::InteractableInventoryOwner>) {
                auto definition = resolved_interactable(project, save, owner.interactable);
                return definition &&
                       std::ranges::any_of(definition->inventories, [&](const auto& value) {
                           return value.id == inventory.inventory_id;
                       });
            } else if constexpr (std::is_same_v<T, RoomFeatureRef>) {
                auto definition = resolved_room(project, save, owner.room);
                if (!definition)
                    return false;
                const auto feature =
                    std::ranges::find_if(definition->features, [&](const auto& value) {
                        return value.identity.id == owner.feature_id;
                    });
                return feature != definition->features.end() &&
                       std::ranges::any_of(feature->inventories, [&](const auto& value) {
                           return value.id == inventory.inventory_id;
                       });
            } else {
                auto definition = resolved_interactable(project, save, owner.interactable);
                if (!definition)
                    return false;
                const auto feature =
                    std::ranges::find_if(definition->features, [&](const auto& value) {
                        return value.identity.id == owner.feature_id;
                    });
                return feature != definition->features.end() &&
                       std::ranges::any_of(feature->inventories, [&](const auto& value) {
                           return value.id == inventory.inventory_id;
                       });
            }
        },
        inventory.owner);
}

bool valid_location(const CompiledProject& project, const SaveState& save,
                    const compiled::InteractableLocation& location)
{
    if (const auto* room = std::get_if<compiled::RoomLocation>(&location))
        return resolved_room(project, save, room->room).has_value();
    if (const auto* inventory = std::get_if<compiled::InventoryLocation>(&location))
        return inventory_exists(project, save, inventory->inventory);
    return true;
}

bool valid_character_location(const CompiledProject& project, const SaveState& save,
                              const CharacterWorldLocation& location)
{
    const auto* room = std::get_if<compiled::RoomLocation>(&location);
    return room == nullptr || resolved_room(project, save, room->room).has_value();
}

std::optional<InteractableInstanceId>
inventory_interactable_owner(const compiled::InventoryRef& inventory)
{
    return std::visit(
        [](const auto& owner) -> std::optional<InteractableInstanceId> {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, compiled::InteractableInventoryOwner>)
                return owner.interactable;
            else if constexpr (std::is_same_v<T, InteractableFeatureRef>)
                return owner.interactable;
            else
                return std::nullopt;
        },
        inventory.owner);
}

const compiled::RoomExit* find_exit(const compiled::RoomDefinition& room, const RoomExitId& exit)
{
    const auto found =
        std::find_if(room.exits.begin(), room.exits.end(),
                     [&exit](const compiled::RoomExit& item) { return item.id == exit; });
    return found == room.exits.end() ? nullptr : &*found;
}

bool valid_destination(const CompiledProject& project, const SaveState& save,
                       const ReturnDestination& destination)
{
    if (const auto* room = std::get_if<ResumeRoomDestination>(&destination))
        return resolved_room(project, save, room->room).has_value();
    return true;
}

std::string target_text(const PropertyTargetRef& target)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, GlobalPropertyTarget>)
                return std::string{"global"};
            else if constexpr (std::is_same_v<T, RoomFeatureRef>)
                return "room:" + value.room.text() + "/feature:" + value.feature_id.text();
            else if constexpr (std::is_same_v<T, InteractableFeatureRef>)
                return "interactable:" + value.interactable.text() +
                       "/feature:" + value.feature_id.text();
            else
                return value.text();
        },
        target);
}

std::optional<std::uint64_t> runtime_ordinal(std::string_view text,
                                             std::string_view prefix) noexcept
{
    if (!text.starts_with(prefix) || text.size() == prefix.size())
        return std::nullopt;
    std::uint64_t value = 0;
    for (const char character : text.substr(prefix.size())) {
        if (character < '0' || character > '9')
            return std::nullopt;
        const auto digit = static_cast<std::uint64_t>(character - '0');
        if (value > (std::numeric_limits<std::uint64_t>::max() - digit) / 10U)
            return std::nullopt;
        value = value * 10U + digit;
    }
    return value == 0 ? std::nullopt : std::optional<std::uint64_t>{value};
}

bool valid_scene_position(const compiled::SceneDefinition& scene,
                          const SceneFramePosition& position)
{
    if (position.next_step && !has_scene_step(scene, *position.next_step))
        return false;
    return std::visit(
        [&scene, &position](const auto& item) {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, SceneStepReady>)
                return true;
            else if constexpr (std::is_same_v<T, SceneInstructionCompletionPosition>)
                return position.next_step &&
                       (!item.next_step || has_scene_step(scene, *item.next_step));
            else if constexpr (std::is_same_v<T, SceneAutosavePendingPosition>)
                return position.next_step == item.completed_step &&
                       (!item.next_step || has_scene_step(scene, *item.next_step));
            else if constexpr (std::is_same_v<T, SceneChoiceSelectionPosition>)
                return position.next_step && scene_choice(scene, *position.next_step) != nullptr;
            else {
                const auto* choice =
                    position.next_step ? scene_choice(scene, *position.next_step) : nullptr;
                if (!choice)
                    return false;
                const auto found = std::find_if(choice->options.begin(), choice->options.end(),
                                                [&item](const compiled::SceneChoiceOption& option) {
                                                    return option.id == item.option;
                                                });
                return found != choice->options.end() &&
                       item.next_effect <= found->effects.size() &&
                       (!item.awaiting_completion || item.next_effect < found->effects.size());
            }
        },
        position.substate);
}

bool valid_scene_inputs(const compiled::SceneDefinition& scene,
                        const std::vector<compiled::SceneInputBinding>& bindings)
{
    if (bindings.size() != scene.inputs.size())
        return false;
    std::unordered_set<SceneInputId> seen;
    for (const auto& binding : bindings) {
        if (!seen.insert(binding.input_id).second)
            return false;
        const auto declaration =
            std::ranges::find_if(scene.inputs, [&](const compiled::SceneInputDefinition& input) {
                return input.id == binding.input_id;
            });
        if (declaration == scene.inputs.end())
            return false;
        if (std::holds_alternative<std::monostate>(binding.value)) {
            if (!declaration->nullable)
                return false;
            continue;
        }
        const bool matches = [&] {
            switch (declaration->type) {
            case compiled::SceneInputType::Boolean:
                return std::holds_alternative<bool>(binding.value);
            case compiled::SceneInputType::Integer:
                return std::holds_alternative<std::int64_t>(binding.value);
            case compiled::SceneInputType::Number:
                return std::holds_alternative<std::int64_t>(binding.value) ||
                       std::holds_alternative<double>(binding.value);
            case compiled::SceneInputType::String:
                return std::holds_alternative<std::string>(binding.value);
            }
            return false;
        }();
        if (!matches)
            return false;
    }
    return true;
}

bool contains_gameplay_command(std::span<const GameplayCommand> commands,
                               const InteractionInstructionId& id)
{
    for (const auto& command : commands) {
        if (command.id == id)
            return true;
        if (const auto* branch = std::get_if<IfGameplayCommand>(&command.value);
            branch && (contains_gameplay_command(branch->then_commands, id) ||
                       contains_gameplay_command(branch->else_commands, id)))
            return true;
    }
    return false;
}

bool valid_nested_effect_cursor(const std::vector<GameplayCommand>& effects,
                                const DialogueFramePosition& position)
{
    if (!position.effect_command)
        return true;
    if (position.next_effect >= effects.size())
        return false;
    const auto* branch = std::get_if<IfGameplayCommand>(&effects[position.next_effect].value);
    return branch && (contains_gameplay_command(branch->then_commands, *position.effect_command) ||
                      contains_gameplay_command(branch->else_commands, *position.effect_command));
}

bool valid_dialogue_position(const compiled::DialogueDefinition& dialogue,
                             const DialogueFramePosition& position)
{
    const auto* block = dialogue_block(dialogue, position.block);
    if (!block || position.stage > DialogueFramePosition::Stage::Complete)
        return false;
    const auto* segment = position.segment ? dialogue_segment(*block, *position.segment) : nullptr;
    const auto* edge = position.edge ? dialogue_edge(dialogue, *position.edge) : nullptr;
    if ((position.segment && !segment) ||
        (position.edge &&
         (!edge ||
          std::visit([&position](const auto& item) { return item.from_block_id != position.block; },
                     *edge))))
        return false;
    switch (position.stage) {
    case DialogueFramePosition::Stage::EnterBlock:
    case DialogueFramePosition::Stage::Complete:
        return !position.segment && !position.edge && position.next_effect == 0 &&
               !position.awaiting_completion && position.next_cue == 0 &&
               position.reveal_offset == 0 && !position.effect_command;
    case DialogueFramePosition::Stage::PresentSegment:
        return segment && !position.edge && position.next_effect == 0 &&
               (!position.awaiting_completion ||
                std::holds_alternative<compiled::DialogueRunLuaSegment>(*segment)) &&
               position.next_cue == 0 && position.reveal_offset == 0 && !position.effect_command;
    case DialogueFramePosition::Stage::ApplySegmentEffects: {
        const auto* line = segment ? std::get_if<compiled::DialogueLineSegment>(segment) : nullptr;
        if (!line || position.edge || position.next_effect > line->effects.size() ||
            (position.awaiting_completion && position.next_effect >= line->effects.size()) ||
            position.next_cue > line->cues.size() ||
            !valid_nested_effect_cursor(line->effects, position))
            return false;
        const auto cue_offset = [](const compiled::DialogueSemanticCue& cue) {
            return std::visit([](const auto& value) { return value.position.offset; }, cue);
        };
        if (position.next_cue > 0 &&
            cue_offset(line->cues[position.next_cue - 1]) > position.reveal_offset)
            return false;
        if (position.next_cue < line->cues.size() &&
            cue_offset(line->cues[position.next_cue]) < position.reveal_offset)
            return false;
        return true;
    }
    case DialogueFramePosition::Stage::PresentChoices:
        return std::holds_alternative<compiled::DialogueChoiceBlock>(*block) && !position.segment &&
               !position.edge && position.next_effect == 0 && position.next_cue == 0 &&
               position.reveal_offset == 0 && !position.effect_command;
    case DialogueFramePosition::Stage::ApplyChoiceEffects: {
        const auto* choice = edge ? std::get_if<compiled::DialogueChoiceEdge>(edge) : nullptr;
        return choice && !position.segment && position.next_effect <= choice->effects.size() &&
               (!position.awaiting_completion || position.next_effect < choice->effects.size()) &&
               position.next_cue == 0 && position.reveal_offset == 0 &&
               valid_nested_effect_cursor(choice->effects, position);
    }
    case DialogueFramePosition::Stage::FollowEdge:
        return edge && !position.segment && position.next_effect == 0 &&
               !position.awaiting_completion && position.next_cue == 0 &&
               position.reveal_offset == 0 && !position.effect_command;
    }
    return false;
}

bool valid_dialogue_character_presentation(
    const CompiledProject& project, const SaveState& save, const CharacterId& character_id,
    const CharacterPresentationProfileId& profile_id, const CharacterPoseId& pose_id,
    const CharacterExpressionId& expression_id,
    const std::optional<CharacterAppearanceId>& appearance_id) noexcept
{
    auto character = resolved_character(project, save, character_id);
    if (!character)
        return false;
    const auto profile = std::find_if(character->profiles.begin(), character->profiles.end(),
                                      [&](const auto& value) { return value.id == profile_id; });
    if (profile == character->profiles.end() ||
        std::none_of(profile->poses.begin(), profile->poses.end(),
                     [&](const auto& value) { return value.id == pose_id; }) ||
        std::none_of(character->expressions.begin(), character->expressions.end(),
                     [&](const auto& value) { return value.id == expression_id; }))
        return false;
    return !appearance_id ||
           std::any_of(character->appearances.begin(), character->appearances.end(),
                       [&](const auto& value) { return value.id == *appearance_id; });
}

bool valid_dialogue_stage_state(const CompiledProject& project, const SaveState& save,
                                const compiled::DialogueStageSlotState& state) noexcept
{
    return valid_dialogue_character_presentation(project, save, state.character, state.profile_id,
                                                 state.pose_id, state.expression_id,
                                                 state.appearance_id) &&
           state.position <= compiled::ActorPosition::Right && std::isfinite(state.offset.x) &&
           std::isfinite(state.offset.y) && std::isfinite(state.scale) && state.scale > 0.0;
}

bool valid_dialogue_media_content(const CompiledProject& project, const SaveState& save,
                                  const compiled::DialogueMediaContent& content) noexcept
{
    return std::visit(
        [&](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::DialogueImageMedia>) {
                const auto* asset = project.find_asset(value.asset);
                return asset != nullptr && asset->kind == compiled::AssetKind::Image;
            } else {
                return valid_dialogue_character_presentation(
                    project, save, value.character, value.profile_id, value.pose_id,
                    value.expression_id, value.appearance_id);
            }
        },
        content);
}

bool valid_dialogue_presentation_state(const CompiledProject& project, const SaveState& save,
                                       const compiled::DialogueDefinition& dialogue,
                                       const SavedDialogueFrame& frame) noexcept
{
    if (frame.stage_slots.size() != dialogue.stage_slots.size() ||
        frame.media_slots.size() != dialogue.media_slots.size())
        return false;

    std::unordered_set<DialogueStageSlotId> stage_ids;
    for (const auto& state : frame.stage_slots) {
        if (!stage_ids.insert(state.slot).second ||
            std::none_of(dialogue.stage_slots.begin(), dialogue.stage_slots.end(),
                         [&](const auto& slot) { return slot.id == state.slot; }) ||
            (state.value && !valid_dialogue_stage_state(project, save, *state.value)))
            return false;
    }

    std::unordered_set<DialogueMediaSlotId> media_ids;
    for (const auto& state : frame.media_slots) {
        if (!media_ids.insert(state.slot).second ||
            std::none_of(dialogue.media_slots.begin(), dialogue.media_slots.end(),
                         [&](const auto& slot) { return slot.id == state.slot; }) ||
            (state.content && !valid_dialogue_media_content(project, save, *state.content)))
            return false;
    }
    return true;
}

std::size_t room_program_node_count(std::span<const GameplayCommand> commands)
{
    std::size_t count = 0;
    for (const auto& command : commands) {
        ++count;
        if (const auto* branch = std::get_if<IfGameplayCommand>(&command.value)) {
            count += room_program_node_count(branch->then_commands);
            count += room_program_node_count(branch->else_commands);
        }
    }
    return count;
}

bool valid_room_position(const CompiledProject& project, const SaveState& save,
                         const SavedRoomTransitionFrame& frame)
{
    const auto& position = frame.position;
    if (position.stage > RoomTransitionStage::Complete)
        return false;
    const bool program_stage = position.stage == RoomTransitionStage::BeforeLeave ||
                               position.stage == RoomTransitionStage::BeforeEnter ||
                               position.stage == RoomTransitionStage::AfterLeave ||
                               position.stage == RoomTransitionStage::AfterEnter ||
                               position.stage == RoomTransitionStage::RejectionProgram;
    if (!program_stage)
        return position.next_effect == 0 &&
               (!position.awaiting_completion ||
                position.stage == RoomTransitionStage::CommitRoomSwitch) &&
               !frame.rejection_stage;

    auto source =
        frame.source_room ? resolved_room(project, save, *frame.source_room) : std::nullopt;
    auto target = resolved_room(project, save, frame.target_room);
    if (!target)
        return false;
    std::span<const GameplayCommand> commands;
    switch (position.stage) {
    case RoomTransitionStage::BeforeLeave:
        if (!source)
            return false;
        commands = source->lifecycle.before_leave;
        break;
    case RoomTransitionStage::BeforeEnter:
        commands = target->lifecycle.before_enter;
        break;
    case RoomTransitionStage::AfterLeave:
        if (!source)
            return false;
        commands = source->lifecycle.after_leave;
        break;
    case RoomTransitionStage::AfterEnter:
        commands = target->lifecycle.after_enter;
        break;
    case RoomTransitionStage::RejectionProgram:
        if (!frame.rejection_stage || !source)
            return false;
        if (*frame.rejection_stage == RoomRejectionStage::TargetCanEnter)
            commands = target->lifecycle.on_enter_rejected;
        else if (*frame.rejection_stage == RoomRejectionStage::ExitEligibility &&
                 frame.selected_exit) {
            const auto* exit = find_exit(*source, frame.selected_exit->exit_id);
            commands = exit != nullptr && !exit->on_rejected.empty()
                           ? std::span<const GameplayCommand>{exit->on_rejected}
                           : std::span<const GameplayCommand>{source->lifecycle.on_leave_rejected};
        } else
            commands = source->lifecycle.on_leave_rejected;
        break;
    default:
        return false;
    }
    if (position.next_effect > room_program_node_count(commands))
        return false;
    return !position.awaiting_completion || position.stage == RoomTransitionStage::AfterLeave ||
           position.stage == RoomTransitionStage::AfterEnter ||
           position.stage == RoomTransitionStage::RejectionProgram;
}

bool valid_room_visit_context(const CompiledProject& project, const SaveState& save,
                              const RoomVisitContext& visit, bool active) noexcept
{
    if (!resolved_room(project, save, visit.room) || visit.visit_index == 0 ||
        visit.entry_sequence == 0 || visit.entry_sequence > save.room_entry_sequence ||
        visit.entry_cause > RoomEntryCause::DirectedRoomChange)
        return false;
    if (visit.source_room && !resolved_room(project, save, *visit.source_room))
        return false;
    const auto history =
        std::find_if(save.room_visits.begin(), save.room_visits.end(),
                     [&visit](const SavedRoomVisits& item) { return item.room == visit.room; });
    if (history == save.room_visits.end() ||
        (active ? history->count != visit.visit_index : history->count < visit.visit_index))
        return false;

    bool entry_valid = !visit.entry_exit;
    if (visit.entry_exit) {
        auto source = resolved_room(project, save, visit.entry_exit->room);
        const auto* exit = source ? find_exit(*source, visit.entry_exit->exit_id) : nullptr;
        entry_valid = source.has_value() && exit != nullptr && exit->target == visit.room &&
                      visit.source_room == visit.entry_exit->room;
    }
    if (!entry_valid)
        return false;

    switch (visit.entry_cause) {
    case RoomEntryCause::Entrypoint:
        return !visit.source_room && !visit.entry_exit;
    case RoomEntryCause::NavigationAttempt:
        return visit.source_room.has_value() && visit.entry_exit.has_value();
    case RoomEntryCause::DirectedRoomChange:
        return !visit.entry_exit;
    }
    return false;
}

bool valid_detached_frame(const CompiledProject& project, const SaveState& save,
                          const SavedSceneFrame& frame)
{
    if (!valid_destination(project, save, frame.destination))
        return false;
    const auto* scene = project.find_scene(frame.scene);
    return scene && valid_scene_position(*scene, frame.position) &&
           valid_scene_inputs(*scene, frame.inputs);
}

bool valid_detached_frame(const CompiledProject& project, const SaveState& save,
                          const SavedDialogueFrame& frame)
{
    if (!valid_destination(project, save, frame.destination))
        return false;
    const auto* dialogue = project.find_dialogue(frame.dialogue);
    return dialogue && valid_dialogue_position(*dialogue, frame.position) &&
           valid_dialogue_presentation_state(project, save, *dialogue, frame);
}

bool valid_detached_frame(const CompiledProject& project, const SaveState& save,
                          const SavedInteractionFrame& frame)
{
    if (!valid_destination(project, save, frame.destination))
        return false;
    const auto* program = interaction_program(project, frame.program);
    const auto* verb = project.find_verb(frame.invocation.verb);
    if (program == nullptr || verb == nullptr ||
        frame.invocation.bindings.size() != verb->slots.size())
        return false;

    std::unordered_set<VerbSlotId> binding_slots;
    for (const auto& binding : frame.invocation.bindings) {
        const bool known_slot = std::ranges::any_of(
            verb->slots, [&](const auto& slot) { return slot.id == binding.slot_id; });
        if (!known_slot || !binding_slots.insert(binding.slot_id).second)
            return false;
    }

    return (!frame.position.next_instruction ||
            has_interaction_instruction(*program, *frame.position.next_instruction)) &&
           frame.position.fallback_stage <= InteractionFallbackStage::Complete &&
           frame.position.outcome <= InteractionExecutionOutcome::Failed &&
           (!frame.position.awaiting_completion || frame.position.next_instruction.has_value());
}

bool valid_detached_frame(const CompiledProject& project, const SaveState& save,
                          const SavedRoomTransitionFrame& frame)
{
    if (!valid_destination(project, save, frame.destination) ||
        !resolved_room(project, save, frame.target_room) ||
        (frame.source_room && !resolved_room(project, save, *frame.source_room)) ||
        !valid_room_position(project, save, frame) ||
        frame.kind > RoomTransitionKind::DirectedRoomChange ||
        frame.entry_cause > RoomEntryCause::DirectedRoomChange)
        return false;
    if (frame.source_context &&
        (!frame.source_room || frame.source_context->room != *frame.source_room ||
         !valid_room_visit_context(project, save, *frame.source_context, false)))
        return false;
    if (frame.source_room.has_value() != frame.source_context.has_value())
        return false;
    if (frame.kind == RoomTransitionKind::NavigationAttempt) {
        if (frame.entry_cause != RoomEntryCause::NavigationAttempt || !frame.source_room ||
            !frame.selected_exit)
            return false;
        auto room = resolved_room(project, save, frame.selected_exit->room);
        if (!room || frame.selected_exit->room != *frame.source_room)
            return false;
        const auto found = std::ranges::find_if(room->exits, [&](const compiled::RoomExit& exit) {
            return exit.id == frame.selected_exit->exit_id;
        });
        return found != room->exits.end() && found->target == frame.target_room;
    }
    if (frame.selected_exit || frame.entry_cause == RoomEntryCause::NavigationAttempt)
        return false;
    if (frame.entry_cause == RoomEntryCause::Entrypoint)
        return !frame.source_room && !frame.source_context;
    return frame.entry_cause == RoomEntryCause::DirectedRoomChange;
}

bool valid_detached_frame(const CompiledProject& project, const SaveState& save,
                          const SavedFlowFrame& frame)
{
    if (const auto* scene = std::get_if<SavedSceneFrame>(&frame))
        return valid_detached_frame(project, save, *scene);
    if (const auto* dialogue = std::get_if<SavedDialogueFrame>(&frame))
        return valid_detached_frame(project, save, *dialogue);
    if (const auto* interaction = std::get_if<SavedInteractionFrame>(&frame))
        return valid_detached_frame(project, save, *interaction);
    return valid_detached_frame(project, save, std::get<SavedRoomTransitionFrame>(frame));
}

const SavedFlowFrame* saved_frame(const SaveState& save, SavedFlowFrameId id) noexcept
{
    const auto found = std::find_if(
        save.flow_stack.begin(), save.flow_stack.end(), [id](const SavedFlowFrame& frame) {
            return std::visit([id](const auto& value) { return value.snapshot_id == id; }, frame);
        });
    if (found != save.flow_stack.end())
        return &*found;
    for (const auto& detached : save.detached_flows) {
        const auto detached_found = std::find_if(
            detached.flow_stack.begin(), detached.flow_stack.end(),
            [id](const SavedFlowFrame& frame) {
                return std::visit([id](const auto& value) { return value.snapshot_id == id; },
                                  frame);
            });
        if (detached_found != detached.flow_stack.end())
            return &*detached_found;
    }
    return nullptr;
}

bool valid_saved_owner(const CompiledProject& project, const SaveState& save,
                       const SavedPresentationOwner& owner) noexcept
{
    return std::visit(
        [&project, &save](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedScenePresentationOwner>) {
                const auto* frame = saved_frame(save, value.invocation);
                const auto* scene = frame ? std::get_if<SavedSceneFrame>(frame) : nullptr;
                return scene != nullptr && scene->scene == value.scene &&
                       project.find_scene(value.scene) != nullptr;
            } else if constexpr (std::is_same_v<T, SavedDialoguePresentationOwner>) {
                const auto* frame = saved_frame(save, value.invocation);
                const auto* dialogue = frame ? std::get_if<SavedDialogueFrame>(frame) : nullptr;
                return dialogue != nullptr && dialogue->dialogue == value.dialogue &&
                       project.find_dialogue(value.dialogue) != nullptr;
            } else if constexpr (std::is_same_v<T, SavedCurrentRoomPresentationOwner>) {
                return save.active_room_visit && save.active_room_visit->room == value.room &&
                       resolved_room(project, save, value.room).has_value();
            } else if constexpr (std::is_same_v<T, SavedRoomPresentationOwner>) {
                return resolved_room(project, save, value.room).has_value();
            } else {
                return true;
            }
        },
        owner);
}

std::string saved_owner_key(const SavedPresentationOwner& owner)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedScenePresentationOwner>)
                return std::string("scene:") + std::to_string(value.invocation.value) + ":" +
                       value.scene.text();
            else if constexpr (std::is_same_v<T, SavedDialoguePresentationOwner>)
                return std::string("dialogue:") + std::to_string(value.invocation.value) + ":" +
                       value.dialogue.text();
            else if constexpr (std::is_same_v<T, SavedCurrentRoomPresentationOwner>)
                return std::string("current-room:") + value.room.text();
            else if constexpr (std::is_same_v<T, SavedRoomPresentationOwner>)
                return std::string("room:") + value.room.text();
            else
                return std::string("session");
        },
        owner);
}

std::string saved_actor_key_text(const SavedActorPresentationKey& key)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, CharacterActorKey>)
                return std::string("character:") + value.character.text();
            else if constexpr (std::is_same_v<T, RoomCastActorKey>)
                return std::string("room-cast:") + value.room.text() + ":" + value.entry.text();
            else if constexpr (std::is_same_v<T, SavedSceneActorKey>)
                return std::string("scene:") + std::to_string(value.owner.invocation.value) + ":" +
                       value.owner.scene.text() + ":" + value.slot.text();
            else
                return std::string("scoped:") + value.instance.text();
        },
        key);
}

std::string saved_mount_key_text(const MountedLayoutPresentationKey& key)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ReservedLayoutMountKey>)
                return std::string("reserved:") +
                       std::to_string(static_cast<std::uint8_t>(value.slot));
            else if constexpr (std::is_same_v<T, RoomOverlayLayoutMountKey>)
                return std::string("room-overlay:") + value.room.text() + ":" +
                       value.overlay.text();
            else
                return std::string("scoped:") + value.instance.text();
        },
        key);
}

std::string saved_material_occurrence_key(const SavedMaterialOccurrence& occurrence)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedBackgroundMaterialOccurrence>)
                return std::string{"background"};
            else if constexpr (std::is_same_v<T, SavedActorMaterialOccurrence>)
                return std::string{"actor:"} + saved_actor_key_text(value.key) + ":" +
                       value.layer.text();
            else if constexpr (std::is_same_v<T, SavedPropMaterialOccurrence>)
                return std::string{"prop:"} + value.instance.text();
            else if constexpr (std::is_same_v<T, SavedEnvironmentMaterialOccurrence>)
                return std::string{"environment:"} + value.instance.text();
            else if constexpr (std::is_same_v<T, SavedLayoutMaterialOccurrence>)
                return std::string{"layout:"} + saved_mount_key_text(value.key) + ":" +
                       value.material.text();
            else
                return std::string{"postprocess:"} + value.instance.text();
        },
        occurrence);
}

bool material_parameter_value_matches(compiled::MaterialParameterType type,
                                      const compiled::MaterialParameterValue& value) noexcept
{
    switch (type) {
    case compiled::MaterialParameterType::Float:
        return std::holds_alternative<double>(value);
    case compiled::MaterialParameterType::Vec2:
        return std::holds_alternative<std::array<double, 2>>(value);
    case compiled::MaterialParameterType::Vec3:
        return std::holds_alternative<std::array<double, 3>>(value);
    case compiled::MaterialParameterType::Vec4:
        return std::holds_alternative<std::array<double, 4>>(value);
    case compiled::MaterialParameterType::Color:
        return std::holds_alternative<compiled::MaterialColorValue>(value);
    case compiled::MaterialParameterType::Int:
        return std::holds_alternative<std::int64_t>(value);
    case compiled::MaterialParameterType::Bool:
        return std::holds_alternative<bool>(value);
    }
    return false;
}

bool material_parameter_value_finite(const compiled::MaterialParameterValue& value) noexcept
{
    return std::visit(
        [](const auto& item) {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, double>)
                return std::isfinite(item);
            else if constexpr (std::is_same_v<T, std::array<double, 2>> ||
                               std::is_same_v<T, std::array<double, 3>> ||
                               std::is_same_v<T, std::array<double, 4>>)
                return std::all_of(item.begin(), item.end(),
                                   [](double component) { return std::isfinite(component); });
            else if constexpr (std::is_same_v<T, compiled::MaterialColorValue>)
                return std::isfinite(item.r) && std::isfinite(item.g) && std::isfinite(item.b) &&
                       std::isfinite(item.a);
            else
                return true;
        },
        value);
}

bool valid_saved_material_parameter(const CompiledProject& project, const SaveState& save,
                                    const SavedMaterialParameter& parameter) noexcept
{
    if (!valid_saved_owner(project, save, parameter.owner) || parameter.parameter.empty() ||
        parameter.clock > MaterialClockPolicy::UnscaledPresentation)
        return false;
    const auto* interface = project.find_material_interface(parameter.material);
    if (interface == nullptr)
        return false;
    const auto declaration =
        std::find_if(interface->parameters.begin(), interface->parameters.end(),
                     [&](const auto& item) { return item.name == parameter.parameter; });
    if (declaration == interface->parameters.end() || declaration->renderer_binding)
        return false;
    if (parameter.value &&
        (!material_parameter_value_matches(declaration->type, *parameter.value) ||
         !material_parameter_value_finite(*parameter.value)))
        return false;
    return parameter.value.has_value() || parameter.binding.has_value();
}

bool valid_saved_postprocess_effect(const CompiledProject& project, const SaveState& save,
                                    const SavedPostprocessEffect& effect) noexcept
{
    const auto* interface = project.find_material_interface(effect.material);
    return valid_saved_owner(project, save, effect.owner) && interface != nullptr &&
           interface->role == compiled::MaterialRole::Postprocess &&
           interface->postprocess_scope == effect.scope &&
           effect.scope <= compiled::MaterialPostprocessScope::FullGameViewport &&
           effect.clock <= MaterialClockPolicy::UnscaledPresentation;
}

bool valid_background_record(const CompiledProject& project,
                             const compiled::BackgroundPresentation& value) noexcept
{
    return value.fit <= compiled::BackgroundFit::Center &&
           (!value.asset || project.find_asset(*value.asset) != nullptr);
}

bool valid_actor_character_state(const CompiledProject& project, const SaveState& save,
                                 const SavedActorPresentation& actor) noexcept
{
    auto character = resolved_character(project, save, actor.character);
    if (!character || !std::isfinite(actor.placement.offset.x) ||
        !std::isfinite(actor.placement.offset.y) || !std::isfinite(actor.placement.scale) ||
        actor.placement.scale <= 0.0 || actor.placement.position > compiled::ActorPosition::Custom)
        return false;
    const auto profile = std::find_if(character->profiles.begin(), character->profiles.end(),
                                      [&](const auto& value) { return value.id == actor.profile; });
    if (profile == character->profiles.end())
        return false;
    const auto pose = std::find_if(
        profile->poses.begin(), profile->poses.end(),
        [&actor](const compiled::CharacterPose& value) { return value.id == actor.pose; });
    if (pose == profile->poses.end())
        return false;
    const auto expression =
        std::find_if(character->expressions.begin(), character->expressions.end(),
                     [&actor](const compiled::CharacterExpression& value) {
                         return value.id == actor.expression;
                     });
    const bool idle_valid =
        !actor.idle || std::any_of(character->idles.begin(), character->idles.end(),
                                   [&actor](const compiled::CharacterIdle& value) {
                                       return value.id == *actor.idle;
                                   });
    const bool appearance_valid =
        !actor.appearance ||
        std::any_of(character->appearances.begin(), character->appearances.end(),
                    [&actor](const compiled::CharacterAppearance& value) {
                        return value.id == *actor.appearance;
                    });
    return expression != character->expressions.end() && appearance_valid && idle_valid;
}

bool valid_actor_record(const CompiledProject& project, const SaveState& save,
                        const SavedActorPresentation& actor) noexcept
{
    if (!valid_saved_owner(project, save, actor.owner) ||
        !valid_actor_character_state(project, save, actor))
        return false;
    return std::visit(
        [&project, &save, &actor](const auto& key) {
            using T = std::decay_t<decltype(key)>;
            if constexpr (std::is_same_v<T, CharacterActorKey>) {
                return key.character == actor.character;
            } else if constexpr (std::is_same_v<T, RoomCastActorKey>) {
                const auto* owner = std::get_if<SavedRoomPresentationOwner>(&actor.owner);
                auto room = resolved_room(project, save, key.room);
                if (owner == nullptr || owner->room != key.room || !room)
                    return false;
                const auto found = std::find_if(
                    room->cast.begin(), room->cast.end(),
                    [&key](const compiled::RoomCastEntry& value) { return value.id == key.entry; });
                return found != room->cast.end() && found->character == actor.character;
            } else if constexpr (std::is_same_v<T, SavedSceneActorKey>) {
                const auto* owner = std::get_if<SavedScenePresentationOwner>(&actor.owner);
                const auto* scene = project.find_scene(key.owner.scene);
                if (owner == nullptr || *owner != key.owner || scene == nullptr)
                    return false;
                return std::any_of(
                    scene->program.instructions.begin(), scene->program.instructions.end(),
                    [&key, &actor](const compiled::SceneInstruction& instruction) {
                        const auto* cue = std::get_if<compiled::ActorCueInstruction>(&instruction);
                        return cue != nullptr && cue->slot_id == key.slot &&
                               cue->character == actor.character;
                    });
            } else {
                return true;
            }
        },
        actor.key);
}

bool valid_prop_record(const CompiledProject& project, const SaveState& save,
                       const SavedPresentationProp& prop) noexcept
{
    if (!valid_saved_owner(project, save, prop.owner) ||
        (prop.asset && project.find_asset(*prop.asset) == nullptr) ||
        prop.plane > PresentationPlane::Debug || !std::isfinite(prop.bounds.x) ||
        !std::isfinite(prop.bounds.y) || !std::isfinite(prop.bounds.width) ||
        !std::isfinite(prop.bounds.height) || prop.bounds.width < 0.0 || prop.bounds.height < 0.0)
        return false;
    if (!prop.placement)
        return true;
    auto room = resolved_room(project, save, prop.placement->room);
    return room && std::any_of(room->placements.begin(), room->placements.end(),
                               [&prop](const compiled::RoomPlacement& value) {
                                   return value.id == prop.placement->placement_id;
                               });
}

bool valid_environment_record(const CompiledProject& project, const SaveState& save,
                              const SavedPresentationEnvironment& value) noexcept
{
    const auto* asset = value.asset ? project.find_asset(*value.asset) : nullptr;
    return valid_saved_owner(project, save, value.owner) &&
           (!value.asset || (asset != nullptr && asset->kind == compiled::AssetKind::Image)) &&
           value.plane >= PresentationPlane::WorldBackground &&
           value.plane <= PresentationPlane::WorldOverlay &&
           value.clock <= LayoutClockDomain::UnscaledPresentation &&
           std::isfinite(value.bounds.x) && std::isfinite(value.bounds.y) &&
           std::isfinite(value.bounds.width) && std::isfinite(value.bounds.height) &&
           value.bounds.x >= 0.0 && value.bounds.y >= 0.0 && value.bounds.width > 0.0 &&
           value.bounds.height > 0.0 && value.bounds.x + value.bounds.width <= 1.0 &&
           value.bounds.y + value.bounds.height <= 1.0 &&
           std::isfinite(value.scroll_per_second.x) && std::isfinite(value.scroll_per_second.y) &&
           std::isfinite(value.opacity) && value.opacity >= 0.0 && value.opacity <= 1.0;
}

bool valid_policy(const MountedLayoutPolicy& policy) noexcept
{
    return policy.plane <= PresentationPlane::Debug &&
           policy.clock <= LayoutClockDomain::UnscaledPresentation &&
           policy.input <= LayoutInputMode::Modal &&
           policy.gameplay_pause <= GameplayPausePolicy::PauseWhileVisible &&
           policy.visibility <= LayoutVisibility::Visible &&
           policy.escape_dismissal <= EscapeDismissalPolicy::Dismiss &&
           !policy.entrance_operation && !policy.exit_operation;
}

bool valid_scale_overrides(const LayoutScaleOverrides& overrides) noexcept
{
    return (!overrides.ui || *overrides.ui <= LayoutScaleInheritance::Ignore) &&
           (!overrides.text || *overrides.text <= LayoutScaleInheritance::Ignore);
}

bool valid_layout_record(const CompiledProject& project, const SaveState& save,
                         const SavedMountedLayout& layout) noexcept
{
    if (!valid_saved_owner(project, save, layout.owner) ||
        project.find_layout(layout.layout) == nullptr || !valid_policy(layout.policy) ||
        !valid_scale_overrides(layout.scale_overrides) ||
        layout.composition_group > PresentationCompositionGroup::Debug)
        return false;
    return std::visit(
        [&project, &save, &layout](const auto& key) {
            using T = std::decay_t<decltype(key)>;
            if constexpr (std::is_same_v<T, ReservedLayoutMountKey>) {
                return key.slot <= compiled::LayoutSlot::Custom;
            } else if constexpr (std::is_same_v<T, RoomOverlayLayoutMountKey>) {
                const auto* owner = std::get_if<SavedRoomPresentationOwner>(&layout.owner);
                auto room = resolved_room(project, save, key.room);
                if (owner == nullptr || owner->room != key.room || !room ||
                    layout.policy.plane != PresentationPlane::WorldOverlay ||
                    layout.composition_group != PresentationCompositionGroup::World)
                    return false;
                const auto found = std::find_if(
                    room->overlays.begin(), room->overlays.end(),
                    [&key](const compiled::RoomOverlay& value) { return value.id == key.overlay; });
                return found != room->overlays.end() && found->layout == layout.layout;
            } else {
                return true;
            }
        },
        layout.key);
}

std::string saved_layout_state_owner_key(const SavedLayoutStateScopeOwner& owner)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedVisitLayoutStateOwner>)
                return std::string("visit:") + value.room.text();
            else if constexpr (std::is_same_v<T, SavedRoomLayoutStateOwner>)
                return std::string("room:") + value.room.text();
            else if constexpr (std::is_same_v<T, SavedFlowLayoutStateOwner>)
                return std::string("flow:") + std::to_string(value.flow.value);
            else
                return std::string("session");
        },
        owner);
}

bool valid_layout_state_record(const CompiledProject& project, const SaveState& save,
                               const SavedLayoutStateSlot& slot) noexcept
{
    const auto* layout = project.find_layout(slot.layout);
    if (!layout || !layout->contract.state ||
        !persistable_value_matches(*layout->contract.state, slot.value))
        return false;
    const bool key_valid = std::visit(
        [&](const auto& key) {
            using T = std::decay_t<decltype(key)>;
            if constexpr (std::is_same_v<T, ReservedLayoutMountKey>) {
                return key.slot <= compiled::LayoutSlot::Custom;
            } else if constexpr (std::is_same_v<T, RoomOverlayLayoutMountKey>) {
                auto room = resolved_room(project, save, key.room);
                if (!room)
                    return false;
                const auto overlay = std::find_if(
                    room->overlays.begin(), room->overlays.end(),
                    [&](const compiled::RoomOverlay& value) { return value.id == key.overlay; });
                if (overlay == room->overlays.end() || overlay->layout != slot.layout)
                    return false;
                if (const auto* owner = std::get_if<SavedRoomLayoutStateOwner>(&slot.scope_owner))
                    return owner->room == key.room;
                return std::holds_alternative<SavedSessionLayoutStateOwner>(slot.scope_owner);
            } else {
                return true;
            }
        },
        slot.key);
    if (!key_valid)
        return false;
    return std::visit(
        [&](const auto& owner) {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, SavedVisitLayoutStateOwner>) {
                return save.active_room_visit && save.active_room_visit->room == owner.room;
            } else if constexpr (std::is_same_v<T, SavedRoomLayoutStateOwner>) {
                return resolved_room(project, save, owner.room).has_value();
            } else if constexpr (std::is_same_v<T, SavedFlowLayoutStateOwner>) {
                return saved_frame(save, owner.flow) != nullptr;
            } else {
                return true;
            }
        },
        slot.scope_owner);
}

bool valid_desired_audio_record(const CompiledProject& project, const SaveState& save,
                                const SavedDesiredAudio& audio) noexcept
{
    const auto* asset = project.find_asset(audio.asset);
    const bool pan_source_valid =
        !audio.pan_source ||
        std::visit(
            [&](const auto& source) {
                using T = std::decay_t<decltype(source)>;
                if constexpr (std::is_same_v<T, compiled::SceneActorAudioPanSource>) {
                    const auto* scene_owner =
                        std::get_if<SavedScenePresentationOwner>(&audio.owner);
                    return scene_owner &&
                           std::ranges::any_of(
                               save.actors, [&](const SavedActorPresentation& actor) {
                                   const auto* key = std::get_if<SavedSceneActorKey>(&actor.key);
                                   return key && key->owner == *scene_owner &&
                                          key->slot == source.slot;
                               });
                } else {
                    const auto* room = project.find_room(source.room);
                    return room && std::ranges::any_of(room->anchors,
                                                       [&](const compiled::RoomAnchor& anchor) {
                                                           return anchor.id == source.anchor;
                                                       });
                }
            },
            *audio.pan_source);
    return valid_saved_owner(project, save, audio.owner) &&
           (audio.purpose == compiled::AudioPurpose::Music ||
            audio.purpose == compiled::AudioPurpose::Ambience) &&
           audio.pause_policy <= compiled::AudioPausePolicy::Unscaled && asset != nullptr &&
           asset->kind == compiled::AssetKind::Audio && std::isfinite(audio.gain) &&
           audio.gain >= 0.0 && audio.gain <= 1.0 && std::isfinite(audio.pan) &&
           audio.pan >= -1.0 && audio.pan <= 1.0 && pan_source_valid &&
           audio.fade_in.count() >= 0 && audio.fade_out.count() >= 0;
}

bool valid_presented_text(const CompiledProject& project, const SaveState& save,
                          const std::optional<PresentedTextState>& text) noexcept
{
    return !text || (text->markup <= TextMarkup::ActiveText &&
                     (!text->speaker || resolved_character(project, save, *text->speaker)));
}

bool valid_active_choice(const CompiledProject& project,
                         const std::optional<ActiveChoiceState>& choice) noexcept
{
    if (!choice)
        return true;
    return std::visit(
        [&project](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneChoiceState>) {
                const auto* scene = project.find_scene(value.scene);
                const auto* instruction =
                    scene ? instruction_by_id(scene->program.instructions, value.step) : nullptr;
                const auto* definition =
                    instruction ? std::get_if<compiled::ChoiceSceneInstruction>(instruction)
                                : nullptr;
                if (definition == nullptr || value.options.empty())
                    return false;
                std::unordered_set<std::string> seen;
                return std::all_of(
                    value.options.begin(), value.options.end(),
                    [&definition, &seen](const SceneChoiceOptionState& option) {
                        return seen.insert(option.option.text()).second &&
                               std::any_of(definition->options.begin(), definition->options.end(),
                                           [&option](const compiled::SceneChoiceOption& candidate) {
                                               return candidate.id == option.option;
                                           });
                    });
            } else {
                const auto* dialogue = project.find_dialogue(value.dialogue);
                const auto* block = dialogue ? dialogue_block(*dialogue, value.block) : nullptr;
                if (block == nullptr ||
                    !std::holds_alternative<compiled::DialogueChoiceBlock>(*block) ||
                    value.options.empty())
                    return false;
                std::unordered_set<std::string> seen;
                return std::all_of(
                    value.options.begin(), value.options.end(),
                    [&dialogue, &value, &seen](const DialogueChoiceOptionState& option) {
                        const auto* edge = dialogue_edge(*dialogue, option.edge);
                        const auto* choice_edge =
                            edge ? std::get_if<compiled::DialogueChoiceEdge>(edge) : nullptr;
                        return option.markup <= TextMarkup::ActiveText &&
                               seen.insert(option.edge.text()).second && choice_edge != nullptr &&
                               choice_edge->from_block_id == value.block;
                    });
            }
        },
        *choice);
}

Result<void, Diagnostics> validate_save_state_impl(const CompiledProject& project,
                                                   const SaveState& save, std::string source_path)
{
    Diagnostics diagnostics;
    const auto error = [&diagnostics, &source_path](std::string code, std::string message) {
        diagnostics.push_back(Diagnostic{
            .code = std::move(code), .message = std::move(message), .source_path = source_path});
    };
    if (save.metadata.project != project.identity().id)
        error("save_codec.project_mismatch", "Save metadata does not match the loaded project.");
    if (save.metadata.save_contract != project.save_contract())
        error("save_codec.contract_mismatch",
              "Save Contract does not match the loaded compiled project.");
    if (save.play_time.count() < 0)
        error("save_codec.invalid_time", "Play time cannot be negative.");
    if (save.next_runtime_instance_id == 0)
        error("save_codec.invalid_runtime_allocator",
              "Runtime Gameplay Instance allocator position must be positive.");
    if (save.next_item_stack_id == 0)
        error("save_codec.invalid_item_stack_allocator",
              "Item Stack identity allocator position must be positive.");

    std::unordered_set<std::uint64_t> runtime_ordinals;
    const auto validate_runtime_identity = [&](std::string_view text, std::string_view prefix,
                                               bool declared) {
        if (declared)
            return;
        const auto ordinal = runtime_ordinal(text, prefix);
        if (!ordinal || *ordinal >= save.next_runtime_instance_id ||
            !runtime_ordinals.insert(*ordinal).second)
            error("save_codec.invalid_runtime_identity",
                  "Runtime-created Gameplay Instance identity is invalid, reused, or beyond the "
                  "saved allocator position.");
    };
    const auto validate_provenance = [&](const RuntimeInstanceProvenance& provenance, bool declared,
                                         compiled::GameplayInstanceKind kind) {
        if (declared != (provenance.kind == RuntimeInstanceProvenanceKind::Declared))
            error("save_codec.invalid_runtime_provenance",
                  "Gameplay Instance declared state and provenance disagree.");
        if (provenance.kind == RuntimeInstanceProvenanceKind::Archetype) {
            const auto* archetype =
                provenance.archetype ? project.find_archetype(*provenance.archetype) : nullptr;
            if (archetype == nullptr || archetype->kind != kind || provenance.source_instance)
                error("save_codec.invalid_runtime_provenance",
                      "Archetype provenance is missing or incompatible with the instance kind.");
        } else if (provenance.archetype) {
            error("save_codec.invalid_runtime_provenance",
                  "Only Archetype-created instances may carry Archetype provenance.");
        }
        if (provenance.kind == RuntimeInstanceProvenanceKind::CompiledDefinition ||
            provenance.kind == RuntimeInstanceProvenanceKind::Clone) {
            const bool source_required = provenance.kind == RuntimeInstanceProvenanceKind::Clone ||
                                         kind != compiled::GameplayInstanceKind::Interactable;
            if (source_required && !provenance.source_instance)
                error("save_codec.invalid_runtime_provenance",
                      "Definition/clone provenance requires a typed source identity.");
            else if (provenance.source_instance) {
                const bool same_kind = std::visit(
                    [kind](const auto& source) {
                        using T = std::decay_t<decltype(source)>;
                        return (kind == compiled::GameplayInstanceKind::Room &&
                                std::is_same_v<T, RoomId>) ||
                               (kind == compiled::GameplayInstanceKind::Character &&
                                std::is_same_v<T, CharacterId>) ||
                               (kind == compiled::GameplayInstanceKind::Interactable &&
                                std::is_same_v<T, InteractableInstanceId>);
                    },
                    *provenance.source_instance);
                if (!same_kind)
                    error("save_codec.invalid_runtime_provenance",
                          "Gameplay Instance provenance source has the wrong typed identity.");
            }
        } else if (provenance.source_instance) {
            error("save_codec.invalid_runtime_provenance",
                  "This Gameplay Instance provenance kind cannot carry a source identity.");
        }
    };

    std::unordered_set<std::string> runtime_room_ids;
    for (const auto& record : save.runtime_rooms) {
        if (!runtime_room_ids.insert(record.id.text()).second)
            error("save_codec.duplicate_runtime_instance",
                  "Runtime Room configuration appears more than once.");
        const bool declared = project.find_room(record.id) != nullptr;
        if (record.declared != declared)
            error("save_codec.invalid_runtime_instance",
                  "Runtime Room declared flag does not match compiled Project identity.");
        auto birth = materialize_room_source(project, record.birth_source, record.id);
        if (!birth)
            error("save_codec.invalid_runtime_configuration",
                  "Runtime Room birth configuration source is invalid or wrong-kind.");
        if (record.structural_override_source &&
            !materialize_room_source(project, *record.structural_override_source, record.id))
            error("save_codec.invalid_runtime_configuration",
                  "Runtime Room structural override source is invalid or wrong-kind.");
        if (!record.structural_override_source &&
            !record.structural_override_exit_target_overrides.empty())
            error("save_codec.invalid_runtime_configuration",
                  "Room replacement-source topology edits require a structural override source.");
        if (declared) {
            const auto* source = std::get_if<CompiledRoomConfigurationSource>(&record.birth_source);
            if (source == nullptr || source->room != record.id ||
                !record.birth_exit_target_overrides.empty())
                error(
                    "save_codec.invalid_runtime_configuration",
                    "Declared Room birth configuration must be its immutable compiled definition.");
        }
        validate_runtime_identity(record.id.text(), "runtime-room-", declared);
        validate_provenance(record.provenance, declared, compiled::GameplayInstanceKind::Room);
        const auto validate_edits = [&](const std::vector<RuntimeRoomExitTargetOverride>& edits) {
            std::unordered_set<std::string> exit_ids;
            for (const auto& edit : edits) {
                if (!exit_ids.insert(edit.exit.text()).second ||
                    saved_room(save, edit.target) == nullptr)
                    error("save_codec.invalid_runtime_topology",
                          "Room topology edit is duplicate or targets a non-live Room identity.");
            }
        };
        validate_edits(record.birth_exit_target_overrides);
        validate_edits(record.structural_override_exit_target_overrides);
        validate_edits(record.exit_target_overrides);
        if (!resolved_room(project, save, record.id))
            error("save_codec.invalid_runtime_configuration",
                  "Runtime Room effective configuration cannot be reconstructed.");
    }
    for (const auto& room : project.rooms()) {
        const auto* record = saved_room(save, room.identity.id);
        if (record == nullptr || !record->declared)
            error("save_codec.incomplete_runtime_world",
                  "Save must retain every declared Room Gameplay Instance.");
    }

    std::unordered_set<std::string> runtime_character_ids;
    for (const auto& record : save.runtime_characters) {
        if (!runtime_character_ids.insert(record.id.text()).second)
            error("save_codec.duplicate_runtime_instance",
                  "Runtime Character configuration appears more than once.");
        const bool declared = project.find_character(record.id) != nullptr;
        if (record.declared != declared)
            error("save_codec.invalid_runtime_instance",
                  "Runtime Character declared flag does not match compiled Project identity.");
        if (!materialize_character_source(project, record.birth_source, record.id) ||
            (record.structural_override_source &&
             !materialize_character_source(project, *record.structural_override_source, record.id)))
            error("save_codec.invalid_runtime_configuration",
                  "Runtime Character configuration source is invalid or wrong-kind.");
        if (declared) {
            const auto* source =
                std::get_if<CompiledCharacterConfigurationSource>(&record.birth_source);
            if (source == nullptr || source->character != record.id)
                error("save_codec.invalid_runtime_configuration",
                      "Declared Character birth configuration must be its compiled definition.");
        }
        validate_runtime_identity(record.id.text(), "runtime-character-", declared);
        validate_provenance(record.provenance, declared, compiled::GameplayInstanceKind::Character);
    }
    for (const auto& character : project.characters()) {
        const auto* record = saved_character(save, character.identity.id);
        if (record == nullptr || !record->declared)
            error("save_codec.incomplete_runtime_world",
                  "Save must retain every declared Character Gameplay Instance.");
    }

    std::unordered_set<std::string> runtime_interactable_ids;
    for (const auto& record : save.runtime_interactables) {
        if (!runtime_interactable_ids.insert(record.id.text()).second)
            error("save_codec.duplicate_runtime_instance",
                  "Runtime Interactable configuration appears more than once.");
        const auto* declaration = project.find_interactable_instance(record.id);
        const bool declared = declaration != nullptr;
        if (record.declared != declared)
            error("save_codec.invalid_runtime_instance",
                  "Runtime Interactable declared flag does not match compiled Project identity.");
        if (!materialize_interactable_source(project, record.birth_source, record.id) ||
            (record.structural_override_source &&
             !materialize_interactable_source(project, *record.structural_override_source,
                                              record.id)))
            error("save_codec.invalid_runtime_configuration",
                  "Runtime Interactable configuration source is invalid or wrong-kind.");
        if (declared) {
            const auto* source =
                std::get_if<CompiledInteractableConfigurationSource>(&record.birth_source);
            if (source == nullptr || source->definition != declaration->definition)
                error("save_codec.invalid_runtime_configuration",
                      "Declared Interactable birth configuration must be its compiled definition.");
        }
        validate_runtime_identity(record.id.text(), "runtime-interactable-", declared);
        validate_provenance(record.provenance, declared,
                            compiled::GameplayInstanceKind::Interactable);
    }
    // Declared Interactable identities may end through explicit destruction or a quantity mutation
    // that reduces them to zero. Their authored declaration remains the structural reference
    // universe, while omission from the saved live Runtime World is the tombstone/non-live state.

    std::unordered_set<std::string> overrides;
    for (const auto& item : save.property_overrides) {
        const auto key = std::to_string(item.target.index()) + ":" + target_text(item.target) +
                         ":" + item.property.text();
        const auto owner = property_target_owner(item.target);
        const auto definition =
            owner ? resolved_property_definition(project, save, *owner, item.property)
            : project.find_property(item.property)
                ? std::optional<PropertyDefinition>{*project.find_property(item.property)}
                : std::nullopt;
        if (!overrides.insert(key).second)
            error("save_codec.duplicate_record", "Property override appears more than once.");
        const bool valid_value =
            definition
                ? static_cast<bool>(make_property_override(item.target, *definition, item.value))
                : static_cast<bool>(
                      make_dynamic_property_override(item.target, item.property, item.value));
        if (!target_exists(project, save, item.target) || !valid_value)
            error("save_codec.invalid_property_override",
                  "Property override is not permitted by the loaded project.");
    }
    std::unordered_set<std::string> interactables;
    for (const auto& item : save.interactables) {
        if (!interactables.insert(item.interactable.text()).second)
            error("save_codec.duplicate_record", "Interactable state appears more than once.");
        const auto configuration = resolved_interactable(project, save, item.interactable);
        if (!configuration || !valid_location(project, save, item.location))
            error("save_codec.invalid_interactable",
                  "Interactable state has an invalid reference or location.");
        else if (item.quantity == 0 || item.quantity > compiled::max_interactable_quantity ||
                 (!configuration->stackable && item.quantity != 1) ||
                 (configuration->stack_limit && item.quantity > *configuration->stack_limit))
            error("save_codec.invalid_interactable_quantity",
                  "Interactable state has an invalid quantity for its effective definition.");
        if (item.dynamic_room_occurrence) {
            const auto* room_location = std::get_if<compiled::RoomLocation>(&item.location);
            if (room_location == nullptr ||
                room_location->room != item.dynamic_room_occurrence->room) {
                error("save_codec.invalid_interactable_occurrence",
                      "Dynamic Interactable occurrence must belong to the semantic Room Location.");
            } else {
                auto room = resolved_room(project, save, item.dynamic_room_occurrence->room);
                if (!room || std::ranges::none_of(room->placements, [&](const auto& placement) {
                        return placement.id == item.dynamic_room_occurrence->placement;
                    }))
                    error("save_codec.invalid_interactable_occurrence",
                          "Dynamic Interactable occurrence references a missing Room placement.");
            }
        }
    }
    if (save.interactables.size() != save.runtime_interactables.size())
        error("save_codec.incomplete_interactables",
              "Save must contain state for every live Interactable Gameplay Instance.");
    std::unordered_set<std::string> item_stack_ids;
    std::unordered_set<std::uint64_t> item_stack_ordinals;
    for (const auto& item : save.item_stacks) {
        if (!item_stack_ids.insert(item.id.text()).second)
            error("save_codec.duplicate_record", "Item Stack state appears more than once.");
        const auto* definition = project.find_item_definition(item.definition);
        if (definition == nullptr || item.quantity == 0 ||
            item.quantity > compiled::max_item_stack_quantity ||
            (definition->stack_limit && item.quantity > *definition->stack_limit) ||
            !valid_location(project, save, item.location))
            error("save_codec.invalid_item_stack",
                  "Item Stack has an invalid definition, quantity, or Location.");
        if (!item.traits.empty())
            error("save_codec.invalid_item_stack_trait",
                  "Item Stacks cannot carry Traits or identity Properties.");
        const auto* declared = project.find_item_stack(item.id);
        if (item.declared != (declared != nullptr))
            error("save_codec.invalid_item_stack",
                  "Item Stack declared flag does not match compiled Project identity.");
        if (declared != nullptr) {
            if (item.definition != declared->definition)
                error("save_codec.invalid_item_stack",
                      "Declared Item Stack cannot change its Item Definition.");
        } else {
            const auto ordinal = runtime_ordinal(item.id.text(), "runtime-item-stack-");
            if (!ordinal || *ordinal >= save.next_item_stack_id ||
                !item_stack_ordinals.insert(*ordinal).second)
                error("save_codec.invalid_item_stack_identity",
                      "Runtime-created Item Stack identity is invalid, reused, or beyond the saved "
                      "allocator position.");
        }
    }
    for (const auto& start : save.interactables) {
        std::unordered_set<InteractableInstanceId> visited;
        visited.insert(start.interactable);
        const InteractableState* current = &start;
        while (const auto* location =
                   std::get_if<compiled::InventoryLocation>(&current->location)) {
            const auto owner = inventory_interactable_owner(location->inventory);
            if (!owner)
                break;
            if (!visited.insert(*owner).second) {
                error("save_codec.inventory_containment_cycle",
                      "Saved Inventory containment must be acyclic.");
                break;
            }
            const auto found = std::find_if(save.interactables.begin(), save.interactables.end(),
                                            [&](const InteractableState& candidate) {
                                                return candidate.interactable == *owner;
                                            });
            if (found == save.interactables.end())
                break;
            current = &*found;
        }
    }
    std::unordered_set<std::string> characters;
    for (const auto& item : save.characters) {
        if (!characters.insert(item.character.text()).second)
            error("save_codec.duplicate_record", "Character world state appears more than once.");
        if (!resolved_character(project, save, item.character) ||
            !valid_character_location(project, save, item.location))
            error("save_codec.invalid_character",
                  "Character world state has an invalid reference or location.");
    }
    if (save.characters.size() != save.runtime_characters.size())
        error("save_codec.incomplete_characters",
              "Save must contain state for every live Character Gameplay Instance.");
    std::unordered_set<std::string> room_history;
    for (const auto& item : save.room_visits) {
        if (!room_history.insert(item.room.text()).second ||
            !resolved_room(project, save, item.room))
            error("save_codec.invalid_room_history", "Room history is duplicate or stale.");
    }
    if (save.active_room_visit) {
        const auto& visit = *save.active_room_visit;
        if (visit.entry_sequence != save.room_entry_sequence ||
            !valid_room_visit_context(project, save, visit, true))
            error("save_codec.invalid_active_room_visit",
                  "Active Room context is stale or inconsistent with Room history and Entry "
                  "Sequence.");
    } else if (save.room_entry_sequence != 0) {
        error("save_codec.invalid_room_entry_sequence",
              "Room Entry Sequence requires an authoritative Active Room Context.");
    }
    if (const auto* room_mode = std::get_if<RoomMode>(&save.mode);
        room_mode && (!save.active_room_visit || save.active_room_visit->room != room_mode->room))
        error("save_codec.missing_active_room_visit",
              "Room mode requires matching authoritative active Room visit context.");
    std::unordered_set<std::string> line_history;
    for (const auto& item : save.dialogue_line_history) {
        const auto* dialogue = project.find_dialogue(item.key.dialogue);
        bool found = false;
        if (dialogue)
            for (const auto& block_item : dialogue->program.blocks)
                if (dialogue_segment(block_item, item.key.segment))
                    found = true;
        const auto key = item.key.dialogue.text() + ":" + item.key.segment.text();
        if (!line_history.insert(key).second || !found)
            error("save_codec.invalid_dialogue_history",
                  "Dialogue line history is duplicate or stale.");
    }
    std::unordered_set<std::string> choice_history;
    for (const auto& item : save.dialogue_choice_history) {
        const auto* dialogue = project.find_dialogue(item.key.dialogue);
        const auto* edge = dialogue ? dialogue_edge(*dialogue, item.key.edge) : nullptr;
        const auto key = item.key.dialogue.text() + ":" + item.key.edge.text();
        if (!choice_history.insert(key).second || !edge ||
            !std::holds_alternative<compiled::DialogueChoiceEdge>(*edge))
            error("save_codec.invalid_dialogue_history",
                  "Dialogue choice history is duplicate or stale.");
    }
    for (const auto& entry : save.text_log) {
        if (entry.kind > TextLogEntryKind::Notification || entry.markup > TextMarkup::ActiveText) {
            error("save_codec.invalid_text_log", "Text log entry has an invalid discriminant.");
            continue;
        }
        bool origin_ok = std::visit(
            [&project](const auto& item) {
                using T = std::decay_t<decltype(item)>;
                if constexpr (std::is_same_v<T, SystemTextLogOrigin>)
                    return true;
                else if constexpr (std::is_same_v<T, SceneTextLogOrigin>) {
                    const auto* scene = project.find_scene(item.scene);
                    return scene && has_scene_step(*scene, item.step);
                } else if constexpr (std::is_same_v<T, DialogueLineTextLogOrigin>) {
                    const auto* dialogue = project.find_dialogue(item.dialogue);
                    if (!dialogue)
                        return false;
                    for (const auto& block : dialogue->program.blocks)
                        if (dialogue_segment(block, item.segment))
                            return true;
                    return false;
                } else if constexpr (std::is_same_v<T, DialogueChoiceTextLogOrigin>) {
                    const auto* dialogue = project.find_dialogue(item.dialogue);
                    return dialogue && dialogue_edge(*dialogue, item.edge) &&
                           std::holds_alternative<compiled::DialogueChoiceEdge>(
                               *dialogue_edge(*dialogue, item.edge));
                } else {
                    const auto* interaction = project.find_interaction(item.interaction);
                    if (!interaction)
                        return false;
                    for (const auto& rule : interaction->rules)
                        if (has_interaction_instruction(rule.program, item.instruction))
                            return true;
                    return false;
                }
            },
            entry.origin);
        if (!origin_ok || (entry.speaker && !resolved_character(project, save, *entry.speaker)))
            error("save_codec.invalid_text_log", "Text log entry has a stale origin or speaker.");
    }
    std::unordered_set<std::uint64_t> timer_ids;
    for (const auto& item : save.logical_timers)
        if (item.id.value == 0 || item.remaining.count() < 0 ||
            (item.repeat_interval && item.repeat_interval->count() <= 0) ||
            !timer_ids.insert(item.id.value).second)
            error("save_codec.invalid_timer", "Logical timer record is invalid or duplicated.");
    std::unordered_set<std::uint64_t> completion_ids;
    for (const auto& item : save.pending_timer_completions)
        if (item.id.value == 0 || item.occurrences == 0 ||
            !completion_ids.insert(item.id.value).second)
            error("save_codec.invalid_timer", "Timer completion record is invalid or duplicated.");
    const bool flow_mode = std::holds_alternative<FlowMode>(save.mode);
    if (flow_mode != !save.flow_stack.empty())
        error("save_codec.incoherent_flow", "Runtime mode and flow stack do not agree.");
    if (const auto* room = std::get_if<RoomMode>(&save.mode);
        room && !resolved_room(project, save, room->room))
        error("save_codec.invalid_reference", "Room mode references an unknown Room.");
    std::unordered_set<std::uint64_t> frame_ids;
    for (std::size_t item_index = 0; item_index < save.flow_stack.size(); ++item_index) {
        const auto& frame = save.flow_stack[item_index];
        const auto valid = std::visit(
            [&project, &save](const auto& item) {
                using T = std::decay_t<decltype(item)>;
                if (!valid_destination(project, save, item.destination))
                    return false;
                if constexpr (std::is_same_v<T, SavedSceneFrame>) {
                    const auto* scene = project.find_scene(item.scene);
                    return scene && valid_scene_position(*scene, item.position) &&
                           valid_scene_inputs(*scene, item.inputs);
                } else if constexpr (std::is_same_v<T, SavedDialogueFrame>) {
                    const auto* dialogue = project.find_dialogue(item.dialogue);
                    return dialogue && valid_dialogue_position(*dialogue, item.position) &&
                           valid_dialogue_presentation_state(project, save, *dialogue, item);
                } else if constexpr (std::is_same_v<T, SavedInteractionFrame>) {
                    const auto* program = interaction_program(project, item.program);
                    const auto* verb = project.find_verb(item.invocation.verb);
                    std::unordered_set<VerbSlotId> binding_slots;
                    const bool bindings_valid =
                        verb && item.invocation.bindings.size() == verb->slots.size() &&
                        std::all_of(
                            item.invocation.bindings.begin(), item.invocation.bindings.end(),
                            [&project, &save, verb,
                             &binding_slots](const InteractionSubjectBinding& binding) {
                                const bool known_slot = std::any_of(
                                    verb->slots.begin(), verb->slots.end(),
                                    [&](const auto& slot) { return slot.id == binding.slot_id; });
                                if (!known_slot || !binding_slots.insert(binding.slot_id).second)
                                    return false;
                                return std::visit(
                                    [&project, &save](const auto& value) {
                                        using S = std::decay_t<decltype(value)>;
                                        if constexpr (std::is_same_v<
                                                          S, compiled::CharacterInteractionSubject>)
                                            return resolved_character(project, save,
                                                                      value.character)
                                                .has_value();
                                        else if constexpr (
                                            std::is_same_v<
                                                S, compiled::InteractableInteractionSubject>)
                                            return resolved_interactable(project, save,
                                                                         value.interactable)
                                                .has_value();
                                        else if constexpr (std::is_same_v<
                                                               S,
                                                               compiled::FeatureInteractionSubject>)
                                            return std::visit(
                                                [&project, &save](const auto& reference) {
                                                    return feature_exists(project, save, reference);
                                                },
                                                value.feature);
                                        else
                                            return std::ranges::any_of(
                                                save.item_stacks, [&](const auto& stack) {
                                                    return stack.id == value.item_stack;
                                                });
                                    },
                                    binding.subject);
                            });
                    return program && bindings_valid &&
                           (!item.position.next_instruction ||
                            has_interaction_instruction(*program,
                                                        *item.position.next_instruction)) &&
                           item.position.fallback_stage <= InteractionFallbackStage::Complete &&
                           item.position.outcome <= InteractionExecutionOutcome::Failed &&
                           (!item.position.awaiting_completion ||
                            item.position.next_instruction.has_value());
                } else {
                    if (!resolved_room(project, save, item.target_room) ||
                        (item.source_room && !resolved_room(project, save, *item.source_room)) ||
                        !valid_room_position(project, save, item) ||
                        item.kind > RoomTransitionKind::DirectedRoomChange ||
                        item.entry_cause > RoomEntryCause::DirectedRoomChange)
                        return false;
                    if (item.source_context &&
                        (!item.source_room || item.source_context->room != *item.source_room ||
                         !valid_room_visit_context(project, save, *item.source_context, false)))
                        return false;
                    if (item.source_room.has_value() != item.source_context.has_value())
                        return false;

                    if (item.kind == RoomTransitionKind::NavigationAttempt) {
                        if (item.entry_cause != RoomEntryCause::NavigationAttempt ||
                            !item.source_room || !item.selected_exit)
                            return false;
                        auto room = resolved_room(project, save, item.selected_exit->room);
                        if (!room || item.selected_exit->room != *item.source_room)
                            return false;
                        const auto found =
                            std::find_if(room->exits.begin(), room->exits.end(),
                                         [&item](const compiled::RoomExit& exit) {
                                             return exit.id == item.selected_exit->exit_id;
                                         });
                        return found != room->exits.end() && found->target == item.target_room;
                    }

                    if (item.selected_exit || item.entry_cause == RoomEntryCause::NavigationAttempt)
                        return false;
                    if (item.entry_cause == RoomEntryCause::Entrypoint)
                        return !item.source_room && !item.source_context;
                    return item.entry_cause == RoomEntryCause::DirectedRoomChange;
                }
            },
            frame);
        const auto snapshot =
            std::visit([](const auto& value) { return value.snapshot_id.value; }, frame);
        if (snapshot == 0 || !frame_ids.insert(snapshot).second || !valid)
            error("save_codec.invalid_flow_frame",
                  "Flow frame is stale, duplicate, or incoherent.");
        const auto destination = std::visit(
            [](const auto& value) -> const ReturnDestination& { return value.destination; }, frame);
        const bool suspended_root_dialogue =
            item_index == 0 && save.flow_stack.size() > 1 &&
            std::holds_alternative<SavedDialogueFrame>(frame) &&
            std::holds_alternative<SavedSceneFrame>(save.flow_stack[1]) &&
            std::get<SavedSceneFrame>(save.flow_stack[1]).dialogue_handoff &&
            std::get<SavedSceneFrame>(save.flow_stack[1]).dialogue_handoff->dialogue_frame.value ==
                snapshot;
        const bool handed_off_root_scene =
            item_index == 1 && std::holds_alternative<SavedSceneFrame>(frame) &&
            std::get<SavedSceneFrame>(frame).dialogue_handoff &&
            std::get<SavedSceneFrame>(frame).dialogue_handoff->dialogue_frame.value ==
                std::visit([](const auto& value) { return value.snapshot_id.value; },
                           save.flow_stack[0]);
        const bool destination_is_coherent =
            item_index == 0
                ? (suspended_root_dialogue
                       ? std::holds_alternative<CallerDestination>(destination)
                       : !std::holds_alternative<CallerDestination>(destination))
                : (handed_off_root_scene ? !std::holds_alternative<CallerDestination>(destination)
                                         : std::holds_alternative<CallerDestination>(destination));
        if (!destination_is_coherent)
            error("save_codec.incoherent_flow", "Flow return destinations are incoherent.");
    }

    for (std::size_t item_index = 0; item_index < save.flow_stack.size(); ++item_index) {
        const auto* scene = std::get_if<SavedSceneFrame>(&save.flow_stack[item_index]);
        if (scene == nullptr)
            continue;
        if (scene->dialogue_handoff) {
            const auto* dialogue = saved_frame(save, scene->dialogue_handoff->dialogue_frame);
            const bool exact_predecessor =
                item_index > 0 && dialogue == &save.flow_stack[item_index - 1] &&
                dialogue != nullptr && std::holds_alternative<SavedDialogueFrame>(*dialogue);
            if (!exact_predecessor)
                error("save_codec.incoherent_flow",
                      "Dialogue Handoff must reference the exact suspended Dialogue immediately "
                      "before its awaiting Scene.");
        }
        if (scene->preserved_dialogue_caller) {
            const auto caller = std::find_if(
                save.flow_stack.begin(), save.flow_stack.begin() + item_index,
                [&](const SavedFlowFrame& candidate) {
                    return std::visit(
                        [&](const auto& value) {
                            return value.snapshot_id == *scene->preserved_dialogue_caller;
                        },
                        candidate);
                });
            if (caller == save.flow_stack.begin() + item_index ||
                !std::holds_alternative<SavedDialogueFrame>(*caller))
                error("save_codec.incoherent_flow",
                      "Retained Dialogue UI identity must reference a reachable caller Dialogue.");
        }
    }

    for (const auto& detached : save.detached_flows) {
        if (detached.flow_stack.empty()) {
            error("save_codec.invalid_detached_flow",
                  "Detached Flow must contain an active stack.");
            continue;
        }
        if (detached.owner == compiled::DetachedSceneOwner::Flow) {
            if (!detached.flow_owner || saved_frame(save, *detached.flow_owner) == nullptr)
                error("save_codec.invalid_detached_owner",
                      "Flow-owned detached execution has no saved causal owner.");
        } else if (detached.flow_owner) {
            error("save_codec.invalid_detached_owner",
                  "Only Flow-owned detached execution may carry a Flow owner.");
        }
        if (detached.owner == compiled::DetachedSceneOwner::ActiveRoom &&
            (!save.active_room_visit || detached.room_entry_sequence != save.room_entry_sequence))
            error("save_codec.invalid_detached_owner",
                  "Active-Room-owned detached execution does not match the saved Room visit.");

        for (std::size_t item_index = 0; item_index < detached.flow_stack.size(); ++item_index) {
            const auto& frame = detached.flow_stack[item_index];
            const auto snapshot =
                std::visit([](const auto& value) { return value.snapshot_id.value; }, frame);
            if (snapshot == 0 || !frame_ids.insert(snapshot).second ||
                !valid_detached_frame(project, save, frame))
                error("save_codec.invalid_flow_frame",
                      "Detached Flow frame is stale, duplicate, or incoherent.");
            const auto destination = std::visit(
                [](const auto& value) -> ReturnDestination { return value.destination; }, frame);
            const bool suspended_root_dialogue =
                item_index == 0 && detached.flow_stack.size() > 1 &&
                std::holds_alternative<SavedDialogueFrame>(frame) &&
                std::holds_alternative<SavedSceneFrame>(detached.flow_stack[1]) &&
                std::get<SavedSceneFrame>(detached.flow_stack[1]).dialogue_handoff &&
                std::get<SavedSceneFrame>(detached.flow_stack[1])
                        .dialogue_handoff->dialogue_frame.value == snapshot;
            const bool handed_off_root_scene =
                item_index == 1 && std::holds_alternative<SavedSceneFrame>(frame) &&
                std::get<SavedSceneFrame>(frame).dialogue_handoff &&
                std::get<SavedSceneFrame>(frame).dialogue_handoff->dialogue_frame.value ==
                    std::visit([](const auto& value) { return value.snapshot_id.value; },
                               detached.flow_stack[0]);
            const bool destination_is_coherent =
                item_index == 0 ? (suspended_root_dialogue
                                       ? std::holds_alternative<CallerDestination>(destination)
                                       : std::holds_alternative<NoReturnDestination>(destination))
                                : (handed_off_root_scene
                                       ? std::holds_alternative<NoReturnDestination>(destination)
                                       : std::holds_alternative<CallerDestination>(destination));
            if (!destination_is_coherent)
                error("save_codec.incoherent_flow",
                      "Detached Flow return destinations are incoherent.");
        }

        for (std::size_t item_index = 0; item_index < detached.flow_stack.size(); ++item_index) {
            const auto* scene = std::get_if<SavedSceneFrame>(&detached.flow_stack[item_index]);
            if (scene == nullptr)
                continue;
            if (scene->dialogue_handoff) {
                const bool exact_predecessor =
                    item_index > 0 &&
                    std::visit(
                        [&](const auto& value) {
                            return value.snapshot_id == scene->dialogue_handoff->dialogue_frame;
                        },
                        detached.flow_stack[item_index - 1]) &&
                    std::holds_alternative<SavedDialogueFrame>(detached.flow_stack[item_index - 1]);
                if (!exact_predecessor)
                    error("save_codec.incoherent_flow",
                          "Detached Dialogue Handoff must reference its exact predecessor.");
            }
            if (scene->preserved_dialogue_caller) {
                const auto caller = std::find_if(
                    detached.flow_stack.begin(), detached.flow_stack.begin() + item_index,
                    [&](const SavedFlowFrame& candidate) {
                        return std::visit(
                            [&](const auto& value) {
                                return value.snapshot_id == *scene->preserved_dialogue_caller;
                            },
                            candidate);
                    });
                if (caller == detached.flow_stack.begin() + item_index ||
                    !std::holds_alternative<SavedDialogueFrame>(*caller))
                    error("save_codec.incoherent_flow",
                          "Detached retained Dialogue UI identity is not reachable.");
            }
        }

        if (detached.blocker) {
            const auto owner =
                std::visit([](const auto& value) { return value.owner.value; }, *detached.blocker);
            const auto top = std::visit([](const auto& value) { return value.snapshot_id.value; },
                                        detached.flow_stack.back());
            const bool valid_duration = std::visit(
                [](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, SavedDurationBlocker>)
                        return value.remaining.count() > 0;
                    return true;
                },
                *detached.blocker);
            if (owner != top || !valid_duration)
                error("save_codec.invalid_blocker",
                      "Detached saved blocker does not belong to the active top frame.");
        }
    }

    std::unordered_set<std::uint64_t> provenance_ids;
    std::unordered_set<std::uint64_t> provenance_active_frames;
    for (const auto& provenance : save.execution_provenance) {
        if (provenance.id == 0 || !provenance_ids.insert(provenance.id).second)
            error("save_codec.invalid_execution_provenance",
                  "Execution Provenance identity is zero or duplicated.");
        if (provenance.active_frame) {
            if (saved_frame(save, *provenance.active_frame) == nullptr ||
                !provenance_active_frames.insert(provenance.active_frame->value).second)
                error("save_codec.invalid_execution_provenance",
                      "Execution Provenance active frame is missing or duplicated.");
            if (provenance.state == ExecutionState::Completed ||
                provenance.state == ExecutionState::Cancelled)
                error("save_codec.invalid_execution_provenance",
                      "Completed or cancelled Execution Provenance cannot own an active frame.");
        }
        if (provenance.relationship > ExecutionRelationship::Navigation ||
            provenance.state > ExecutionState::Failed)
            error("save_codec.invalid_execution_provenance",
                  "Execution Provenance relationship or state is invalid.");
    }
    const auto has_provenance = [&](std::uint64_t id) { return provenance_ids.contains(id); };
    for (const auto& provenance : save.execution_provenance) {
        if (!has_provenance(provenance.root) ||
            (provenance.parent && !has_provenance(*provenance.parent)) ||
            (provenance.source && !has_provenance(*provenance.source)))
            error("save_codec.invalid_execution_provenance",
                  "Execution Provenance has a stale causal reference.");
        if (provenance.relationship == ExecutionRelationship::Root &&
            (provenance.parent || provenance.source || provenance.root != provenance.id))
            error("save_codec.invalid_execution_provenance",
                  "Root Execution Provenance must be self-rooted without a parent or source.");
    }
    const auto require_active_provenance = [&](const SavedFlowFrame& frame) {
        const auto snapshot =
            std::visit([](const auto& value) { return value.snapshot_id.value; }, frame);
        if (!provenance_active_frames.contains(snapshot))
            error("save_codec.invalid_execution_provenance",
                  "Every active Flow frame requires engine-owned Execution Provenance.");
    };
    for (const auto& frame : save.flow_stack)
        require_active_provenance(frame);
    for (const auto& detached : save.detached_flows)
        for (const auto& frame : detached.flow_stack)
            require_active_provenance(frame);

    std::unordered_set<std::string> background_owners;
    for (const auto& background : save.background_overrides) {
        if (!background_owners.insert(saved_owner_key(background.owner)).second)
            error("save_codec.duplicate_presentation_record",
                  "Background override owner appears more than once.");
        if (!valid_saved_owner(project, save, background.owner) ||
            !valid_background_record(project, background.background))
            error("save_codec.invalid_presentation_record",
                  "Background override has a stale owner or resource.");
    }

    std::unordered_set<std::string> camera_owners;
    for (const auto& camera : save.camera_views) {
        if (!camera_owners.insert(saved_owner_key(camera.owner)).second)
            error("save_codec.duplicate_presentation_record",
                  "Camera View owner appears more than once.");
        if (!valid_saved_owner(project, save, camera.owner) ||
            !std::isfinite(camera.view.center.x) || !std::isfinite(camera.view.center.y) ||
            !std::isfinite(camera.view.zoom) || camera.view.zoom <= 0.0 ||
            !std::isfinite(camera.view.rotation_degrees))
            error("save_codec.invalid_presentation_record",
                  "Camera View has a stale owner or invalid logical framing.");
    }

    std::unordered_set<std::string> actor_keys;
    for (const auto& actor : save.actors) {
        if (!actor_keys.insert(saved_actor_key_text(actor.key) + "|" + saved_owner_key(actor.owner))
                 .second)
            error("save_codec.duplicate_presentation_record",
                  "Actor presentation identity appears more than once.");
        if (!valid_actor_record(project, save, actor))
            error("save_codec.invalid_presentation_record",
                  "Actor presentation has an invalid owner, identity, or Character state.");
    }

    std::unordered_set<std::string> prop_ids;
    for (const auto& prop : save.presentation_props) {
        if (!prop_ids.insert(prop.instance.text() + "|" + saved_owner_key(prop.owner)).second)
            error("save_codec.duplicate_presentation_record",
                  "Presentation prop identity appears more than once.");
        if (!valid_prop_record(project, save, prop))
            error("save_codec.invalid_presentation_record",
                  "Presentation prop has an invalid owner, resource, placement, or bounds.");
    }

    std::unordered_set<std::string> environment_ids;
    for (const auto& environment : save.presentation_environments) {
        if (!environment_ids
                 .insert(environment.instance.text() + "|" + saved_owner_key(environment.owner))
                 .second)
            error("save_codec.duplicate_presentation_record",
                  "Presentation environment identity appears more than once.");
        if (!valid_environment_record(project, save, environment))
            error("save_codec.invalid_presentation_record",
                  "Presentation environment has an invalid owner or policy.");
    }

    std::unordered_set<std::string> material_parameter_keys;
    for (const auto& parameter : save.material_parameters) {
        const auto key = saved_owner_key(parameter.owner) + "|" +
                         saved_material_occurrence_key(parameter.occurrence) + "|" +
                         parameter.material.text() + "|" + parameter.parameter;
        if (!material_parameter_keys.insert(key).second)
            error("save_codec.duplicate_presentation_record",
                  "Material Parameter identity appears more than once.");
        if (!valid_saved_material_parameter(project, save, parameter))
            error("save_codec.invalid_presentation_record",
                  "Material Parameter has an invalid owner, Material, type, binding, or clock.");
    }

    std::unordered_set<std::string> postprocess_ids;
    std::size_t world_postprocess_count = 0;
    std::size_t viewport_postprocess_count = 0;
    for (const auto& effect : save.postprocess_effects) {
        const auto key = effect.instance.text() + "|" + saved_owner_key(effect.owner);
        if (!postprocess_ids.insert(key).second)
            error("save_codec.duplicate_presentation_record",
                  "Postprocess Effect identity appears more than once.");
        if (!valid_saved_postprocess_effect(project, save, effect))
            error("save_codec.invalid_presentation_record",
                  "Postprocess Effect has an invalid owner, Material, scope, or clock.");
        if (effect.scope == compiled::MaterialPostprocessScope::World)
            ++world_postprocess_count;
        else
            ++viewport_postprocess_count;
    }
    if (world_postprocess_count > max_postprocess_effects_per_scope ||
        viewport_postprocess_count > max_postprocess_effects_per_scope)
        error("save_codec.invalid_presentation_record",
              "Postprocess Effect stack exceeds the bounded per-scope limit.");

    std::unordered_set<std::string> layout_keys;
    for (const auto& layout : save.mounted_layouts) {
        if (!layout_keys
                 .insert(saved_mount_key_text(layout.key) + "|" + saved_owner_key(layout.owner))
                 .second)
            error("save_codec.duplicate_presentation_record",
                  "Mounted Layout identity appears more than once.");
        if (!valid_layout_record(project, save, layout))
            error("save_codec.invalid_presentation_record",
                  "Mounted Layout has an invalid owner, identity, Layout, or policy.");
    }

    std::unordered_set<std::string> layout_state_keys;
    for (const auto& slot : save.layout_state_slots) {
        const auto identity =
            saved_layout_state_owner_key(slot.scope_owner) + "|" + saved_mount_key_text(slot.key);
        if (!layout_state_keys.insert(identity).second)
            error("save_codec.duplicate_layout_state",
                  "Layout State Slot identity appears more than once.");
        if (!valid_layout_state_record(project, save, slot))
            error("save_codec.invalid_layout_state",
                  "Layout State Slot has an invalid owner, Layout, or State Shape value.");
    }

    std::unordered_set<std::string> desired_audio_ids;
    std::unordered_set<std::string> desired_audio_replacements;
    for (const auto& audio : save.desired_audio) {
        const auto owner = saved_owner_key(audio.owner);
        if (!desired_audio_ids.insert(audio.instance.text() + "|" + owner).second)
            error("save_codec.duplicate_presentation_record",
                  "Desired audio identity appears more than once.");
        if (audio.replacement_key &&
            !desired_audio_replacements.insert(audio.replacement_key->text() + "|" + owner).second)
            error("save_codec.duplicate_presentation_record",
                  "Desired audio replacement key appears more than once for one owner.");
        if (!valid_desired_audio_record(project, save, audio))
            error("save_codec.invalid_presentation_record",
                  "Desired audio has an invalid owner, bus, Asset, volume, or fade policy.");
    }

    if (!valid_presented_text(project, save, save.presented_text))
        error("save_codec.invalid_presentation_record",
              "Presented text has a stale speaker or invalid markup mode.");
    if (!valid_active_choice(project, save.active_choice))
        error("save_codec.invalid_presentation_record",
              "Active choice has stale or incoherent authored references.");
    if (save.blocker) {
        const auto owner =
            std::visit([](const auto& value) { return value.owner.value; }, *save.blocker);
        const auto top = save.flow_stack.empty()
                             ? 0
                             : std::visit([](const auto& value) { return value.snapshot_id.value; },
                                          save.flow_stack.back());
        const bool valid_duration = std::visit(
            [](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, SavedDurationBlocker>)
                    return value.remaining.count() > 0;
                else
                    return true;
            },
            *save.blocker);
        const bool valid =
            owner == top && std::holds_alternative<FlowMode>(save.mode) && valid_duration;
        if (!valid)
            error("save_codec.invalid_blocker",
                  "Saved blocker does not belong to the active top frame.");
    }
    return diagnostics.empty() ? Result<void, Diagnostics>::success()
                               : Result<void, Diagnostics>::failure(std::move(diagnostics));
}

} // namespace noveltea::core::save_state_codec
