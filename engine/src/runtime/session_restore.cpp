#include "noveltea/core/flow_executor.hpp"

#include "noveltea/core/property_resolver.hpp"
#include "noveltea/core/save_state.hpp"

#include <algorithm>
#include <limits>
#include <type_traits>
#include <unordered_map>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics restore_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

std::uint64_t saved_frame_number(const SavedFlowFrame& frame) noexcept
{
    return std::visit([](const auto& value) { return value.snapshot_id.value; }, frame);
}

template<class Definition, class Id> void replace_identity(Definition& definition, const Id& id)
{
    definition.identity.id = id;
}

std::optional<compiled::RoomDefinition> materialize_room(const CompiledProject& project,
                                                         const RuntimeConfigurationSource& source,
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
        replace_identity(*result, id);
    return result;
}

std::optional<compiled::CharacterDefinition>
materialize_character(const CompiledProject& project, const RuntimeConfigurationSource& source,
                      const CharacterId& id)
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
        replace_identity(*result, id);
    return result;
}

std::optional<compiled::InteractableDefinition>
materialize_interactable(const CompiledProject& project, const RuntimeConfigurationSource& source,
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

Result<PresentationOwner, Diagnostics>
restore_presentation_owner(const SavedPresentationOwner& owner,
                           const std::unordered_map<std::uint64_t, FlowFrameId>& frame_ids,
                           const SessionState& state)
{
    return std::visit(
        [&frame_ids, &state](const auto& value) -> Result<PresentationOwner, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedScenePresentationOwner>) {
                const auto invocation = frame_ids.find(value.invocation.value);
                if (invocation == frame_ids.end())
                    return Result<PresentationOwner, Diagnostics>::failure(
                        restore_error("save_restore.invalid_presentation_owner",
                                      "Saved Scene presentation owner could not be remapped."));
                return Result<PresentationOwner, Diagnostics>::success(
                    ScenePresentationOwner{invocation->second, value.scene});
            } else if constexpr (std::is_same_v<T, SavedDialoguePresentationOwner>) {
                const auto invocation = frame_ids.find(value.invocation.value);
                if (invocation == frame_ids.end())
                    return Result<PresentationOwner, Diagnostics>::failure(
                        restore_error("save_restore.invalid_presentation_owner",
                                      "Saved Dialogue presentation owner could not be remapped."));
                return Result<PresentationOwner, Diagnostics>::success(
                    DialoguePresentationOwner{invocation->second, value.dialogue});
            } else if constexpr (std::is_same_v<T, SavedCurrentRoomPresentationOwner>) {
                const auto current = state.current_room_presentation_owner();
                if (!current || current->room != value.room)
                    return Result<PresentationOwner, Diagnostics>::failure(
                        restore_error("save_restore.invalid_presentation_owner",
                                      "Saved current-Room presentation owner cannot bind to the "
                                      "restored visit."));
                return Result<PresentationOwner, Diagnostics>::success(*current);
            } else if constexpr (std::is_same_v<T, SavedRoomPresentationOwner>) {
                return Result<PresentationOwner, Diagnostics>::success(
                    RoomPresentationOwner{value.room});
            } else {
                return Result<PresentationOwner, Diagnostics>::success(
                    state.session_presentation_owner());
            }
        },
        owner);
}

Result<ActorPresentationKey, Diagnostics>
restore_actor_key(const SavedActorPresentationKey& key,
                  const std::unordered_map<std::uint64_t, FlowFrameId>& frame_ids)
{
    return std::visit(
        [&frame_ids](const auto& value) -> Result<ActorPresentationKey, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedSceneActorKey>) {
                const auto invocation = frame_ids.find(value.owner.invocation.value);
                if (invocation == frame_ids.end())
                    return Result<ActorPresentationKey, Diagnostics>::failure(
                        restore_error("save_restore.invalid_actor_owner",
                                      "Saved Scene actor owner could not be remapped."));
                return Result<ActorPresentationKey, Diagnostics>::success(
                    SceneActorKey{{invocation->second, value.owner.scene}, value.slot});
            } else {
                return Result<ActorPresentationKey, Diagnostics>::success(value);
            }
        },
        key);
}

Result<MaterialOccurrence, Diagnostics>
restore_material_occurrence(const SavedMaterialOccurrence& occurrence,
                            const std::unordered_map<std::uint64_t, FlowFrameId>& frame_ids)
{
    return std::visit(
        [&](const auto& value) -> Result<MaterialOccurrence, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedBackgroundMaterialOccurrence>)
                return Result<MaterialOccurrence, Diagnostics>::success(
                    BackgroundMaterialOccurrence{});
            else if constexpr (std::is_same_v<T, SavedActorMaterialOccurrence>) {
                auto key = restore_actor_key(value.key, frame_ids);
                if (!key)
                    return Result<MaterialOccurrence, Diagnostics>::failure(key.error());
                return Result<MaterialOccurrence, Diagnostics>::success(
                    ActorMaterialOccurrence{std::move(*key.value_if()), value.layer});
            } else if constexpr (std::is_same_v<T, SavedPropMaterialOccurrence>)
                return Result<MaterialOccurrence, Diagnostics>::success(
                    PropMaterialOccurrence{value.instance});
            else if constexpr (std::is_same_v<T, SavedEnvironmentMaterialOccurrence>)
                return Result<MaterialOccurrence, Diagnostics>::success(
                    EnvironmentMaterialOccurrence{value.instance});
            else if constexpr (std::is_same_v<T, SavedLayoutMaterialOccurrence>)
                return Result<MaterialOccurrence, Diagnostics>::success(
                    LayoutMaterialOccurrence{value.key, value.material});
            else
                return Result<MaterialOccurrence, Diagnostics>::success(
                    PostprocessMaterialOccurrence{value.instance});
        },
        occurrence);
}

} // namespace

Result<SessionState, Diagnostics>
FlowExecutor::restore_session(const CompiledProject& project, const SaveState& save,
                              const SaveStateCodecPort& save_codec)
{
    auto valid = save_codec.validate(project, save, "save-slot");
    if (!valid)
        return Result<SessionState, Diagnostics>::failure(valid.error());

    auto created = SessionState::create(project);
    auto* state = created.value_if();
    if (state == nullptr)
        return Result<SessionState, Diagnostics>::failure(created.error());

    std::vector<RuntimeRoomConfiguration> runtime_rooms;
    runtime_rooms.reserve(save.runtime_rooms.size());
    for (const auto& saved : save.runtime_rooms) {
        auto birth = materialize_room(project, saved.birth_source, saved.id);
        if (!birth)
            return Result<SessionState, Diagnostics>::failure(
                restore_error("save_restore.invalid_runtime_configuration",
                              "Saved Room birth configuration source cannot be reconstructed."));
        for (const auto& edit : saved.birth_exit_target_overrides) {
            const auto exit =
                std::find_if(birth->exits.begin(), birth->exits.end(),
                             [&](const auto& value) { return value.id == edit.exit; });
            if (exit == birth->exits.end())
                return Result<SessionState, Diagnostics>::failure(
                    restore_error("save_restore.invalid_runtime_configuration",
                                  "Saved Room birth Exit edit cannot be reconstructed."));
            exit->target = edit.target;
        }
        std::optional<compiled::RoomDefinition> structural_override;
        if (saved.structural_override_source) {
            structural_override =
                materialize_room(project, *saved.structural_override_source, saved.id);
            if (!structural_override)
                return Result<SessionState, Diagnostics>::failure(restore_error(
                    "save_restore.invalid_runtime_configuration",
                    "Saved Room structural override source cannot be reconstructed."));
        }
        auto& effective = structural_override ? *structural_override : *birth;
        if (structural_override) {
            for (const auto& edit : saved.structural_override_exit_target_overrides) {
                const auto exit =
                    std::find_if(effective.exits.begin(), effective.exits.end(),
                                 [&](const auto& value) { return value.id == edit.exit; });
                if (exit == effective.exits.end())
                    return Result<SessionState, Diagnostics>::failure(restore_error(
                        "save_restore.invalid_runtime_configuration",
                        "Saved Room replacement-source Exit edit cannot be reconstructed."));
                exit->target = edit.target;
            }
        }
        for (const auto& edit : saved.exit_target_overrides) {
            const auto exit =
                std::find_if(effective.exits.begin(), effective.exits.end(),
                             [&](const auto& value) { return value.id == edit.exit; });
            if (exit == effective.exits.end())
                return Result<SessionState, Diagnostics>::failure(
                    restore_error("save_restore.invalid_runtime_configuration",
                                  "Saved Room Exit structural edit cannot be reconstructed."));
            exit->target = edit.target;
        }
        runtime_rooms.push_back(RuntimeRoomConfiguration{
            saved.id, saved.declared, saved.birth_source, saved.structural_override_source,
            saved.provenance, std::move(*birth), std::move(structural_override),
            saved.birth_exit_target_overrides, saved.structural_override_exit_target_overrides,
            saved.exit_target_overrides});
    }

    std::vector<RuntimeCharacterConfiguration> runtime_characters;
    runtime_characters.reserve(save.runtime_characters.size());
    for (const auto& saved : save.runtime_characters) {
        auto birth = materialize_character(project, saved.birth_source, saved.id);
        if (!birth)
            return Result<SessionState, Diagnostics>::failure(restore_error(
                "save_restore.invalid_runtime_configuration",
                "Saved Character birth configuration source cannot be reconstructed."));
        std::optional<compiled::CharacterDefinition> structural_override;
        if (saved.structural_override_source) {
            structural_override =
                materialize_character(project, *saved.structural_override_source, saved.id);
            if (!structural_override)
                return Result<SessionState, Diagnostics>::failure(restore_error(
                    "save_restore.invalid_runtime_configuration",
                    "Saved Character structural override source cannot be reconstructed."));
        }
        runtime_characters.push_back(RuntimeCharacterConfiguration{
            saved.id, saved.declared, saved.birth_source, saved.structural_override_source,
            saved.provenance, std::move(*birth), std::move(structural_override)});
    }

    std::vector<RuntimeInteractableConfiguration> runtime_interactables;
    runtime_interactables.reserve(save.runtime_interactables.size());
    for (const auto& saved : save.runtime_interactables) {
        auto birth = materialize_interactable(project, saved.birth_source, saved.id);
        if (!birth)
            return Result<SessionState, Diagnostics>::failure(restore_error(
                "save_restore.invalid_runtime_configuration",
                "Saved Interactable birth configuration source cannot be reconstructed."));
        if (saved.declared) {
            const auto* declaration = project.find_interactable_instance(saved.id);
            const auto* source =
                std::get_if<CompiledInteractableConfigurationSource>(&saved.birth_source);
            if (declaration == nullptr || source == nullptr ||
                source->definition != declaration->definition)
                return Result<SessionState, Diagnostics>::failure(
                    restore_error("save_restore.invalid_runtime_configuration",
                                  "Saved declared Interactable does not match its Project Instance "
                                  "declaration."));
            *birth = realize_declared_interactable_configuration(*birth, *declaration);
        }
        std::optional<compiled::InteractableDefinition> structural_override;
        if (saved.structural_override_source) {
            structural_override =
                materialize_interactable(project, *saved.structural_override_source, saved.id);
            if (!structural_override)
                return Result<SessionState, Diagnostics>::failure(restore_error(
                    "save_restore.invalid_runtime_configuration",
                    "Saved Interactable structural override source cannot be reconstructed."));
        }
        runtime_interactables.push_back(RuntimeInteractableConfiguration{
            saved.id, saved.declared, saved.birth_source, saved.structural_override_source,
            saved.provenance, std::move(*birth), std::move(structural_override)});
    }
    state->m_runtime_rooms = std::move(runtime_rooms);
    state->m_runtime_characters = std::move(runtime_characters);
    state->m_runtime_interactables = std::move(runtime_interactables);
    state->m_next_runtime_instance_id = save.next_runtime_instance_id;

    state->m_mode = save.mode;
    state->m_flow_stack.clear();
    state->m_blocker.reset();
    state->m_execution_fault.reset();
    state->m_property_overrides.clear();
    PropertyResolver property_resolver(project, *state);
    for (const auto& saved_override : save.property_overrides) {
        const auto owner = property_target_owner(saved_override.target);
        auto restored =
            owner ? property_resolver.set(*owner, saved_override.property, saved_override.value)
                  : property_resolver.set_global(saved_override.property, saved_override.value);
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    state->m_character_world = save.characters;
    state->m_interactables = save.interactables;
    state->m_room_entry_sequence = save.room_entry_sequence;
    state->m_room_visit = save.active_room_visit;
    if (save.active_room_visit) {
        auto visit_instance = SessionState::allocate_room_visit_instance_id();
        if (!visit_instance)
            return Result<SessionState, Diagnostics>::failure(visit_instance.error());
        state->m_room_visit_instance = *visit_instance.value_if();
    } else {
        state->m_room_visit_instance.reset();
    }
    state->m_room_visits.clear();
    for (const auto& visits : save.room_visits)
        state->m_room_visits.emplace(visits.room, visits.count);
    state->m_dialogue_line_history.clear();
    for (const auto& history : save.dialogue_line_history)
        state->m_dialogue_line_history.emplace_back(history.key, history.count);
    state->m_dialogue_choice_history.clear();
    for (const auto& history : save.dialogue_choice_history)
        state->m_dialogue_choice_history.emplace_back(history.key, history.count);
    state->m_text_log = save.text_log;
    state->m_play_time = save.play_time;
    state->m_random_state = save.random_state;
    state->m_gameplay_paused = false;

    std::uint64_t max_timer_id = 0;
    for (const auto& timer : save.logical_timers)
        max_timer_id = std::max(max_timer_id, timer.id.value);
    for (const auto& completion : save.pending_timer_completions)
        max_timer_id = std::max(max_timer_id, completion.id.value);
    std::vector<std::uint64_t> saved_timer_ids;
    saved_timer_ids.reserve(save.logical_timers.size() + save.pending_timer_completions.size());
    for (const auto& timer : save.logical_timers)
        saved_timer_ids.push_back(timer.id.value);
    for (const auto& completion : save.pending_timer_completions)
        saved_timer_ids.push_back(completion.id.value);
    std::sort(saved_timer_ids.begin(), saved_timer_ids.end());
    saved_timer_ids.erase(std::unique(saved_timer_ids.begin(), saved_timer_ids.end()),
                          saved_timer_ids.end());
    if (saved_timer_ids.size() >= std::numeric_limits<std::uint64_t>::max() - max_timer_id)
        return Result<SessionState, Diagnostics>::failure(restore_error(
            "save_restore.handle_overflow", "Logical timer handles cannot be reconstructed."));
    std::unordered_map<std::uint64_t, std::uint64_t> timer_ids;
    std::uint64_t next_timer_id = max_timer_id + 1;
    for (const auto saved_id : saved_timer_ids)
        timer_ids.emplace(saved_id, next_timer_id++);
    state->m_logical_timers.clear();
    for (const auto& timer : save.logical_timers) {
        const auto restored_id = timer_ids.find(timer.id.value);
        if (restored_id == timer_ids.end())
            return Result<SessionState, Diagnostics>::failure(restore_error(
                "save_restore.invalid_timer", "Saved logical timer identity was not mapped."));
        state->m_logical_timers.push_back(LogicalTimer{LogicalTimerId{restored_id->second},
                                                       timer.remaining, timer.repeat_interval});
    }
    state->m_pending_timer_completions.clear();
    for (const auto& completion : save.pending_timer_completions) {
        const auto restored_id = timer_ids.find(completion.id.value);
        if (restored_id == timer_ids.end())
            return Result<SessionState, Diagnostics>::failure(restore_error(
                "save_restore.invalid_timer", "Saved timer completion identity was not mapped."));
        state->m_pending_timer_completions.push_back(
            LogicalTimerCompletion{LogicalTimerId{restored_id->second}, completion.occurrences});
    }
    state->m_next_logical_timer_id = next_timer_id;

    std::uint64_t max_frame_id = 0;
    std::size_t saved_frame_count = save.flow_stack.size();
    for (const auto& frame : save.flow_stack)
        max_frame_id = std::max(max_frame_id, saved_frame_number(frame));
    for (const auto& detached : save.detached_flows) {
        saved_frame_count += detached.flow_stack.size();
        for (const auto& frame : detached.flow_stack)
            max_frame_id = std::max(max_frame_id, saved_frame_number(frame));
    }
    saved_frame_count += static_cast<std::size_t>(std::ranges::count_if(
        save.execution_provenance,
        [](const SavedExecutionProvenance& provenance) { return !provenance.active_frame; }));
    if (saved_frame_count >= std::numeric_limits<std::uint64_t>::max() - max_frame_id)
        return Result<SessionState, Diagnostics>::failure(restore_error(
            "save_restore.handle_overflow", "Flow frame handles cannot be reconstructed."));
    std::unordered_map<std::uint64_t, FlowFrameId> frame_ids;
    std::uint64_t next_frame_id = max_frame_id + 1;
    const auto allocate_stack_ids = [&](const std::vector<SavedFlowFrame>& stack) {
        for (const auto& frame : stack)
            frame_ids.emplace(saved_frame_number(frame), FlowFrameId{next_frame_id++});
    };
    allocate_stack_ids(save.flow_stack);
    for (const auto& detached : save.detached_flows)
        allocate_stack_ids(detached.flow_stack);

    const auto restore_frame = [&](const SavedFlowFrame& saved_frame) -> FlowFrame {
        const auto live = frame_ids.find(saved_frame_number(saved_frame));
        assert(live != frame_ids.end());
        const FlowFrameId id = live->second;
        return std::visit(
            [id](const auto& frame) -> FlowFrame {
                using T = std::decay_t<decltype(frame)>;
                if constexpr (std::is_same_v<T, SavedSceneFrame>)
                    return SceneFrame{id,
                                      frame.scene,
                                      frame.position,
                                      frame.destination,
                                      frame.inputs,
                                      frame.last_child_outcome,
                                      std::nullopt,
                                      std::nullopt};
                else if constexpr (std::is_same_v<T, SavedDialogueFrame>)
                    return DialogueFrame{id,
                                         frame.dialogue,
                                         frame.position,
                                         frame.stage_slots,
                                         frame.media_slots,
                                         frame.destination,
                                         frame.command_results};
                else if constexpr (std::is_same_v<T, SavedInteractionFrame>)
                    return InteractionFrame{id,
                                            frame.invocation,
                                            frame.program,
                                            frame.position,
                                            frame.destination,
                                            frame.command_results};
                else
                    return RoomTransitionFrame{id,
                                               frame.source_room,
                                               frame.target_room,
                                               frame.selected_exit,
                                               frame.kind,
                                               frame.entry_cause,
                                               frame.source_context,
                                               frame.position,
                                               frame.destination,
                                               frame.rejection_stage,
                                               frame.command_results};
            },
            saved_frame);
    };
    const auto restore_stack = [&](const std::vector<SavedFlowFrame>& saved_stack,
                                   FlowStack& stack) -> Result<void, Diagnostics> {
        stack.clear();
        stack.reserve(saved_stack.size());
        for (const auto& saved_frame : saved_stack)
            stack.push_back(restore_frame(saved_frame));
        for (std::size_t index = 0; index < saved_stack.size(); ++index) {
            const auto* saved_scene = std::get_if<SavedSceneFrame>(&saved_stack[index]);
            if (saved_scene == nullptr)
                continue;
            auto* scene = std::get_if<SceneFrame>(&stack[index]);
            if (scene == nullptr)
                return Result<void, Diagnostics>::failure(restore_error(
                    "save_restore.invalid_flow", "Saved Scene frame could not be reconstructed."));
            if (saved_scene->dialogue_handoff) {
                const auto dialogue =
                    frame_ids.find(saved_scene->dialogue_handoff->dialogue_frame.value);
                if (dialogue == frame_ids.end())
                    return Result<void, Diagnostics>::failure(restore_error(
                        "save_restore.invalid_flow",
                        "Saved Dialogue Handoff identity could not be reconstructed."));
                scene->dialogue_handoff =
                    DialogueHandoffState{dialogue->second, saved_scene->dialogue_handoff->payload};
            }
            if (saved_scene->preserved_dialogue_caller) {
                const auto caller = frame_ids.find(saved_scene->preserved_dialogue_caller->value);
                if (caller == frame_ids.end())
                    return Result<void, Diagnostics>::failure(restore_error(
                        "save_restore.invalid_flow",
                        "Saved preserved Dialogue caller could not be reconstructed."));
                scene->preserved_dialogue_caller = caller->second;
            }
        }
        return Result<void, Diagnostics>::success();
    };

    auto foreground_stack = restore_stack(save.flow_stack, state->m_flow_stack);
    if (!foreground_stack)
        return Result<SessionState, Diagnostics>::failure(foreground_stack.error());
    state->m_next_blocker_handle = 1;
    const auto restore_blocker = [&](const std::optional<SavedFlowBlocker>& saved_blocker)
        -> Result<std::optional<FlowBlocker>, Diagnostics> {
        if (!saved_blocker)
            return Result<std::optional<FlowBlocker>, Diagnostics>::success(std::nullopt);
        const auto owner_snapshot =
            std::visit([](const auto& blocker) { return blocker.owner.value; }, *saved_blocker);
        const auto owner = frame_ids.find(owner_snapshot);
        if (owner == frame_ids.end())
            return Result<std::optional<FlowBlocker>, Diagnostics>::failure(restore_error(
                "save_restore.invalid_blocker", "Saved blocker owner could not be reconstructed."));
        const FlowFrameId owner_id = owner->second;
        const auto handle = state->m_next_blocker_handle++;
        return Result<std::optional<FlowBlocker>, Diagnostics>::success(std::visit(
            [owner_id, handle](const auto& blocker) -> FlowBlocker {
                using T = std::decay_t<decltype(blocker)>;
                if constexpr (std::is_same_v<T, SavedInputBlocker>)
                    return InputFlowBlocker{owner_id, InputFlowBlockerHandle{handle}};
                else
                    return DurationFlowBlocker{owner_id, DurationFlowBlockerHandle{handle},
                                               blocker.remaining};
            },
            *saved_blocker));
    };
    auto foreground_blocker = restore_blocker(save.blocker);
    if (!foreground_blocker)
        return Result<SessionState, Diagnostics>::failure(foreground_blocker.error());
    state->m_blocker = std::move(*foreground_blocker.value_if());

    state->m_detached_flow_executions.clear();
    state->m_detached_flow_executions.reserve(save.detached_flows.size());
    for (const auto& saved_detached : save.detached_flows) {
        FlowStack stack;
        auto restored_stack = restore_stack(saved_detached.flow_stack, stack);
        if (!restored_stack)
            return Result<SessionState, Diagnostics>::failure(restored_stack.error());
        auto blocker = restore_blocker(saved_detached.blocker);
        if (!blocker)
            return Result<SessionState, Diagnostics>::failure(blocker.error());
        std::optional<FlowFrameId> flow_owner;
        if (saved_detached.flow_owner) {
            const auto owner = frame_ids.find(saved_detached.flow_owner->value);
            if (owner == frame_ids.end())
                return Result<SessionState, Diagnostics>::failure(
                    restore_error("save_restore.invalid_detached_owner",
                                  "Detached Flow owner could not be reconstructed."));
            flow_owner = owner->second;
        }
        state->m_detached_flow_executions.push_back(DetachedFlowExecution{
            saved_detached.owner, flow_owner, saved_detached.room_entry_sequence,
            FlowExecutionContext{FlowMode{}, std::move(stack), std::move(*blocker.value_if()),
                                 std::nullopt, false, true}});
    }

    std::unordered_map<std::uint64_t, FlowFrameId> provenance_ids;
    provenance_ids.reserve(save.execution_provenance.size());
    for (const auto& saved_provenance : save.execution_provenance) {
        if (saved_provenance.active_frame) {
            const auto active = frame_ids.find(saved_provenance.active_frame->value);
            if (active == frame_ids.end())
                return Result<SessionState, Diagnostics>::failure(
                    restore_error("save_restore.invalid_execution_provenance",
                                  "Execution Provenance active frame could not be reconstructed."));
            provenance_ids.emplace(saved_provenance.id, active->second);
        } else {
            provenance_ids.emplace(saved_provenance.id, FlowFrameId{next_frame_id++});
        }
    }
    state->m_execution_provenance.clear();
    state->m_execution_provenance.reserve(save.execution_provenance.size());
    for (const auto& saved_provenance : save.execution_provenance) {
        const auto frame = provenance_ids.find(saved_provenance.id);
        const auto root = provenance_ids.find(saved_provenance.root);
        const auto parent = saved_provenance.parent ? provenance_ids.find(*saved_provenance.parent)
                                                    : provenance_ids.end();
        const auto source = saved_provenance.source ? provenance_ids.find(*saved_provenance.source)
                                                    : provenance_ids.end();
        if (frame == provenance_ids.end() || root == provenance_ids.end() ||
            (saved_provenance.parent && parent == provenance_ids.end()) ||
            (saved_provenance.source && source == provenance_ids.end()))
            return Result<SessionState, Diagnostics>::failure(
                restore_error("save_restore.invalid_execution_provenance",
                              "Execution Provenance causal identity could not be reconstructed."));
        state->m_execution_provenance.push_back(ExecutionProvenance{
            frame->second,
            saved_provenance.parent ? std::optional{parent->second} : std::nullopt,
            root->second,
            saved_provenance.relationship,
            saved_provenance.source ? std::optional{source->second} : std::nullopt,
            saved_provenance.state,
        });
    }
    state->m_next_frame_id = next_frame_id;

    state->m_background_overrides.clear();
    state->m_camera_views.clear();
    state->m_actors.clear();
    state->m_presentation_props.clear();
    state->m_presentation_environments.clear();
    state->m_material_parameters.clear();
    state->m_postprocess_effects.clear();
    state->m_mounted_layouts.clear();
    state->m_layout_state_slots.clear();
    state->m_desired_audio.clear();
    state->m_presented_text = save.presented_text;
    state->m_active_choice = save.active_choice;

    for (const auto& saved : save.layout_state_slots) {
        const auto* layout = project.find_layout(saved.layout);
        if (!layout || !layout->contract.state ||
            !persistable_value_matches(*layout->contract.state, saved.value))
            return Result<SessionState, Diagnostics>::failure(
                restore_error("save_restore.invalid_layout_state",
                              "Saved Layout Slot does not match its declared State Shape."));

        auto scope_owner = std::visit(
            [&](const auto& owner) -> Result<LayoutStateScopeOwner, Diagnostics> {
                using T = std::decay_t<decltype(owner)>;
                if constexpr (std::is_same_v<T, SavedVisitLayoutStateOwner>) {
                    if (!state->m_room_visit || !state->m_room_visit_instance ||
                        state->m_room_visit->room != owner.room)
                        return Result<LayoutStateScopeOwner, Diagnostics>::failure(
                            restore_error("save_restore.invalid_layout_state_owner",
                                          "Saved visit Layout Slot does not belong to the restored "
                                          "Active Room Context."));
                    return Result<LayoutStateScopeOwner, Diagnostics>::success(
                        LayoutVisitStateOwner{*state->m_room_visit_instance});
                } else if constexpr (std::is_same_v<T, SavedRoomLayoutStateOwner>) {
                    const auto room = std::find_if(
                        state->m_runtime_rooms.begin(), state->m_runtime_rooms.end(),
                        [&](const auto& candidate) { return candidate.id == owner.room; });
                    if (room == state->m_runtime_rooms.end())
                        return Result<LayoutStateScopeOwner, Diagnostics>::failure(
                            restore_error("save_restore.invalid_layout_state_owner",
                                          "Saved room Layout Slot references a missing Room."));
                    return Result<LayoutStateScopeOwner, Diagnostics>::success(
                        LayoutRoomStateOwner{owner.room});
                } else if constexpr (std::is_same_v<T, SavedFlowLayoutStateOwner>) {
                    const auto flow = frame_ids.find(owner.flow.value);
                    if (flow == frame_ids.end())
                        return Result<LayoutStateScopeOwner, Diagnostics>::failure(restore_error(
                            "save_restore.invalid_layout_state_owner",
                            "Saved flow Layout Slot references a missing Flow frame."));
                    return Result<LayoutStateScopeOwner, Diagnostics>::success(
                        LayoutFlowStateOwner{flow->second});
                } else {
                    return Result<LayoutStateScopeOwner, Diagnostics>::success(
                        LayoutSessionStateOwner{state->presentation_session_id()});
                }
            },
            saved.scope_owner);
        if (!scope_owner)
            return Result<SessionState, Diagnostics>::failure(scope_owner.error());
        const auto duplicate = std::find_if(
            state->m_layout_state_slots.begin(), state->m_layout_state_slots.end(),
            [&](const LayoutStateSlot& slot) {
                return slot.scope_owner == *scope_owner.value_if() && slot.key == saved.key;
            });
        if (duplicate != state->m_layout_state_slots.end())
            return Result<SessionState, Diagnostics>::failure(
                restore_error("save_restore.duplicate_layout_state",
                              "Saved Layout Slot identity appears more than once."));
        state->m_layout_state_slots.push_back(
            LayoutStateSlot{*scope_owner.value_if(), saved.key, saved.layout, saved.value});
    }

    const auto reconstruct_room_presentation =
        [&project, state](const RoomId& room) -> Result<void, Diagnostics> {
        const auto record =
            std::find_if(state->runtime_rooms().begin(), state->runtime_rooms().end(),
                         [&](const auto& value) { return value.id == room; });
        const auto* definition =
            record == state->runtime_rooms().end() ? nullptr : &record->effective_configuration();
        if (definition == nullptr)
            return Result<void, Diagnostics>::failure(restore_error(
                "save_restore.invalid_room", "Room presentation could not be reconstructed."));
        for (const auto& overlay : definition->overlays) {
            auto mounted = state->set_overlay(project, room, overlay.id, overlay.visible);
            if (!mounted)
                return mounted;
        }
        return Result<void, Diagnostics>::success();
    };
    if (const auto* room = std::get_if<RoomMode>(&state->m_mode)) {
        auto reconstructed = reconstruct_room_presentation(room->room);
        if (!reconstructed)
            return Result<SessionState, Diagnostics>::failure(reconstructed.error());
    } else if (!state->m_flow_stack.empty()) {
        const auto* transition = std::get_if<RoomTransitionFrame>(&state->m_flow_stack.back());
        if (transition != nullptr) {
            const bool committed = transition->position.stage >= RoomTransitionStage::AfterLeave;
            std::optional<RoomId> room;
            if (committed)
                room = transition->target_room;
            else if (transition->source_room)
                room = *transition->source_room;
            if (room) {
                auto reconstructed = reconstruct_room_presentation(*room);
                if (!reconstructed)
                    return Result<SessionState, Diagnostics>::failure(reconstructed.error());
            }
        }
    }

    for (const auto& saved : save.background_overrides) {
        auto owner = restore_presentation_owner(saved.owner, frame_ids, *state);
        if (!owner)
            return Result<SessionState, Diagnostics>::failure(owner.error());
        auto restored = state->upsert_background_override(
            project, DesiredBackgroundOverride{*owner.value_if(), saved.background});
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    for (const auto& saved : save.camera_views) {
        auto owner = restore_presentation_owner(saved.owner, frame_ids, *state);
        if (!owner)
            return Result<SessionState, Diagnostics>::failure(owner.error());
        auto restored =
            state->set_camera_view(project, DesiredCameraView{*owner.value_if(), saved.view});
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    for (const auto& saved : save.actors) {
        auto owner = restore_presentation_owner(saved.owner, frame_ids, *state);
        if (!owner)
            return Result<SessionState, Diagnostics>::failure(owner.error());
        auto key = restore_actor_key(saved.key, frame_ids);
        if (!key)
            return Result<SessionState, Diagnostics>::failure(key.error());
        auto restored = state->set_actor(
            project, DesiredActorPresentation{*key.value_if(), *owner.value_if(), saved.character,
                                              saved.profile, saved.pose, saved.expression,
                                              saved.appearance, saved.idle, saved.placement,
                                              saved.visible, saved.presentation_complete});
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    for (const auto& saved : save.presentation_props) {
        auto owner = restore_presentation_owner(saved.owner, frame_ids, *state);
        if (!owner)
            return Result<SessionState, Diagnostics>::failure(owner.error());
        auto restored = state->upsert_presentation_prop(
            project, DesiredPresentationProp{saved.instance, *owner.value_if(), saved.asset,
                                             saved.material, saved.placement, saved.bounds,
                                             saved.plane, saved.order, saved.visible});
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    for (const auto& saved : save.presentation_environments) {
        auto owner = restore_presentation_owner(saved.owner, frame_ids, *state);
        if (!owner)
            return Result<SessionState, Diagnostics>::failure(owner.error());
        auto restored = state->upsert_presentation_environment(
            project, DesiredPresentationEnvironment{
                         saved.instance, *owner.value_if(), saved.stop_key, saved.asset,
                         saved.material, saved.bounds, saved.plane, saved.order, saved.clock,
                         saved.scroll_per_second, saved.opacity, saved.visible});
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    for (const auto& saved : save.mounted_layouts) {
        auto owner = restore_presentation_owner(saved.owner, frame_ids, *state);
        if (!owner)
            return Result<SessionState, Diagnostics>::failure(owner.error());
        auto restored = state->upsert_mounted_layout(
            project, DesiredMountedLayout{saved.key, *owner.value_if(), saved.layout, saved.policy,
                                          saved.scale_overrides, saved.composition_group,
                                          std::nullopt, saved.inputs, saved.connected_signals});
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    // Layout mount occurrences are session-local identities. A saved Scene Layout Signal wait
    // names the exact occurrence that existed at capture time; after reconstructing mounts, rebind
    // that semantic wait to the freshly allocated occurrence for the same stable owner and slot.
    const auto rebind_layout_signal_waits = [&](FlowStack& stack) -> Result<void, Diagnostics> {
        for (auto& flow_frame : stack) {
            auto* scene = std::get_if<SceneFrame>(&flow_frame);
            if (scene == nullptr)
                continue;
            auto* completion =
                std::get_if<SceneInstructionCompletionPosition>(&scene->position.substate);
            auto* wait = completion && completion->semantic_wait
                             ? std::get_if<SceneLayoutSignalWaitTarget>(&*completion->semantic_wait)
                             : nullptr;
            if (wait == nullptr)
                continue;
            std::optional<PresentationOwner> owner;
            switch (wait->owner) {
            case compiled::ScenePresentationOwner::Invocation:
                owner = ScenePresentationOwner{scene->frame_id, scene->scene};
                break;
            case compiled::ScenePresentationOwner::ActiveRoom:
                owner = state->current_room_presentation_owner();
                break;
            case compiled::ScenePresentationOwner::RuntimeSession:
                owner = state->session_presentation_owner();
                break;
            }
            if (!owner)
                return Result<void, Diagnostics>::failure(restore_error(
                    "save_restore.scene_layout_signal_owner_missing",
                    "Saved Scene Layout Signal wait owner could not be reconstructed."));
            const MountedLayoutPresentationKey key = ReservedLayoutMountKey{wait->slot};
            const auto mounted = std::ranges::find_if(
                state->m_mounted_layouts, [&](const DesiredMountedLayout& item) {
                    return item.owner == *owner && item.key == key;
                });
            if (mounted == state->m_mounted_layouts.end() || !mounted->occurrence)
                return Result<void, Diagnostics>::failure(restore_error(
                    "save_restore.scene_layout_signal_mount_missing",
                    "Saved Scene Layout Signal wait mount could not be reconstructed."));
            wait->occurrence = mounted->occurrence->number();
        }
        return Result<void, Diagnostics>::success();
    };
    auto foreground_waits = rebind_layout_signal_waits(state->m_flow_stack);
    if (!foreground_waits)
        return Result<SessionState, Diagnostics>::failure(foreground_waits.error());
    for (auto& detached : state->m_detached_flow_executions) {
        auto waits = rebind_layout_signal_waits(detached.context.flow_stack);
        if (!waits)
            return Result<SessionState, Diagnostics>::failure(waits.error());
    }

    for (const auto& saved : save.postprocess_effects) {
        auto owner = restore_presentation_owner(saved.owner, frame_ids, *state);
        if (!owner)
            return Result<SessionState, Diagnostics>::failure(owner.error());
        auto restored = state->upsert_postprocess_effect(
            project,
            DesiredPostprocessEffect{saved.instance, *owner.value_if(), saved.material, saved.scope,
                                     saved.order, saved.clock, saved.visible});
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    for (const auto& saved : save.material_parameters) {
        auto owner = restore_presentation_owner(saved.owner, frame_ids, *state);
        if (!owner)
            return Result<SessionState, Diagnostics>::failure(owner.error());
        auto occurrence = restore_material_occurrence(saved.occurrence, frame_ids);
        if (!occurrence)
            return Result<SessionState, Diagnostics>::failure(occurrence.error());
        auto restored = state->upsert_material_parameter(
            project, DesiredMaterialParameter{*owner.value_if(), std::move(*occurrence.value_if()),
                                              saved.material, saved.parameter, saved.value,
                                              saved.binding, saved.clock});
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    for (const auto& saved : save.desired_audio) {
        auto owner = restore_presentation_owner(saved.owner, frame_ids, *state);
        if (!owner)
            return Result<SessionState, Diagnostics>::failure(owner.error());
        auto restored = state->upsert_desired_audio(
            project, DesiredAudioInstance{saved.instance, *owner.value_if(), saved.purpose,
                                          saved.pause_policy, saved.asset, saved.gain, saved.pan,
                                          saved.pan_source, saved.fade_in, saved.fade_out,
                                          saved.replacement_key});
        if (!restored)
            return Result<SessionState, Diagnostics>::failure(restored.error());
    }
    state->m_flow_running = false;
    return Result<SessionState, Diagnostics>::success(std::move(*state));
}

} // namespace noveltea::core
