#include "noveltea/core/save_state.hpp"

#include <algorithm>
#include <type_traits>
#include <unordered_map>

namespace noveltea::core {
namespace {

void add_preflight_error(Diagnostics& diagnostics, std::string code, std::string message)
{
    diagnostics.push_back(Diagnostic{.code = std::move(code), .message = std::move(message)});
}

using SavedFrameMap = std::unordered_map<std::uint64_t, SavedFlowFrameId>;

std::optional<SavedFlowFrameId> saved_owner(const SavedFrameMap& frame_ids,
                                            const FlowFrameId& owner) noexcept
{
    const auto found = frame_ids.find(owner.number());
    return found == frame_ids.end() ? std::nullopt : std::optional{found->second};
}

SavedFlowFrame save_frame(const SavedFrameMap& frame_ids, const FlowFrame& frame,
                          SavedFlowFrameId snapshot_id)
{
    return std::visit(
        [&frame_ids, snapshot_id](const auto& value) -> SavedFlowFrame {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneFrame>) {
                std::optional<SavedDialogueHandoffState> handoff;
                if (value.dialogue_handoff) {
                    if (const auto dialogue =
                            saved_owner(frame_ids, value.dialogue_handoff->dialogue_frame))
                        handoff =
                            SavedDialogueHandoffState{*dialogue, value.dialogue_handoff->payload};
                }
                const auto preserved =
                    value.preserved_dialogue_caller
                        ? saved_owner(frame_ids, *value.preserved_dialogue_caller)
                        : std::nullopt;
                return SavedSceneFrame{snapshot_id,        value.scene,  value.position,
                                       value.destination,  value.inputs, value.last_child_outcome,
                                       std::move(handoff), preserved};
            } else if constexpr (std::is_same_v<T, DialogueFrame>)
                return SavedDialogueFrame{
                    snapshot_id,       value.dialogue,    value.position,       value.stage_slots,
                    value.media_slots, value.destination, value.command_results};
            else if constexpr (std::is_same_v<T, InteractionFrame>)
                return SavedInteractionFrame{snapshot_id,       value.invocation,
                                             value.program,     value.position,
                                             value.destination, value.command_results};
            else
                return SavedRoomTransitionFrame{
                    snapshot_id,          value.source_room, value.target_room,
                    value.selected_exit,  value.kind,        value.entry_cause,
                    value.source_context, value.position,    value.destination};
        },
        frame);
}

Result<std::optional<SavedFlowBlocker>, Diagnostics>
save_blocker(const SavedFrameMap& frame_ids, const std::optional<FlowBlocker>& blocker)
{
    if (!blocker)
        return Result<std::optional<SavedFlowBlocker>, Diagnostics>::success(std::nullopt);
    const auto owner = saved_owner(frame_ids, flow_blocker_owner(*blocker));
    if (!owner)
        return Result<std::optional<SavedFlowBlocker>, Diagnostics>::failure(Diagnostics{
            Diagnostic{.code = "save.invalid_blocker_owner",
                       .message = "The active blocker is not owned by a saved flow frame"}});
    if (std::holds_alternative<InputFlowBlocker>(*blocker))
        return Result<std::optional<SavedFlowBlocker>, Diagnostics>::success(
            SavedFlowBlocker{SavedInputBlocker{*owner}});
    if (const auto* duration = std::get_if<DurationFlowBlocker>(&*blocker))
        return Result<std::optional<SavedFlowBlocker>, Diagnostics>::success(
            SavedFlowBlocker{SavedDurationBlocker{*owner, duration->remaining}});
    if (std::holds_alternative<PresentationFlowBlocker>(*blocker))
        return Result<std::optional<SavedFlowBlocker>, Diagnostics>::failure(Diagnostics{
            Diagnostic{.code = "save.presentation_blocker_active",
                       .message = "An active presentation operation is not serializable"}});
    if (std::holds_alternative<AudioFlowBlocker>(*blocker))
        return Result<std::optional<SavedFlowBlocker>, Diagnostics>::failure(
            Diagnostics{Diagnostic{.code = "save.audio_blocker_active",
                                   .message = "An active audio operation is not serializable"}});
    return Result<std::optional<SavedFlowBlocker>, Diagnostics>::failure(
        Diagnostics{Diagnostic{.code = "save.opaque_script_suspension",
                               .message = "Opaque Lua coroutine suspension is not serializable"}});
}

Result<std::optional<SavedPresentationOwner>, Diagnostics>
save_presentation_owner(const SessionState& session, const SavedFrameMap& frame_ids,
                        const PresentationOwner& owner)
{
    return std::visit(
        [&session, &frame_ids](
            const auto& value) -> Result<std::optional<SavedPresentationOwner>, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ScenePresentationOwner>) {
                const auto invocation = saved_owner(frame_ids, value.invocation);
                if (!invocation)
                    return Result<std::optional<SavedPresentationOwner>, Diagnostics>::failure(
                        Diagnostics{Diagnostic{
                            .code = "save.invalid_presentation_owner",
                            .message = "Scene presentation owner is not a saved flow frame"}});
                return Result<std::optional<SavedPresentationOwner>, Diagnostics>::success(
                    SavedPresentationOwner{SavedScenePresentationOwner{*invocation, value.scene}});
            } else if constexpr (std::is_same_v<T, DialoguePresentationOwner>) {
                const auto invocation = saved_owner(frame_ids, value.invocation);
                if (!invocation)
                    return Result<std::optional<SavedPresentationOwner>, Diagnostics>::failure(
                        Diagnostics{Diagnostic{
                            .code = "save.invalid_presentation_owner",
                            .message = "Dialogue presentation owner is not a saved flow frame"}});
                return Result<std::optional<SavedPresentationOwner>, Diagnostics>::success(
                    SavedPresentationOwner{
                        SavedDialoguePresentationOwner{*invocation, value.dialogue}});
            } else if constexpr (std::is_same_v<T, CurrentRoomPresentationOwner>) {
                const auto active = session.current_room_presentation_owner();
                if (!active || *active != value)
                    return Result<std::optional<SavedPresentationOwner>, Diagnostics>::failure(
                        Diagnostics{Diagnostic{
                            .code = "save.invalid_presentation_owner",
                            .message = "Current-Room presentation owner is no longer active"}});
                return Result<std::optional<SavedPresentationOwner>, Diagnostics>::success(
                    SavedPresentationOwner{SavedCurrentRoomPresentationOwner{value.room}});
            } else if constexpr (std::is_same_v<T, RoomPresentationOwner>) {
                return Result<std::optional<SavedPresentationOwner>, Diagnostics>::success(
                    SavedPresentationOwner{SavedRoomPresentationOwner{value.room}});
            } else if constexpr (std::is_same_v<T, SessionPresentationOwner>) {
                if (value.session != session.presentation_session_id())
                    return Result<std::optional<SavedPresentationOwner>, Diagnostics>::failure(
                        Diagnostics{Diagnostic{
                            .code = "save.invalid_presentation_owner",
                            .message = "Session presentation owner belongs to another session"}});
                return Result<std::optional<SavedPresentationOwner>, Diagnostics>::success(
                    SavedPresentationOwner{SavedSessionPresentationOwner{}});
            } else {
                return Result<std::optional<SavedPresentationOwner>, Diagnostics>::success(
                    std::nullopt);
            }
        },
        owner);
}

Result<SavedActorPresentationKey, Diagnostics> save_actor_key(const SavedFrameMap& frame_ids,
                                                              const ActorPresentationKey& key)
{
    return std::visit(
        [&frame_ids](const auto& value) -> Result<SavedActorPresentationKey, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneActorKey>) {
                const auto invocation = saved_owner(frame_ids, value.owner.invocation);
                if (!invocation)
                    return Result<SavedActorPresentationKey, Diagnostics>::failure(Diagnostics{
                        Diagnostic{.code = "save.invalid_actor_owner",
                                   .message = "Scene actor owner is not a saved flow frame"}});
                return Result<SavedActorPresentationKey, Diagnostics>::success(
                    SavedSceneActorKey{{*invocation, value.owner.scene}, value.slot});
            } else {
                return Result<SavedActorPresentationKey, Diagnostics>::success(value);
            }
        },
        key);
}

Result<SavedMaterialOccurrence, Diagnostics>
save_material_occurrence(const SavedFrameMap& frame_ids, const MaterialOccurrence& occurrence)
{
    return std::visit(
        [&](const auto& value) -> Result<SavedMaterialOccurrence, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, BackgroundMaterialOccurrence>)
                return Result<SavedMaterialOccurrence, Diagnostics>::success(
                    SavedBackgroundMaterialOccurrence{});
            else if constexpr (std::is_same_v<T, ActorMaterialOccurrence>) {
                auto key = save_actor_key(frame_ids, value.key);
                if (!key)
                    return Result<SavedMaterialOccurrence, Diagnostics>::failure(key.error());
                return Result<SavedMaterialOccurrence, Diagnostics>::success(
                    SavedActorMaterialOccurrence{std::move(*key.value_if()), value.layer});
            } else if constexpr (std::is_same_v<T, PropMaterialOccurrence>)
                return Result<SavedMaterialOccurrence, Diagnostics>::success(
                    SavedPropMaterialOccurrence{value.instance});
            else if constexpr (std::is_same_v<T, EnvironmentMaterialOccurrence>)
                return Result<SavedMaterialOccurrence, Diagnostics>::success(
                    SavedEnvironmentMaterialOccurrence{value.instance});
            else if constexpr (std::is_same_v<T, LayoutMaterialOccurrence>)
                return Result<SavedMaterialOccurrence, Diagnostics>::success(
                    SavedLayoutMaterialOccurrence{value.key, value.material});
            else
                return Result<SavedMaterialOccurrence, Diagnostics>::success(
                    SavedPostprocessMaterialOccurrence{value.instance});
        },
        occurrence);
}

bool is_authored_room_overlay_default(const CompiledProject& project,
                                      const DesiredMountedLayout& layout) noexcept
{
    const auto* key = std::get_if<RoomOverlayLayoutMountKey>(&layout.key);
    const auto* owner = std::get_if<RoomPresentationOwner>(&layout.owner);
    if (key == nullptr || owner == nullptr || owner->room != key->room ||
        layout.scale_overrides != LayoutScaleOverrides{} ||
        layout.composition_group != PresentationCompositionGroup::World ||
        layout.policy.plane != PresentationPlane::WorldOverlay ||
        layout.policy.clock != LayoutClockDomain::Gameplay ||
        layout.policy.input != LayoutInputMode::None ||
        layout.policy.gameplay_pause != GameplayPausePolicy::Continue ||
        layout.policy.escape_dismissal != EscapeDismissalPolicy::Ignore ||
        layout.policy.entrance_operation || layout.policy.exit_operation)
        return false;
    const auto* room = project.find_room(key->room);
    if (room == nullptr)
        return false;
    const auto found = std::find_if(
        room->overlays.begin(), room->overlays.end(),
        [key](const compiled::RoomOverlay& overlay) { return overlay.id == key->overlay; });
    return found != room->overlays.end() && found->layout == layout.layout &&
           found->order == layout.policy.local_order &&
           (found->visible ? LayoutVisibility::Visible : LayoutVisibility::Hidden) ==
               layout.policy.visibility;
}

} // namespace

Result<SaveState, Diagnostics> make_save_state(const CompiledProject& project,
                                               const SessionState& session)
{
    Diagnostics diagnostics;
    if (session.m_execution_fault)
        add_preflight_error(diagnostics, "save.execution_fault",
                            "A faulted execution session cannot be saved");
    if (session.m_flow_running)
        add_preflight_error(diagnostics, "save.execution_in_progress",
                            "A session cannot be saved while flow execution is in progress");
    if (session.m_blocker && std::holds_alternative<ScriptFlowBlocker>(*session.m_blocker))
        add_preflight_error(diagnostics, "save.opaque_script_suspension",
                            "Opaque Lua coroutine suspension is not serializable");
    for (const auto& detached : session.m_detached_flow_executions) {
        if (detached.context.execution_fault)
            add_preflight_error(diagnostics, "save.detached_execution_fault",
                                "A faulted detached Flow cannot be saved");
        if (detached.context.running)
            add_preflight_error(diagnostics, "save.detached_execution_in_progress",
                                "A detached Flow cannot be saved while it is executing");
        if (detached.context.blocker &&
            std::holds_alternative<ScriptFlowBlocker>(*detached.context.blocker))
            add_preflight_error(diagnostics, "save.opaque_detached_script_suspension",
                                "Detached Lua coroutine suspension is not serializable");
        if (detached.context.blocker &&
            (std::holds_alternative<PresentationFlowBlocker>(*detached.context.blocker) ||
             std::holds_alternative<AudioFlowBlocker>(*detached.context.blocker)))
            add_preflight_error(diagnostics, "save.detached_causal_operation_active",
                                "Detached causal presentation/audio work is not reconstructible");
    }
    if (!diagnostics.empty())
        return Result<SaveState, Diagnostics>::failure(std::move(diagnostics));

    SavedFrameMap frame_ids;
    std::uint64_t next_snapshot_id = 1;
    const auto register_stack = [&](const FlowStack& stack) {
        for (const auto& frame : stack)
            frame_ids.emplace(flow_frame_id(frame).number(), SavedFlowFrameId{next_snapshot_id++});
    };
    register_stack(session.m_flow_stack);
    for (const auto& detached : session.m_detached_flow_executions)
        register_stack(detached.context.flow_stack);

    SaveState save{
        .metadata = {.project = project.identity().id,
                     .project_version = project.identity().version,
                     .save_contract = project.save_contract()},
        .play_time = session.m_play_time,
        .random_state = session.m_random_state,
        .next_runtime_instance_id = session.m_next_runtime_instance_id,
        .next_item_stack_id = session.m_next_item_stack_id,
        .room_entry_sequence = session.m_room_entry_sequence,
        .runtime_rooms = {},
        .runtime_characters = {},
        .runtime_interactables = {},
        .property_overrides = {},
        .characters = session.m_character_world,
        .interactables = session.m_interactables,
        .item_stacks = session.m_item_stacks,
        .active_room_visit = session.m_room_visit,
        .room_visits = {},
        .dialogue_line_history = {},
        .dialogue_choice_history = {},
        .text_log = session.m_text_log,
        .logical_timers = {},
        .pending_timer_completions = {},
        .background_overrides = {},
        .camera_views = {},
        .actors = {},
        .presentation_props = {},
        .presentation_environments = {},
        .material_parameters = {},
        .postprocess_effects = {},
        .mounted_layouts = {},
        .layout_state_slots = {},
        .desired_audio = {},
        .presented_text = session.m_presented_text,
        .active_choice = session.m_active_choice,
        .mode = session.m_mode,
        .flow_stack = {},
        .blocker = std::nullopt,
        .detached_flows = {},
        .execution_provenance = {},
    };

    save.runtime_rooms.reserve(session.m_runtime_rooms.size());
    for (const auto& value : session.m_runtime_rooms)
        save.runtime_rooms.push_back(SavedRuntimeRoomConfiguration{
            value.id, value.declared, value.birth_source, value.structural_override_source,
            value.provenance, value.birth_exit_target_overrides,
            value.structural_override_exit_target_overrides, value.exit_target_overrides});
    save.runtime_characters.reserve(session.m_runtime_characters.size());
    for (const auto& value : session.m_runtime_characters)
        save.runtime_characters.push_back(
            SavedRuntimeCharacterConfiguration{value.id, value.declared, value.birth_source,
                                               value.structural_override_source, value.provenance});
    save.runtime_interactables.reserve(session.m_runtime_interactables.size());
    for (const auto& value : session.m_runtime_interactables)
        save.runtime_interactables.push_back(SavedRuntimeInteractableConfiguration{
            value.id, value.declared, value.birth_source, value.structural_override_source,
            value.provenance});

    save.property_overrides.reserve(session.m_property_overrides.size());
    for (const auto& value : session.m_property_overrides)
        save.property_overrides.push_back(
            SavedPropertyOverride{value.target(), value.property_id(), value.override_value()});
    save.room_visits.reserve(session.m_room_visits.size());
    for (const auto& [room, count] : session.m_room_visits)
        save.room_visits.push_back(SavedRoomVisits{room, count});
    std::sort(save.room_visits.begin(), save.room_visits.end(),
              [](const SavedRoomVisits& left, const SavedRoomVisits& right) {
                  return left.room.text() < right.room.text();
              });
    for (const auto& [key, count] : session.m_dialogue_line_history)
        save.dialogue_line_history.push_back(SavedDialogueLineHistory{key, count});
    for (const auto& [key, count] : session.m_dialogue_choice_history)
        save.dialogue_choice_history.push_back(SavedDialogueChoiceHistory{key, count});
    save.logical_timers.reserve(session.m_logical_timers.size());
    for (const auto& timer : session.m_logical_timers)
        save.logical_timers.push_back(
            SavedLogicalTimer{{timer.id.number()}, timer.remaining, timer.repeat_interval});
    save.pending_timer_completions.reserve(session.m_pending_timer_completions.size());
    for (const auto& completion : session.m_pending_timer_completions)
        save.pending_timer_completions.push_back(
            SavedLogicalTimerCompletion{{completion.id.number()}, completion.occurrences});
    save.flow_stack.reserve(session.m_flow_stack.size());
    for (const auto& frame : session.m_flow_stack)
        save.flow_stack.push_back(
            save_frame(frame_ids, frame, *saved_owner(frame_ids, flow_frame_id(frame))));

    for (const auto& background : session.m_background_overrides) {
        auto owner = save_presentation_owner(session, frame_ids, background.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.background_overrides.push_back(
                SavedBackgroundOverride{**owner.value_if(), background.background});
    }
    for (const auto& camera : session.m_camera_views) {
        auto owner = save_presentation_owner(session, frame_ids, camera.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.camera_views.push_back(SavedCameraView{**owner.value_if(), camera.view});
    }
    for (const auto& actor : session.m_actors) {
        auto owner = save_presentation_owner(session, frame_ids, actor.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (!*owner.value_if())
            continue;
        auto key = save_actor_key(frame_ids, actor.key);
        if (!key)
            return Result<SaveState, Diagnostics>::failure(key.error());
        save.actors.push_back(SavedActorPresentation{
            *key.value_if(), **owner.value_if(), actor.character, actor.profile, actor.pose,
            actor.expression, actor.appearance, actor.idle, actor.placement, actor.visible,
            actor.presentation_complete});
    }
    for (const auto& prop : session.m_presentation_props) {
        auto owner = save_presentation_owner(session, frame_ids, prop.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.presentation_props.push_back(SavedPresentationProp{
                prop.instance, **owner.value_if(), prop.asset, prop.material, prop.placement,
                prop.bounds, prop.plane, prop.order, prop.visible});
    }
    for (const auto& environment : session.m_presentation_environments) {
        auto owner = save_presentation_owner(session, frame_ids, environment.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.presentation_environments.push_back(SavedPresentationEnvironment{
                environment.instance, **owner.value_if(), environment.stop_key, environment.asset,
                environment.material, environment.bounds, environment.plane, environment.order,
                environment.clock, environment.scroll_per_second, environment.opacity,
                environment.visible});
    }
    for (const auto& parameter : session.m_material_parameters) {
        auto owner = save_presentation_owner(session, frame_ids, parameter.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (!*owner.value_if())
            continue;
        auto occurrence = save_material_occurrence(frame_ids, parameter.occurrence);
        if (!occurrence)
            return Result<SaveState, Diagnostics>::failure(occurrence.error());
        save.material_parameters.push_back(SavedMaterialParameter{
            **owner.value_if(), std::move(*occurrence.value_if()), parameter.material,
            parameter.parameter, parameter.value, parameter.binding, parameter.clock});
    }
    for (const auto& effect : session.m_postprocess_effects) {
        auto owner = save_presentation_owner(session, frame_ids, effect.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.postprocess_effects.push_back(
                SavedPostprocessEffect{effect.instance, **owner.value_if(), effect.material,
                                       effect.scope, effect.order, effect.clock, effect.visible});
    }
    for (const auto& layout : session.m_mounted_layouts) {
        if (is_authored_room_overlay_default(project, layout))
            continue;
        auto owner = save_presentation_owner(session, frame_ids, layout.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.mounted_layouts.push_back(
                SavedMountedLayout{layout.key, **owner.value_if(), layout.layout, layout.policy,
                                   layout.scale_overrides, layout.composition_group, layout.inputs,
                                   layout.connected_signals});
    }
    for (const auto& slot : session.m_layout_state_slots) {
        auto saved_scope_owner = std::visit(
            [&](const auto& owner) -> Result<SavedLayoutStateScopeOwner, Diagnostics> {
                using T = std::decay_t<decltype(owner)>;
                if constexpr (std::is_same_v<T, LayoutVisitStateOwner>) {
                    const auto active = session.current_room_presentation_owner();
                    if (!active || active->visit != owner.visit)
                        return Result<SavedLayoutStateScopeOwner,
                                      Diagnostics>::failure(Diagnostics{Diagnostic{
                            .code = "save.invalid_layout_state_owner",
                            .message =
                                "Visit Layout Slot no longer belongs to the Active Room Context"}});
                    return Result<SavedLayoutStateScopeOwner, Diagnostics>::success(
                        SavedVisitLayoutStateOwner{active->room});
                } else if constexpr (std::is_same_v<T, LayoutRoomStateOwner>) {
                    return Result<SavedLayoutStateScopeOwner, Diagnostics>::success(
                        SavedRoomLayoutStateOwner{owner.room});
                } else if constexpr (std::is_same_v<T, LayoutFlowStateOwner>) {
                    const auto flow = saved_owner(frame_ids, owner.flow);
                    if (!flow)
                        return Result<SavedLayoutStateScopeOwner, Diagnostics>::failure(
                            Diagnostics{Diagnostic{
                                .code = "save.invalid_layout_state_owner",
                                .message = "Flow Layout Slot owner is not a saved flow frame"}});
                    return Result<SavedLayoutStateScopeOwner, Diagnostics>::success(
                        SavedFlowLayoutStateOwner{*flow});
                } else {
                    if (owner.session != session.presentation_session_id())
                        return Result<SavedLayoutStateScopeOwner, Diagnostics>::failure(
                            Diagnostics{Diagnostic{
                                .code = "save.invalid_layout_state_owner",
                                .message = "Session Layout Slot belongs to another session"}});
                    return Result<SavedLayoutStateScopeOwner, Diagnostics>::success(
                        SavedSessionLayoutStateOwner{});
                }
            },
            slot.scope_owner);
        if (!saved_scope_owner)
            return Result<SaveState, Diagnostics>::failure(saved_scope_owner.error());
        save.layout_state_slots.push_back(
            SavedLayoutStateSlot{*saved_scope_owner.value_if(), slot.key, slot.layout, slot.value});
    }
    for (const auto& audio : session.m_desired_audio) {
        auto owner = save_presentation_owner(session, frame_ids, audio.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.desired_audio.push_back(SavedDesiredAudio{
                audio.instance, **owner.value_if(), audio.purpose, audio.pause_policy, audio.asset,
                audio.gain, audio.pan, audio.pan_source, audio.fade_in, audio.fade_out,
                audio.replacement_key});
    }

    auto foreground_blocker = save_blocker(frame_ids, session.m_blocker);
    if (!foreground_blocker)
        return Result<SaveState, Diagnostics>::failure(foreground_blocker.error());
    save.blocker = std::move(*foreground_blocker.value_if());

    save.detached_flows.reserve(session.m_detached_flow_executions.size());
    for (const auto& detached : session.m_detached_flow_executions) {
        SavedDetachedFlowExecution saved{
            .owner = detached.owner,
            .flow_owner =
                detached.flow_owner ? saved_owner(frame_ids, *detached.flow_owner) : std::nullopt,
            .room_entry_sequence = detached.room_entry_sequence,
            .flow_stack = {},
            .blocker = std::nullopt,
        };
        if (detached.owner == compiled::DetachedSceneOwner::Flow && !saved.flow_owner)
            return Result<SaveState, Diagnostics>::failure(Diagnostics{Diagnostic{
                .code = "save.invalid_detached_owner",
                .message = "Flow-owned detached Scene owner is not part of the saved ancestry"}});
        saved.flow_stack.reserve(detached.context.flow_stack.size());
        for (const auto& frame : detached.context.flow_stack)
            saved.flow_stack.push_back(
                save_frame(frame_ids, frame, *saved_owner(frame_ids, flow_frame_id(frame))));
        auto blocker = save_blocker(frame_ids, detached.context.blocker);
        if (!blocker)
            return Result<SaveState, Diagnostics>::failure(blocker.error());
        saved.blocker = std::move(*blocker.value_if());
        save.detached_flows.push_back(std::move(saved));
    }

    std::unordered_map<std::uint64_t, std::uint64_t> provenance_ids;
    provenance_ids.reserve(session.m_execution_provenance.size());
    for (std::size_t index = 0; index < session.m_execution_provenance.size(); ++index)
        provenance_ids.emplace(session.m_execution_provenance[index].frame.number(), index + 1);
    save.execution_provenance.reserve(session.m_execution_provenance.size());
    for (const auto& provenance : session.m_execution_provenance) {
        const auto id = provenance_ids.find(provenance.frame.number());
        const auto root = provenance_ids.find(provenance.root.number());
        const auto parent = provenance.parent ? provenance_ids.find(provenance.parent->number())
                                              : provenance_ids.end();
        const auto source = provenance.source ? provenance_ids.find(provenance.source->number())
                                              : provenance_ids.end();
        if (id == provenance_ids.end() || root == provenance_ids.end() ||
            (provenance.parent && parent == provenance_ids.end()) ||
            (provenance.source && source == provenance_ids.end()))
            return Result<SaveState, Diagnostics>::failure(Diagnostics{Diagnostic{
                .code = "save.invalid_execution_provenance",
                .message = "Execution Provenance references an unknown causal identity"}});
        save.execution_provenance.push_back(SavedExecutionProvenance{
            .id = id->second,
            .active_frame = saved_owner(frame_ids, provenance.frame),
            .parent = provenance.parent ? std::optional{parent->second} : std::nullopt,
            .root = root->second,
            .relationship = provenance.relationship,
            .source = provenance.source ? std::optional{source->second} : std::nullopt,
            .state = provenance.state,
        });
    }
    if (!diagnostics.empty())
        return Result<SaveState, Diagnostics>::failure(std::move(diagnostics));
    return Result<SaveState, Diagnostics>::success(std::move(save));
}

} // namespace noveltea::core
