#include "codec_internal.hpp"

namespace noveltea::core::save_state_codec {
bool owner_exists(const CompiledProject& project, const PropertyOwnerRef& owner)
{
    return std::visit(
        [&project](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>)
                return project.find_room(id) != nullptr;
            else if constexpr (std::is_same_v<T, SceneId>)
                return project.find_scene(id) != nullptr;
            else if constexpr (std::is_same_v<T, DialogueId>)
                return project.find_dialogue(id) != nullptr;
            else if constexpr (std::is_same_v<T, CharacterId>)
                return project.find_character(id) != nullptr;
            else if constexpr (std::is_same_v<T, InteractableId>)
                return project.find_interactable(id) != nullptr;
            else if constexpr (std::is_same_v<T, VerbId>)
                return project.find_verb(id) != nullptr;
            else if constexpr (std::is_same_v<T, InteractionId>)
                return project.find_interaction(id) != nullptr;
            else
                return project.find_map(id) != nullptr;
        },
        owner);
}

template<class T> const auto* instruction_by_id(const std::vector<T>& values, const auto& id)
{
    const auto found = std::find_if(values.begin(), values.end(), [&id](const T& value) {
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
            } else {
                const auto* verb = project.find_verb(item.verb);
                return verb ? &verb->default_program : nullptr;
            }
        },
        reference);
}

bool has_interaction_instruction(const compiled::InteractionProgram& program,
                                 const InteractionInstructionId& id)
{
    return instruction_by_id(program.instructions, id) != nullptr;
}

bool valid_location(const CompiledProject& project, const InteractableId& interactable,
                    const compiled::InteractableLocation& location)
{
    const auto* placement = std::get_if<compiled::RoomPlacementRef>(&location);
    if (!placement)
        return true;
    const auto* room = project.find_room(placement->room);
    if (!room)
        return false;
    const auto found = std::find_if(room->placements.begin(), room->placements.end(),
                                    [&placement](const compiled::RoomPlacement& item) {
                                        return item.id == placement->placement_id;
                                    });
    return found != room->placements.end() && found->interactable == interactable;
}

bool valid_destination(const CompiledProject& project, const ReturnDestination& destination)
{
    if (const auto* room = std::get_if<ResumeRoomDestination>(&destination))
        return project.find_room(room->room) != nullptr;
    return true;
}

bool value_matches_type(const PropertyValueType& type, const RuntimeValue& value)
{
    if (!runtime_value_is_finite(value) || std::holds_alternative<std::monostate>(value))
        return false;
    return std::visit(
        [&value](const auto& item) {
            using T = std::decay_t<decltype(item)>;
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
                const auto* string = std::get_if<std::string>(&value);
                return string != nullptr && std::find(item.values.begin(), item.values.end(),
                                                      *string) != item.values.end();
            }
        },
        type);
}

std::string owner_text(const PropertyOwnerRef& owner)
{
    return std::visit([](const auto& id) { return id.text(); }, owner);
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
               !position.awaiting_completion;
    case DialogueFramePosition::Stage::PresentSegment:
        return segment && !position.edge && position.next_effect == 0 &&
               (!position.awaiting_completion ||
                std::holds_alternative<compiled::DialogueRunLuaSegment>(*segment));
    case DialogueFramePosition::Stage::ApplySegmentEffects: {
        const auto* line = segment ? std::get_if<compiled::DialogueLineSegment>(segment) : nullptr;
        return line && !position.edge && position.next_effect <= line->effects.size() &&
               (!position.awaiting_completion || position.next_effect < line->effects.size());
    }
    case DialogueFramePosition::Stage::PresentChoices:
        return std::holds_alternative<compiled::DialogueChoiceBlock>(*block) && !position.segment &&
               !position.edge && position.next_effect == 0;
    case DialogueFramePosition::Stage::ApplyChoiceEffects: {
        const auto* choice = edge ? std::get_if<compiled::DialogueChoiceEdge>(edge) : nullptr;
        return choice && !position.segment && position.next_effect <= choice->effects.size() &&
               (!position.awaiting_completion || position.next_effect < choice->effects.size());
    }
    case DialogueFramePosition::Stage::FollowEdge:
        return edge && !position.segment && position.next_effect == 0 &&
               !position.awaiting_completion;
    }
    return false;
}

std::size_t hook_effects(const CompiledProject& project, const SavedRoomTransitionFrame& frame,
                         RoomTransitionStage stage)
{
    const compiled::RoomDefinition* room = nullptr;
    std::optional<compiled::RoomHookKind> hook;
    switch (stage) {
    case RoomTransitionStage::BeforeLeave:
        room = frame.source_room ? project.find_room(*frame.source_room) : nullptr;
        hook = compiled::RoomHookKind::BeforeLeave;
        break;
    case RoomTransitionStage::BeforeEnter:
        room = project.find_room(frame.target_room);
        hook = compiled::RoomHookKind::BeforeEnter;
        break;
    case RoomTransitionStage::AfterLeave:
        room = frame.source_room ? project.find_room(*frame.source_room) : nullptr;
        hook = compiled::RoomHookKind::AfterLeave;
        break;
    case RoomTransitionStage::AfterEnter:
        room = project.find_room(frame.target_room);
        hook = compiled::RoomHookKind::AfterEnter;
        break;
    default:
        return 0;
    }
    if (!room || !hook)
        return 0;
    const auto found = std::find_if(
        room->lifecycle.hooks.begin(), room->lifecycle.hooks.end(),
        [&hook](const compiled::RoomHookProgram& program) { return program.hook == *hook; });
    return found == room->lifecycle.hooks.end() ? 0 : found->effects.size();
}

bool valid_room_position(const CompiledProject& project, const SavedRoomTransitionFrame& frame)
{
    const auto& position = frame.position;
    if (position.stage > RoomTransitionStage::Complete)
        return false;
    switch (position.stage) {
    case RoomTransitionStage::BeforeLeave:
    case RoomTransitionStage::BeforeEnter:
    case RoomTransitionStage::AfterLeave:
    case RoomTransitionStage::AfterEnter: {
        const auto count = hook_effects(project, frame, position.stage);
        return position.next_effect <= count &&
               (!position.awaiting_completion || position.next_effect < count);
    }
    default:
        return position.next_effect == 0 && !position.awaiting_completion;
    }
}

Result<void, Diagnostics> validate_save_state_impl(const CompiledProject& project,
                                                   const SaveState& save, std::string source_path)
{
    Diagnostics diagnostics;
    const auto error = [&diagnostics, &source_path](std::string code, std::string message) {
        diagnostics.push_back(Diagnostic{
            .code = std::move(code), .message = std::move(message), .source_path = source_path});
    };
    if (save.metadata.format_version != SaveStateMetadata::current_format_version)
        error("save_codec.unsupported_version", "Save format version is unsupported.");
    if (save.metadata.project != project.identity().id ||
        save.metadata.project_version != project.identity().version)
        error("save_codec.project_mismatch", "Save metadata does not match the loaded project.");
    if (save.play_time.count() < 0)
        error("save_codec.invalid_time", "Play time cannot be negative.");
    std::unordered_set<std::string> variable_ids;
    for (const auto& item : save.variables) {
        const auto* definition = project.find_variable(item.id);
        if (!variable_ids.insert(item.id.text()).second)
            error("save_codec.duplicate_record", "Variable appears more than once.");
        if (!definition)
            error("save_codec.invalid_reference", "Save references an unknown variable.");
        else if (!value_matches_type(definition->value_type, item.value))
            error("save_codec.invalid_value", "Variable value does not match its declaration.");
    }
    if (save.variables.size() != project.variables().size())
        error("save_codec.incomplete_variables", "Save must contain every declared variable.");
    std::unordered_set<std::string> overrides;
    for (const auto& item : save.property_overrides) {
        const auto key = std::to_string(item.owner.index()) + ":" + owner_text(item.owner) + ":" +
                         item.property.text();
        const auto* definition = project.find_property(item.property);
        if (!overrides.insert(key).second)
            error("save_codec.duplicate_record", "Property override appears more than once.");
        if (!owner_exists(project, item.owner) || !definition ||
            definition->persistence() != PropertyPersistence::Save ||
            !make_property_override(item.owner, *definition, item.value))
            error("save_codec.invalid_property_override",
                  "Property override is not permitted by the loaded project.");
    }
    std::unordered_set<std::string> interactables;
    for (const auto& item : save.interactables) {
        if (!interactables.insert(item.interactable.text()).second)
            error("save_codec.duplicate_record", "Interactable state appears more than once.");
        if (!project.find_interactable(item.interactable) ||
            !valid_location(project, item.interactable, item.location))
            error("save_codec.invalid_interactable",
                  "Interactable state has an invalid reference or location.");
    }
    if (save.interactables.size() != project.interactables().size())
        error("save_codec.incomplete_interactables",
              "Save must contain every compiled Interactable.");
    std::unordered_set<std::string> room_history;
    for (const auto& item : save.room_visits) {
        if (!room_history.insert(item.room.text()).second || !project.find_room(item.room))
            error("save_codec.invalid_room_history", "Room history is duplicate or stale.");
    }
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
        if (!origin_ok || (entry.speaker && !project.find_character(*entry.speaker)))
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
        room && !project.find_room(room->room))
        error("save_codec.invalid_reference", "Room mode references an unknown Room.");
    std::unordered_set<std::uint64_t> frame_ids;
    for (std::size_t item_index = 0; item_index < save.flow_stack.size(); ++item_index) {
        const auto& frame = save.flow_stack[item_index];
        const auto valid = std::visit(
            [&project](const auto& item) {
                using T = std::decay_t<decltype(item)>;
                if (!valid_destination(project, item.destination))
                    return false;
                if constexpr (std::is_same_v<T, SavedSceneFrame>) {
                    const auto* scene = project.find_scene(item.scene);
                    return scene && valid_scene_position(*scene, item.position);
                } else if constexpr (std::is_same_v<T, SavedDialogueFrame>) {
                    const auto* dialogue = project.find_dialogue(item.dialogue);
                    return dialogue && valid_dialogue_position(*dialogue, item.position);
                } else if constexpr (std::is_same_v<T, SavedInteractionFrame>) {
                    const auto* program = interaction_program(project, item.program);
                    const auto* verb = project.find_verb(item.invocation.verb);
                    return program && verb && item.invocation.operands.size() == verb->arity &&
                           std::all_of(item.invocation.operands.begin(),
                                       item.invocation.operands.end(),
                                       [&project](const InteractableId& id) {
                                           return project.find_interactable(id) != nullptr;
                                       }) &&
                           (!item.position.next_instruction ||
                            has_interaction_instruction(*program,
                                                        *item.position.next_instruction)) &&
                           item.position.fallback_stage <= InteractionFallbackStage::Complete &&
                           item.position.outcome <= InteractionExecutionOutcome::Failed &&
                           (!item.position.awaiting_completion ||
                            item.position.next_instruction.has_value());
                } else {
                    if (!project.find_room(item.target_room) ||
                        (item.source_room && !project.find_room(*item.source_room)) ||
                        !valid_room_position(project, item))
                        return false;
                    if (!item.selected_exit)
                        return !item.source_room;
                    const auto* room = project.find_room(item.selected_exit->room);
                    if (!room)
                        return false;
                    const auto found =
                        std::find_if(room->exits.begin(), room->exits.end(),
                                     [&item](const compiled::RoomExit& exit) {
                                         return exit.id == item.selected_exit->exit_id;
                                     });
                    return item.source_room && item.selected_exit->room == *item.source_room &&
                           found != room->exits.end() && found->target == item.target_room;
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
        if (item_index == 0 ? !std::holds_alternative<NoReturnDestination>(destination)
                            : std::holds_alternative<NoReturnDestination>(destination))
            error("save_codec.incoherent_flow", "Flow return destinations are incoherent.");
    }
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
