#include "noveltea/core/save_state.hpp"

#include <algorithm>
#include <type_traits>

namespace noveltea::core {
namespace {

void add_preflight_error(Diagnostics& diagnostics, std::string code, std::string message)
{
    diagnostics.push_back(Diagnostic{.code = std::move(code), .message = std::move(message)});
}

std::optional<SavedFlowFrameId> saved_owner(const FlowStack& stack,
                                            const FlowFrameId& owner) noexcept
{
    for (std::size_t index = 0; index < stack.size(); ++index) {
        if (flow_frame_id(stack[index]) == owner)
            return SavedFlowFrameId{index + 1};
    }
    return std::nullopt;
}

SavedFlowFrame save_frame(const FlowFrame& frame, std::size_t index)
{
    const SavedFlowFrameId snapshot_id{index + 1};
    return std::visit(
        [snapshot_id](const auto& value) -> SavedFlowFrame {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneFrame>)
                return SavedSceneFrame{snapshot_id, value.scene, value.position, value.destination};
            else if constexpr (std::is_same_v<T, DialogueFrame>)
                return SavedDialogueFrame{snapshot_id,       value.dialogue,    value.position,
                                          value.stage_slots, value.media_slots, value.destination};
            else if constexpr (std::is_same_v<T, InteractionFrame>)
                return SavedInteractionFrame{snapshot_id, value.invocation, value.program,
                                             value.position, value.destination};
            else
                return SavedRoomTransitionFrame{
                    snapshot_id,          value.source_room, value.target_room,
                    value.selected_exit,  value.kind,        value.entry_cause,
                    value.source_context, value.position,    value.destination};
        },
        frame);
}

Result<std::optional<SavedPresentationOwner>, Diagnostics>
save_presentation_owner(const SessionState& session, const PresentationOwner& owner)
{
    return std::visit(
        [&session](
            const auto& value) -> Result<std::optional<SavedPresentationOwner>, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ScenePresentationOwner>) {
                const auto invocation = saved_owner(session.flow_stack(), value.invocation);
                if (!invocation)
                    return Result<std::optional<SavedPresentationOwner>, Diagnostics>::failure(
                        Diagnostics{Diagnostic{
                            .code = "save.invalid_presentation_owner",
                            .message = "Scene presentation owner is not a saved flow frame"}});
                return Result<std::optional<SavedPresentationOwner>, Diagnostics>::success(
                    SavedPresentationOwner{SavedScenePresentationOwner{*invocation, value.scene}});
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

Result<SavedActorPresentationKey, Diagnostics> save_actor_key(const SessionState& session,
                                                              const ActorPresentationKey& key)
{
    return std::visit(
        [&session](const auto& value) -> Result<SavedActorPresentationKey, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneActorKey>) {
                const auto invocation = saved_owner(session.flow_stack(), value.owner.invocation);
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
save_material_occurrence(const SessionState& session, const MaterialOccurrence& occurrence)
{
    return std::visit(
        [&](const auto& value) -> Result<SavedMaterialOccurrence, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, BackgroundMaterialOccurrence>)
                return Result<SavedMaterialOccurrence, Diagnostics>::success(
                    SavedBackgroundMaterialOccurrence{});
            else if constexpr (std::is_same_v<T, ActorMaterialOccurrence>) {
                auto key = save_actor_key(session, value.key);
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
    if (!diagnostics.empty())
        return Result<SaveState, Diagnostics>::failure(std::move(diagnostics));

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
    for (std::size_t index = 0; index < session.m_flow_stack.size(); ++index)
        save.flow_stack.push_back(save_frame(session.m_flow_stack[index], index));

    for (const auto& background : session.m_background_overrides) {
        auto owner = save_presentation_owner(session, background.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.background_overrides.push_back(
                SavedBackgroundOverride{**owner.value_if(), background.background});
    }
    for (const auto& camera : session.m_camera_views) {
        auto owner = save_presentation_owner(session, camera.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.camera_views.push_back(SavedCameraView{**owner.value_if(), camera.view});
    }
    for (const auto& actor : session.m_actors) {
        auto owner = save_presentation_owner(session, actor.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (!*owner.value_if())
            continue;
        auto key = save_actor_key(session, actor.key);
        if (!key)
            return Result<SaveState, Diagnostics>::failure(key.error());
        save.actors.push_back(SavedActorPresentation{
            *key.value_if(), **owner.value_if(), actor.character, actor.profile, actor.pose,
            actor.expression, actor.appearance, actor.idle, actor.placement, actor.visible,
            actor.presentation_complete});
    }
    for (const auto& prop : session.m_presentation_props) {
        auto owner = save_presentation_owner(session, prop.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.presentation_props.push_back(SavedPresentationProp{
                prop.instance, **owner.value_if(), prop.asset, prop.material, prop.placement,
                prop.bounds, prop.plane, prop.order, prop.visible});
    }
    for (const auto& environment : session.m_presentation_environments) {
        auto owner = save_presentation_owner(session, environment.owner);
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
        auto owner = save_presentation_owner(session, parameter.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (!*owner.value_if())
            continue;
        auto occurrence = save_material_occurrence(session, parameter.occurrence);
        if (!occurrence)
            return Result<SaveState, Diagnostics>::failure(occurrence.error());
        save.material_parameters.push_back(SavedMaterialParameter{
            **owner.value_if(), std::move(*occurrence.value_if()), parameter.material,
            parameter.parameter, parameter.value, parameter.binding, parameter.clock});
    }
    for (const auto& effect : session.m_postprocess_effects) {
        auto owner = save_presentation_owner(session, effect.owner);
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
        auto owner = save_presentation_owner(session, layout.owner);
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
                    const auto flow = saved_owner(session.flow_stack(), owner.flow);
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
        auto owner = save_presentation_owner(session, audio.owner);
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(owner.error());
        if (*owner.value_if())
            save.desired_audio.push_back(SavedDesiredAudio{
                audio.instance, **owner.value_if(), audio.purpose, audio.pause_policy, audio.asset,
                audio.gain, audio.pan, audio.pan_source, audio.fade_in, audio.fade_out,
                audio.replacement_key});
    }

    if (session.m_blocker) {
        const auto owner =
            saved_owner(session.m_flow_stack, flow_blocker_owner(*session.m_blocker));
        if (!owner)
            return Result<SaveState, Diagnostics>::failure(Diagnostics{
                Diagnostic{.code = "save.invalid_blocker_owner",
                           .message = "The active blocker is not owned by a saved flow frame"}});
        if (const auto* input = std::get_if<InputFlowBlocker>(&*session.m_blocker)) {
            (void)input;
            save.blocker = SavedInputBlocker{*owner};
        } else if (const auto* duration = std::get_if<DurationFlowBlocker>(&*session.m_blocker)) {
            save.blocker = SavedDurationBlocker{*owner, duration->remaining};
        } else if (std::holds_alternative<PresentationFlowBlocker>(*session.m_blocker)) {
            add_preflight_error(diagnostics, "save.presentation_blocker_active",
                                "An active presentation operation is not serializable");
        } else if (std::holds_alternative<AudioFlowBlocker>(*session.m_blocker)) {
            add_preflight_error(diagnostics, "save.audio_blocker_active",
                                "An active audio operation is not serializable");
        } else if (std::holds_alternative<ScriptFlowBlocker>(*session.m_blocker)) {
            add_preflight_error(diagnostics, "save.opaque_script_suspension",
                                "Opaque Lua coroutine suspension is not serializable");
        }
    }
    if (!diagnostics.empty())
        return Result<SaveState, Diagnostics>::failure(std::move(diagnostics));
    return Result<SaveState, Diagnostics>::success(std::move(save));
}

} // namespace noveltea::core
