#include "noveltea/script/typed_execution_kernel.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace noveltea::script {
namespace {

core::Diagnostics execution_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

core::Diagnostics script_diagnostics(const ScriptError& error)
{
    return execution_error("execution.room_script_failed", error.message);
}

core::Diagnostics execution_diagnostics(const TypedExecutionError& error)
{
    if (const auto* diagnostics = std::get_if<core::Diagnostics>(&error))
        return *diagnostics;
    return script_diagnostics(std::get<ScriptError>(error));
}

const core::compiled::RoomExit* find_exit(const core::compiled::RoomDefinition& room,
                                          const core::RoomExitId& exit)
{
    const auto found = std::find_if(
        room.exits.begin(), room.exits.end(),
        [&exit](const core::compiled::RoomExit& candidate) { return candidate.id == exit; });
    return found == room.exits.end() ? nullptr : &*found;
}

const core::compiled::RoomHookProgram* find_hook(const core::compiled::RoomDefinition& room,
                                                 core::compiled::RoomHookKind hook)
{
    const auto found = std::find_if(room.lifecycle.hooks.begin(), room.lifecycle.hooks.end(),
                                    [hook](const core::compiled::RoomHookProgram& candidate) {
                                        return candidate.hook == hook;
                                    });
    return found == room.lifecycle.hooks.end() ? nullptr : &*found;
}

struct HookSelection {
    const core::compiled::RoomDefinition* room = nullptr;
    const core::compiled::RoomHookProgram* hook = nullptr;
};

HookSelection select_hook(const core::CompiledProject& project,
                          const core::RoomTransitionFrame& transition)
{
    const core::compiled::RoomDefinition* room = nullptr;
    std::optional<core::compiled::RoomHookKind> kind;
    switch (transition.position.stage) {
    case core::RoomTransitionStage::BeforeLeave:
        room = transition.source_room ? project.find_room(*transition.source_room) : nullptr;
        kind = core::compiled::RoomHookKind::BeforeLeave;
        break;
    case core::RoomTransitionStage::BeforeEnter:
        room = project.find_room(transition.target_room);
        kind = core::compiled::RoomHookKind::BeforeEnter;
        break;
    case core::RoomTransitionStage::AfterLeave:
        room = transition.source_room ? project.find_room(*transition.source_room) : nullptr;
        kind = core::compiled::RoomHookKind::AfterLeave;
        break;
    case core::RoomTransitionStage::AfterEnter:
        room = project.find_room(transition.target_room);
        kind = core::compiled::RoomHookKind::AfterEnter;
        break;
    default:
        break;
    }
    return {room, room != nullptr && kind ? find_hook(*room, *kind) : nullptr};
}

core::RoomTransitionStage next_hook_stage(const core::RoomTransitionFrame& transition) noexcept
{
    switch (transition.position.stage) {
    case core::RoomTransitionStage::BeforeLeave:
        return core::RoomTransitionStage::BeforeEnter;
    case core::RoomTransitionStage::BeforeEnter:
        return core::RoomTransitionStage::CommitRoomSwitch;
    case core::RoomTransitionStage::AfterLeave:
        return core::RoomTransitionStage::AfterEnter;
    case core::RoomTransitionStage::AfterEnter:
        return core::RoomTransitionStage::Complete;
    default:
        return transition.position.stage;
    }
}

bool is_current_placement(const core::InteractableState& state, const core::RoomId& room,
                          const core::RoomPlacementId& placement) noexcept
{
    const auto* current = std::get_if<core::compiled::RoomPlacementRef>(&state.location);
    return current != nullptr && current->room == room && current->placement_id == placement;
}

} // namespace

std::optional<core::FlowRunOutcome>
TypedExecutionKernel::run_room_unit(std::string_view runtime_locale)
{
    auto fault = [this](core::Diagnostics diagnostics) -> std::optional<core::FlowRunOutcome> {
        const auto copy = diagnostics;
        (void)m_flow.fault(std::move(diagnostics));
        return core::FlowFaultOutcome{copy};
    };
    if (m_state.flow_stack().empty())
        return fault(execution_error("execution.invalid_stack",
                                     "Room execution requires an active transition frame"));
    const auto* active = std::get_if<core::RoomTransitionFrame>(&m_state.flow_stack().back());
    if (active == nullptr)
        return fault(execution_error("execution.invalid_room_transition",
                                     "Active flow frame is not a Room transition"));
    const core::RoomTransitionFrame transition = *active;
    const auto* target = m_project.find_room(transition.target_room);
    if (target == nullptr)
        return fault(
            execution_error("execution.invalid_room_target", "Room transition target is missing"));

    auto advance =
        [this, &transition,
         &fault](core::RoomTransitionPosition position) -> std::optional<core::FlowRunOutcome> {
        auto advanced = m_flow.advance_room_transition(transition.position, std::move(position));
        return advanced ? std::nullopt : fault(advanced.error());
    };
    auto reject = [this]() -> std::optional<core::FlowRunOutcome> {
        auto rejected = m_flow.reject_room_transition();
        if (!rejected)
            return core::FlowFaultOutcome{rejected.error()};
        return core::FlowModeChangedOutcome{m_state.mode()};
    };
    auto condition = [this, &fault, &reject](
                         const core::Condition& value) -> std::optional<core::FlowRunOutcome> {
        auto evaluated = evaluate(value);
        if (!evaluated)
            return fault(execution_diagnostics(evaluated.error()));
        const auto* result = evaluated.value_if();
        if (result == nullptr)
            return fault(execution_error("execution.invalid_condition_result",
                                         "Room lifecycle condition produced no value"));
        return *result ? std::nullopt : reject();
    };

    switch (transition.position.stage) {
    case core::RoomTransitionStage::SourceCanLeave: {
        const auto* source =
            transition.source_room ? m_project.find_room(*transition.source_room) : nullptr;
        if (source == nullptr)
            return fault(execution_error("execution.invalid_room_source",
                                         "Room transition source is missing"));
        if (auto outcome = condition(source->lifecycle.can_leave))
            return outcome;
        return advance({transition.selected_exit ? core::RoomTransitionStage::ExitCondition
                                                 : core::RoomTransitionStage::TargetCanEnter,
                        0, false});
    }
    case core::RoomTransitionStage::ExitCondition: {
        const auto* source =
            transition.source_room ? m_project.find_room(*transition.source_room) : nullptr;
        const auto* exit = source != nullptr && transition.selected_exit
                               ? find_exit(*source, transition.selected_exit->exit_id)
                               : nullptr;
        if (exit == nullptr || exit->target != transition.target_room)
            return fault(execution_error("execution.invalid_room_exit",
                                         "Selected Room exit is missing or mismatched"));
        if (auto outcome = condition(exit->condition))
            return outcome;
        return advance({core::RoomTransitionStage::TargetCanEnter, 0, false});
    }
    case core::RoomTransitionStage::TargetCanEnter:
        if (auto outcome = condition(target->lifecycle.can_enter))
            return outcome;
        return advance({transition.source_room ? core::RoomTransitionStage::BeforeLeave
                                               : core::RoomTransitionStage::BeforeEnter,
                        0, false});
    case core::RoomTransitionStage::BeforeLeave:
    case core::RoomTransitionStage::BeforeEnter:
    case core::RoomTransitionStage::AfterLeave:
    case core::RoomTransitionStage::AfterEnter: {
        const auto selected = select_hook(m_project, transition);
        if (selected.room == nullptr)
            return fault(execution_error("execution.invalid_room_hook_owner",
                                         "Room lifecycle hook owner is missing"));
        const std::size_t effect_count =
            selected.hook == nullptr ? 0 : selected.hook->effects.size();
        if (transition.position.awaiting_completion) {
            auto position = transition.position;
            ++position.next_effect;
            position.awaiting_completion = false;
            return advance(std::move(position));
        }
        if (transition.position.next_effect >= effect_count)
            return advance({next_hook_stage(transition), 0, false});

        auto applied =
            apply(selected.hook->effects[transition.position.next_effect], "room-lifecycle-effect");
        if (!applied)
            return fault(execution_diagnostics(applied.error()));
        const auto* effect = applied.value_if();
        const bool suspended =
            effect != nullptr && std::holds_alternative<ScriptInvocationSuspended>(*effect);
        auto position = transition.position;
        if (suspended) {
            position.awaiting_completion = true;
            auto marked = m_flow.mark_room_transition_wait(transition.position, position);
            if (!marked)
                return fault(marked.error());
            return core::FlowBlockedOutcome{*m_state.blocker()};
        }
        ++position.next_effect;
        return advance(std::move(position));
    }
    case core::RoomTransitionStage::CommitRoomSwitch: {
        auto committed = m_state.commit_room_entry(m_project, transition.target_room);
        if (!committed)
            return fault(committed.error());
        return advance({transition.source_room ? core::RoomTransitionStage::AfterLeave
                                               : core::RoomTransitionStage::AfterEnter,
                        0, false});
    }
    case core::RoomTransitionStage::Complete: {
        auto completed = m_flow.complete_room_transition();
        if (!completed)
            return fault(completed.error());
        return core::FlowModeChangedOutcome{m_state.mode()};
    }
    }
    return fault(execution_error("execution.invalid_room_transition_position",
                                 "Room transition stage is invalid"));
}

core::Result<void, core::Diagnostics> TypedExecutionKernel::navigate(const core::RoomExitId& exit)
{
    const auto* mode = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* room = mode == nullptr ? nullptr : m_project.find_room(mode->room);
    const auto* selected = room == nullptr ? nullptr : find_exit(*room, exit);
    if (mode == nullptr || room == nullptr || selected == nullptr || !m_state.flow_stack().empty())
        return core::Result<void, core::Diagnostics>::failure(execution_error(
            "execution.invalid_navigation", "Navigation requires an exit from the active Room"));
    return m_flow.start_navigation(selected->target, {mode->room, selected->id});
}

core::Result<void, core::Diagnostics>
TypedExecutionKernel::start_transient(const core::SceneId& scene)
{
    return m_flow.start_transient(scene);
}

core::Result<void, core::Diagnostics>
TypedExecutionKernel::start_transient(const core::DialogueId& dialogue)
{
    return m_flow.start_transient(dialogue);
}

core::Result<core::RoomView, TypedExecutionError>
TypedExecutionKernel::room_view(std::string_view runtime_locale)
{
    const auto* mode = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* room = mode == nullptr ? nullptr : m_project.find_room(mode->room);
    if (mode == nullptr || room == nullptr || !m_state.flow_stack().empty())
        return core::Result<core::RoomView, TypedExecutionError>::failure(execution_error(
            "execution.room_view_unavailable", "Room view requires an active completed Room mode"));

    auto description = resolve(room->description.source, runtime_locale);
    if (!description)
        return core::Result<core::RoomView, TypedExecutionError>::failure(description.error());
    auto* description_value = description.value_if();
    if (description_value == nullptr)
        return core::Result<core::RoomView, TypedExecutionError>::failure(
            execution_error("execution.invalid_text_result", "Room description produced no value"));

    core::RoomView view{.room = room->identity.id,
                        .visits = m_state.room_visits(room->identity.id),
                        .description = std::move(*description_value),
                        .description_markup = room->description.markup,
                        .background = room->background,
                        .overlays = {},
                        .placements = {},
                        .exits = {},
                        .controls = {}};
    for (const auto& overlay : room->overlays) {
        const auto state = std::find_if(m_state.overlays().begin(), m_state.overlays().end(),
                                        [&room, &overlay](const core::RoomOverlayState& candidate) {
                                            return candidate.room == room->identity.id &&
                                                   candidate.overlay == overlay.id;
                                        });
        view.overlays.push_back(
            {overlay.id, overlay.layout,
             state == m_state.overlays().end() ? overlay.enabled : state->visible});
    }
    for (const auto& placement : room->placements) {
        std::optional<std::string> label;
        core::TextMarkup markup = core::TextMarkup::Plain;
        if (placement.presentation.label) {
            auto resolved = resolve(placement.presentation.label->source, runtime_locale);
            if (!resolved)
                return core::Result<core::RoomView, TypedExecutionError>::failure(resolved.error());
            auto* value = resolved.value_if();
            if (value == nullptr)
                return core::Result<core::RoomView, TypedExecutionError>::failure(execution_error(
                    "execution.invalid_text_result", "Room placement label produced no value"));
            label = std::move(*value);
            markup = placement.presentation.label->markup;
        }
        const auto* state = m_state.interactable(placement.interactable);
        const bool placed =
            state != nullptr && is_current_placement(*state, room->identity.id, placement.id);
        view.placements.push_back({placement.id, placement.interactable, placement.bounds,
                                   std::move(label), markup, placement.presentation.layout,
                                   placed && state->enabled, placed && state->visible});
    }
    for (const auto& exit : room->exits) {
        auto label = resolve(exit.label.source, runtime_locale);
        if (!label)
            return core::Result<core::RoomView, TypedExecutionError>::failure(label.error());
        auto* label_value = label.value_if();
        if (label_value == nullptr)
            return core::Result<core::RoomView, TypedExecutionError>::failure(execution_error(
                "execution.invalid_text_result", "Room exit label produced no value"));
        auto enabled = evaluate(exit.condition);
        if (!enabled)
            return core::Result<core::RoomView, TypedExecutionError>::failure(enabled.error());
        const auto* enabled_value = enabled.value_if();
        if (enabled_value == nullptr)
            return core::Result<core::RoomView, TypedExecutionError>::failure(execution_error(
                "execution.invalid_condition_result", "Room exit condition produced no value"));
        view.exits.push_back(
            {exit.id, exit.target, exit.direction, std::move(*label_value), *enabled_value});
    }
    auto inventory = inventory_view(runtime_locale);
    auto* inventory_value = inventory.value_if();
    if (inventory_value == nullptr)
        return core::Result<core::RoomView, TypedExecutionError>::failure(inventory.error());
    view.controls = std::move(inventory_value->controls);
    return core::Result<core::RoomView, TypedExecutionError>::success(std::move(view));
}

} // namespace noveltea::script
