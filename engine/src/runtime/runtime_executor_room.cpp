#include "noveltea/runtime/runtime_executor.hpp"

#include "noveltea/core/room_presentation.hpp"

#include <algorithm>
#include <sstream>
#include <type_traits>
#include <utility>

namespace noveltea::runtime {
namespace {

core::Diagnostics execution_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

core::Diagnostics script_diagnostics(const ScriptInvocationError& error)
{
    return execution_error("execution.room_script_failed", error.message);
}

core::Diagnostics execution_diagnostics(const RuntimeExecutionError& error)
{
    if (const auto* diagnostics = std::get_if<core::Diagnostics>(&error))
        return *diagnostics;
    return script_diagnostics(std::get<ScriptInvocationError>(error));
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

std::string lua_quote(std::string_view value)
{
    std::string result{"\""};
    for (const char character : value) {
        if (character == '\\' || character == '"')
            result.push_back('\\');
        result.push_back(character);
    }
    result.push_back('"');
    return result;
}

class RuntimeRoomComposition final : public core::RoomCompositionCallback {
public:
    RuntimeRoomComposition(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                           RuntimeCommandGateway& gateway) noexcept
        : m_project(project), m_scripts(scripts), m_gateway(gateway)
    {
    }

    core::Result<void, core::Diagnostics> compose(const core::compiled::RoomCompositionHook& hook,
                                                  const core::RoomVisitContext& visit,
                                                  core::RoomPresentationDraft& draft) override
    {
        const auto* resource = m_project.find_script(hook.script);
        if (resource == nullptr)
            return core::Result<void, core::Diagnostics>::failure(execution_error(
                "room_composition.missing_script", "Room composition Script is missing"));

        runtime::RoomCompositionDraftAccess access(draft);
        runtime::RuntimeCapabilityIssuer issuer(m_gateway, m_gateway.generation());
        const auto capabilities = issuer.issue_room_composition(access);
        struct CloseDraft final {
            runtime::RoomCompositionDraftAccess& access;
            ~CloseDraft() { access.close(); }
        } close{access};

        runtime::ScriptInvocationRequest load{.source = {},
                                              .chunk_name = "room-compose-resource",
                                              .owner = std::nullopt,
                                              .invocation = std::nullopt,
                                              .source_context = m_gateway.current_source_context(),
                                              .result_kind =
                                                  runtime::ScriptInvocationResultKind::None,
                                              .asset_path = std::nullopt};
        if (const auto* inline_source =
                std::get_if<core::compiled::InlineLuaSource>(&resource->source)) {
            load.source = inline_source->source;
        } else {
            const auto* asset_source =
                std::get_if<core::compiled::AssetScriptSource>(&resource->source);
            const auto* asset = asset_source ? m_project.find_asset(asset_source->asset) : nullptr;
            if (asset == nullptr)
                return core::Result<void, core::Diagnostics>::failure(execution_error(
                    "room_composition.missing_asset", "Room composition Script asset is missing"));
            load.asset_path = asset->path;
        }
        auto loaded = m_scripts.invoke(load, capabilities);
        if (!loaded)
            return core::Result<void, core::Diagnostics>::failure(
                script_diagnostics(loaded.error()));

        std::ostringstream invocation;
        invocation << "local context = { room = " << lua_quote(visit.room.text())
                   << ", visit_index = " << visit.visit_index;
        if (visit.source_room)
            invocation << ", source_room = " << lua_quote(visit.source_room->text());
        if (visit.entry_exit)
            invocation << ", entry_room = " << lua_quote(visit.entry_exit->room.text())
                       << ", entry_exit = " << lua_quote(visit.entry_exit->exit_id.text());
        invocation << " }; if type(room) ~= 'table' or type(room.compose) ~= 'function' then "
                      "error('Room composition Script must define room.compose(context, "
                      "presentation)') end; room.compose(context, noveltea.room_presentation)";
        runtime::ScriptInvocationRequest call{.source = invocation.str(),
                                              .chunk_name = "room-compose-call",
                                              .owner = std::nullopt,
                                              .invocation = std::nullopt,
                                              .source_context = m_gateway.current_source_context(),
                                              .result_kind =
                                                  runtime::ScriptInvocationResultKind::None,
                                              .asset_path = std::nullopt};
        auto invoked = m_scripts.invoke(call, capabilities);
        if (!invoked)
            return core::Result<void, core::Diagnostics>::failure(
                script_diagnostics(invoked.error()));
        const auto* outcome = invoked.value_if();
        if (outcome == nullptr ||
            !std::holds_alternative<runtime::ScriptInvocationCompleted>(*outcome))
            return core::Result<void, core::Diagnostics>::failure(
                execution_error("room_composition.invalid_completion",
                                "Room composition must complete synchronously without yielding"));
        return core::Result<void, core::Diagnostics>::success();
    }

private:
    const core::CompiledProject& m_project;
    ScriptInvocationPort& m_scripts;
    RuntimeCommandGateway& m_gateway;
};

} // namespace

std::optional<core::FlowRunOutcome> RuntimeExecutor::run_room_unit(std::string_view runtime_locale)
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
        auto committed =
            m_state.commit_room_entry(m_project, transition.target_room, transition.selected_exit);
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

core::Result<void, core::Diagnostics> RuntimeExecutor::navigate(const core::RoomExitId& exit)
{
    const auto* mode = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* room = mode == nullptr ? nullptr : m_project.find_room(mode->room);
    const auto* selected = room == nullptr ? nullptr : find_exit(*room, exit);
    if (mode == nullptr || room == nullptr || selected == nullptr || !m_state.flow_stack().empty())
        return core::Result<void, core::Diagnostics>::failure(execution_error(
            "execution.invalid_navigation", "Navigation requires an exit from the active Room"));
    return m_flow.start_navigation(selected->target, {mode->room, selected->id});
}

core::Result<void, core::Diagnostics> RuntimeExecutor::start_transient(const core::SceneId& scene)
{
    return m_flow.start_transient(scene);
}

core::Result<void, core::Diagnostics>
RuntimeExecutor::start_transient(const core::DialogueId& dialogue)
{
    return m_flow.start_transient(dialogue);
}

core::Result<core::RoomView, RuntimeExecutionError>
RuntimeExecutor::room_view(std::string_view runtime_locale)
{
    const auto* mode = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* visit = m_state.room_visit() ? &*m_state.room_visit() : nullptr;
    if (mode == nullptr || visit == nullptr || visit->room != mode->room ||
        !m_state.flow_stack().empty())
        return core::Result<core::RoomView, RuntimeExecutionError>::failure(execution_error(
            "execution.room_view_unavailable", "Room view requires an active completed Room mode"));
    auto refreshed = refresh_room_presentation(runtime_locale);
    if (!refreshed)
        return core::Result<core::RoomView, RuntimeExecutionError>::failure(refreshed.error());
    if (!m_room_presentation)
        return core::Result<core::RoomView, RuntimeExecutionError>::failure(
            execution_error("execution.room_view_unavailable", "Room presentation is unavailable"));
    auto view = m_room_presentation->view;
    auto inventory = inventory_view(runtime_locale);
    const auto* inventory_value = inventory.value_if();
    if (inventory_value == nullptr)
        return core::Result<core::RoomView, RuntimeExecutionError>::failure(inventory.error());
    view.controls = inventory_value->controls;
    return core::Result<core::RoomView, RuntimeExecutionError>::success(std::move(view));
}

core::Result<void, RuntimeExecutionError>
RuntimeExecutor::refresh_room_presentation(std::string_view runtime_locale)
{
    const auto* visit = m_state.room_visit() ? &*m_state.room_visit() : nullptr;
    if (visit == nullptr) {
        m_room_presentation.reset();
        m_room_presentation_diagnostics.clear();
        m_room_presentation_locale.clear();
        m_room_presentation_dirty = false;
        return core::Result<void, RuntimeExecutionError>::success();
    }
    if (!m_room_presentation_dirty && m_room_presentation &&
        m_room_presentation->presentation.visit == *visit &&
        m_room_presentation_locale == runtime_locale)
        return core::Result<void, RuntimeExecutionError>::success();

    core::RoomPresentationResolver resolver;
    RuntimeRoomComposition composition(m_project, m_scripts, m_gateway);
    auto resolution = resolver.resolve(
        m_project, m_state, *visit,
        [this](const core::Condition& condition) -> core::Result<bool, core::Diagnostics> {
            auto result = evaluate(condition);
            const auto* value = result.value_if();
            if (value != nullptr)
                return core::Result<bool, core::Diagnostics>::success(*value);
            return core::Result<bool, core::Diagnostics>::failure(
                execution_diagnostics(result.error()));
        },
        [this, runtime_locale](
            const core::TextSource& source) -> core::Result<std::string, core::Diagnostics> {
            auto result = resolve(source, runtime_locale);
            const auto* value = result.value_if();
            if (value != nullptr)
                return core::Result<std::string, core::Diagnostics>::success(*value);
            return core::Result<std::string, core::Diagnostics>::failure(
                execution_diagnostics(result.error()));
        },
        &composition);
    auto* resolved = resolution.value_if();
    if (resolved == nullptr) {
        m_room_presentation_diagnostics = resolution.error();
        if (m_room_presentation && m_room_presentation->presentation.visit == *visit &&
            m_room_presentation_locale == runtime_locale) {
            m_room_presentation_dirty = false;
            return core::Result<void, RuntimeExecutionError>::success();
        }
        return core::Result<void, RuntimeExecutionError>::failure(resolution.error());
    }
    m_room_presentation = std::move(*resolved);
    m_room_presentation_diagnostics.clear();
    m_room_presentation_locale = runtime_locale;
    m_room_presentation_dirty = false;
    return core::Result<void, RuntimeExecutionError>::success();
}

} // namespace noveltea::runtime
