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
    (void)interactable;
    return found != room->placements.end();
}

bool valid_character_location(const CompiledProject& project,
                              const CharacterWorldLocation& location)
{
    const auto* placement = std::get_if<compiled::RoomPlacementRef>(&location);
    if (!placement)
        return true;
    const auto* room = project.find_room(placement->room);
    return room != nullptr && std::any_of(room->placements.begin(), room->placements.end(),
                                          [&placement](const compiled::RoomPlacement& item) {
                                              return item.id == placement->placement_id;
                                          });
}

const compiled::RoomExit* find_exit(const compiled::RoomDefinition& room, const RoomExitId& exit)
{
    const auto found =
        std::find_if(room.exits.begin(), room.exits.end(),
                     [&exit](const compiled::RoomExit& item) { return item.id == exit; });
    return found == room.exits.end() ? nullptr : &*found;
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

const SavedFlowFrame* saved_frame(const SaveState& save, SavedFlowFrameId id) noexcept
{
    const auto found = std::find_if(
        save.flow_stack.begin(), save.flow_stack.end(), [id](const SavedFlowFrame& frame) {
            return std::visit([id](const auto& value) { return value.snapshot_id == id; }, frame);
        });
    return found == save.flow_stack.end() ? nullptr : &*found;
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
            } else if constexpr (std::is_same_v<T, SavedCurrentRoomPresentationOwner>) {
                return save.active_room_visit && save.active_room_visit->room == value.room &&
                       project.find_room(value.room) != nullptr;
            } else if constexpr (std::is_same_v<T, SavedRoomPresentationOwner>) {
                return project.find_room(value.room) != nullptr;
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

bool valid_background_record(const CompiledProject& project,
                             const compiled::BackgroundPresentation& value) noexcept
{
    return value.fit <= compiled::BackgroundFit::Center &&
           (!value.asset || project.find_asset(*value.asset) != nullptr);
}

bool valid_actor_character_state(const CompiledProject& project,
                                 const SavedActorPresentation& actor) noexcept
{
    const auto* character = project.find_character(actor.character);
    if (character == nullptr || !std::isfinite(actor.placement.offset.x) ||
        !std::isfinite(actor.placement.offset.y) || !std::isfinite(actor.placement.scale) ||
        actor.placement.scale <= 0.0 || actor.placement.position > compiled::ActorPosition::Custom)
        return false;
    const auto pose = std::find_if(
        character->poses.begin(), character->poses.end(),
        [&actor](const compiled::CharacterPose& value) { return value.id == actor.pose; });
    if (pose == character->poses.end())
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
    return expression != character->expressions.end() && idle_valid &&
           (!expression->pose_id || *expression->pose_id == actor.pose);
}

bool valid_actor_record(const CompiledProject& project, const SaveState& save,
                        const SavedActorPresentation& actor) noexcept
{
    if (!valid_saved_owner(project, save, actor.owner) ||
        !valid_actor_character_state(project, actor))
        return false;
    return std::visit(
        [&project, &actor](const auto& key) {
            using T = std::decay_t<decltype(key)>;
            if constexpr (std::is_same_v<T, CharacterActorKey>) {
                return key.character == actor.character;
            } else if constexpr (std::is_same_v<T, RoomCastActorKey>) {
                const auto* owner = std::get_if<SavedRoomPresentationOwner>(&actor.owner);
                const auto* room = project.find_room(key.room);
                if (owner == nullptr || owner->room != key.room || room == nullptr)
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
    const auto* room = project.find_room(prop.placement->room);
    return room != nullptr && std::any_of(room->placements.begin(), room->placements.end(),
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

bool valid_layout_record(const CompiledProject& project, const SaveState& save,
                         const SavedMountedLayout& layout) noexcept
{
    if (!valid_saved_owner(project, save, layout.owner) ||
        project.find_layout(layout.layout) == nullptr || !valid_policy(layout.policy) ||
        layout.composition_group > PresentationCompositionGroup::Debug)
        return false;
    return std::visit(
        [&project, &layout](const auto& key) {
            using T = std::decay_t<decltype(key)>;
            if constexpr (std::is_same_v<T, ReservedLayoutMountKey>) {
                return key.slot <= compiled::LayoutSlot::Custom;
            } else if constexpr (std::is_same_v<T, RoomOverlayLayoutMountKey>) {
                const auto* owner = std::get_if<SavedRoomPresentationOwner>(&layout.owner);
                const auto* room = project.find_room(key.room);
                if (owner == nullptr || owner->room != key.room || room == nullptr ||
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

bool valid_presented_text(const CompiledProject& project,
                          const std::optional<PresentedTextState>& text) noexcept
{
    return !text || (text->markup <= TextMarkup::ActiveText &&
                     (!text->speaker || project.find_character(*text->speaker) != nullptr));
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

bool valid_map_presentation(const CompiledProject& project,
                            const std::optional<MapPresentationState>& value) noexcept
{
    if (!value)
        return true;
    const auto* map = project.find_map(value->map);
    if (map == nullptr || value->mode > compiled::InitialMapMode::FullMap)
        return false;
    return !value->focused_location ||
           std::any_of(map->locations.begin(), map->locations.end(),
                       [&value](const compiled::MapLocation& location) {
                           return location.id == *value->focused_location;
                       });
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
    std::unordered_set<std::string> characters;
    for (const auto& item : save.characters) {
        if (!characters.insert(item.character.text()).second)
            error("save_codec.duplicate_record", "Character world state appears more than once.");
        if (!project.find_character(item.character) ||
            !valid_character_location(project, item.location))
            error("save_codec.invalid_character",
                  "Character world state has an invalid reference or location.");
    }
    if (save.characters.size() != project.characters().size())
        error("save_codec.incomplete_characters", "Save must contain every compiled Character.");
    std::unordered_set<std::string> room_history;
    for (const auto& item : save.room_visits) {
        if (!room_history.insert(item.room.text()).second || !project.find_room(item.room))
            error("save_codec.invalid_room_history", "Room history is duplicate or stale.");
    }
    if (save.active_room_visit) {
        const auto& visit = *save.active_room_visit;
        const auto* room = project.find_room(visit.room);
        const auto history =
            std::find_if(save.room_visits.begin(), save.room_visits.end(),
                         [&visit](const SavedRoomVisits& item) { return item.room == visit.room; });
        bool entry_valid = !visit.entry_exit;
        if (visit.entry_exit) {
            const auto* source = project.find_room(visit.entry_exit->room);
            const auto* exit = source ? find_exit(*source, visit.entry_exit->exit_id) : nullptr;
            entry_valid = source != nullptr && exit != nullptr && exit->target == visit.room &&
                          visit.source_room == visit.entry_exit->room;
        }
        if (!room || (visit.source_room && !project.find_room(*visit.source_room)) ||
            history == save.room_visits.end() || visit.visit_index == 0 ||
            history->count != visit.visit_index || !entry_valid)
            error("save_codec.invalid_active_room_visit",
                  "Active Room visit context is stale or inconsistent with Room history.");
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
                           std::all_of(
                               item.invocation.operands.begin(), item.invocation.operands.end(),
                               [&project](const compiled::InteractionSubject& subject) {
                                   return std::visit(
                                       [&project](const auto& value) {
                                           using S = std::decay_t<decltype(value)>;
                                           if constexpr (std::is_same_v<
                                                             S,
                                                             compiled::CharacterInteractionSubject>)
                                               return project.find_character(value.character) !=
                                                      nullptr;
                                           else
                                               return project.find_interactable(
                                                          value.interactable) != nullptr;
                                       },
                                       subject);
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
        const bool destination_is_coherent =
            item_index == 0 ? !std::holds_alternative<CallerDestination>(destination)
                            : std::holds_alternative<CallerDestination>(destination);
        if (!destination_is_coherent)
            error("save_codec.incoherent_flow", "Flow return destinations are incoherent.");
    }

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

    if (!valid_presented_text(project, save.presented_text))
        error("save_codec.invalid_presentation_record",
              "Presented text has a stale speaker or invalid markup mode.");
    if (!valid_active_choice(project, save.active_choice))
        error("save_codec.invalid_presentation_record",
              "Active choice has stale or incoherent authored references.");
    if (!valid_map_presentation(project, save.map_presentation))
        error("save_codec.invalid_presentation_record",
              "Map presentation has a stale Map or focused location.");

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
