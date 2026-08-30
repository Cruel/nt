#include "noveltea/runtime/runtime_executor.hpp"

#include <algorithm>
#include <limits>
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

std::size_t gameplay_program_node_count(std::span<const core::GameplayCommand> commands)
{
    std::size_t count = 0;
    for (const auto& command : commands) {
        ++count;
        if (const auto* branch = std::get_if<core::IfGameplayCommand>(&command.value)) {
            count += gameplay_program_node_count(branch->then_commands);
            count += gameplay_program_node_count(branch->else_commands);
        }
    }
    return count;
}

struct RoomProgramPlanEntry {
    const core::GameplayCommand* command = nullptr;
    std::size_t successor = 0;
    std::size_t then_first = 0;
    std::size_t else_first = 0;
};

void build_gameplay_program_plan(std::span<const core::GameplayCommand> commands,
                                 std::size_t continuation, std::vector<RoomProgramPlanEntry>& plan,
                                 std::size_t& cursor)
{
    for (std::size_t index = 0; index < commands.size(); ++index) {
        const auto& command = commands[index];
        const auto subtree_size = 1 + [&]() {
            const auto* branch = std::get_if<core::IfGameplayCommand>(&command.value);
            return branch == nullptr ? std::size_t{0}
                                     : gameplay_program_node_count(branch->then_commands) +
                                           gameplay_program_node_count(branch->else_commands);
        }();
        const auto current = cursor++;
        const auto successor = index + 1 < commands.size() ? current + subtree_size : continuation;
        plan[current].command = &command;
        plan[current].successor = successor;
        plan[current].then_first = successor;
        plan[current].else_first = successor;
        if (const auto* branch = std::get_if<core::IfGameplayCommand>(&command.value)) {
            if (!branch->then_commands.empty())
                plan[current].then_first = cursor;
            build_gameplay_program_plan(branch->then_commands, successor, plan, cursor);
            if (!branch->else_commands.empty())
                plan[current].else_first = cursor;
            build_gameplay_program_plan(branch->else_commands, successor, plan, cursor);
        }
    }
}

std::vector<RoomProgramPlanEntry>
gameplay_program_plan(std::span<const core::GameplayCommand> commands)
{
    std::vector<RoomProgramPlanEntry> plan(gameplay_program_node_count(commands));
    std::size_t cursor = 0;
    build_gameplay_program_plan(commands, plan.size(), plan, cursor);
    return plan;
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

core::RoomTransitionContext transition_context(const core::RoomTransitionFrame& transition)
{
    return core::RoomTransitionContext{transition.source_room, transition.target_room,
                                       transition.selected_exit, transition.entry_cause,
                                       transition.source_context};
}

std::optional<ProjectHookKind> lifecycle_hook(core::RoomTransitionStage stage) noexcept
{
    switch (stage) {
    case core::RoomTransitionStage::BeforeLeave:
        return ProjectHookKind::RoomBeforeLeave;
    case core::RoomTransitionStage::BeforeEnter:
        return ProjectHookKind::RoomBeforeEnter;
    case core::RoomTransitionStage::AfterLeave:
        return ProjectHookKind::RoomAfterLeave;
    case core::RoomTransitionStage::AfterEnter:
        return ProjectHookKind::RoomAfterEnter;
    default:
        return std::nullopt;
    }
}

std::optional<core::RoomId>
lifecycle_hook_target(const core::RoomTransitionFrame& transition) noexcept
{
    switch (transition.position.stage) {
    case core::RoomTransitionStage::BeforeLeave:
    case core::RoomTransitionStage::AfterLeave:
        return transition.source_room;
    case core::RoomTransitionStage::BeforeEnter:
    case core::RoomTransitionStage::AfterEnter:
        return transition.target_room;
    default:
        return std::nullopt;
    }
}

class RuntimeRoomComposition final : public core::RoomCompositionCallback {
public:
    RuntimeRoomComposition(ScriptInvocationPort& scripts, RuntimeCommandGateway& gateway) noexcept
        : m_scripts(scripts), m_gateway(gateway)
    {
    }

    core::Result<void, core::Diagnostics> compose(const core::RoomVisitContext& visit,
                                                  core::RoomPresentationDraft& draft) override
    {
        runtime::RoomCompositionDraftAccess access(draft);
        runtime::RuntimeCapabilityIssuer issuer(m_gateway, m_gateway.generation());
        const auto capabilities = issuer.issue_room_composition(access);
        struct CloseDraft final {
            runtime::RoomCompositionDraftAccess& access;
            ~CloseDraft() { access.close(); }
        } close{access};

        ProjectHookInvocationRequest request{
            .semantic_kind = ProjectHookSemanticKind::Room,
            .hook = ProjectHookKind::RoomCompose,
            .target = visit.room.text(),
            .room_transition = std::nullopt,
            .active_room_context = visit,
            .rejection_stage = std::nullopt,
            .result_kind = ScriptInvocationResultKind::None,
        };
        auto invoked = m_scripts.invoke_project_hook(request, capabilities);
        if (!invoked)
            return core::Result<void, core::Diagnostics>::failure(
                script_diagnostics(invoked.error()));
        return core::Result<void, core::Diagnostics>::success();
    }

private:
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
    const auto* target = m_world.resolved_configuration(transition.target_room);
    if (target == nullptr)
        return fault(
            execution_error("execution.invalid_room_target", "Room transition target is missing"));

    auto advance =
        [this, &transition,
         &fault](core::RoomTransitionPosition position) -> std::optional<core::FlowRunOutcome> {
        auto advanced = m_flow.advance_room_transition(transition.position, std::move(position));
        return advanced ? std::nullopt : fault(advanced.error());
    };
    const auto transition_value = transition_context(transition);
    auto invoke_hook =
        [this, &transition_value](
            ProjectHookKind hook, const core::RoomId& target_id,
            const RuntimeCapabilitySet& capabilities, ScriptInvocationResultKind result_kind,
            std::optional<core::RoomRejectionStage> rejection_stage =
                std::nullopt) -> core::Result<ProjectHookInvocationResult, core::Diagnostics> {
        ProjectHookInvocationRequest request{
            .semantic_kind = ProjectHookSemanticKind::Room,
            .hook = hook,
            .target = target_id.text(),
            .room_transition = transition_value,
            .active_room_context = m_state.room_visit(),
            .rejection_stage = rejection_stage,
            .result_kind = result_kind,
        };
        auto invoked = m_scripts.invoke_project_hook(request, capabilities);
        if (!invoked)
            return core::Result<ProjectHookInvocationResult, core::Diagnostics>::failure(
                script_diagnostics(invoked.error()));
        return core::Result<ProjectHookInvocationResult, core::Diagnostics>::success(
            std::move(*invoked.value_if()));
    };
    auto record_directed_guard = [this](std::string message) {
        m_room_lifecycle_diagnostics.push_back(core::Diagnostic{
            .code = "execution.directed_room_guard_false", .message = std::move(message)});
    };
    auto guard_result = [](const core::Result<bool, RuntimeExecutionError>& evaluated)
        -> core::Result<bool, core::Diagnostics> {
        if (!evaluated)
            return core::Result<bool, core::Diagnostics>::failure(
                execution_diagnostics(evaluated.error()));
        const auto* result = evaluated.value_if();
        if (result == nullptr)
            return core::Result<bool, core::Diagnostics>::failure(
                execution_error("execution.invalid_condition_result",
                                "Room lifecycle condition produced no value"));
        return core::Result<bool, core::Diagnostics>::success(*result);
    };
    auto hook_guard = [this, &invoke_hook](
                          ProjectHookKind hook,
                          const core::RoomId& target_id) -> core::Result<bool, core::Diagnostics> {
        auto invoked = invoke_hook(hook, target_id, m_expression_capabilities,
                                   ScriptInvocationResultKind::Boolean);
        if (!invoked)
            return core::Result<bool, core::Diagnostics>::failure(invoked.error());
        const auto* value = invoked.value_if();
        if (value == nullptr || !value->invoked)
            return core::Result<bool, core::Diagnostics>::success(true);
        const auto* allowed = std::get_if<bool>(&value->value);
        return allowed != nullptr ? core::Result<bool, core::Diagnostics>::success(*allowed)
                                  : core::Result<bool, core::Diagnostics>::failure(execution_error(
                                        "execution.invalid_room_hook_result",
                                        "Room guard hook did not return a boolean value"));
    };
    auto source_configuration = [&]() -> const core::compiled::RoomDefinition* {
        return transition.source_room ? m_world.resolved_configuration(*transition.source_room)
                                      : nullptr;
    };
    auto lifecycle_program =
        [&](core::RoomTransitionStage stage) -> std::span<const core::GameplayCommand> {
        const auto* source = source_configuration();
        switch (stage) {
        case core::RoomTransitionStage::BeforeLeave:
            return source ? std::span<const core::GameplayCommand>{source->lifecycle.before_leave}
                          : std::span<const core::GameplayCommand>{};
        case core::RoomTransitionStage::BeforeEnter:
            return target->lifecycle.before_enter;
        case core::RoomTransitionStage::AfterLeave:
            return source ? std::span<const core::GameplayCommand>{source->lifecycle.after_leave}
                          : std::span<const core::GameplayCommand>{};
        case core::RoomTransitionStage::AfterEnter:
            return target->lifecycle.after_enter;
        default:
            return {};
        }
    };
    auto rejection_program =
        [&](core::RoomRejectionStage stage) -> std::span<const core::GameplayCommand> {
        const auto* source = source_configuration();
        if (stage == core::RoomRejectionStage::TargetCanEnter)
            return target->lifecycle.on_enter_rejected;
        if (stage == core::RoomRejectionStage::ExitEligibility && source != nullptr &&
            transition.selected_exit) {
            const auto* exit = find_exit(*source, transition.selected_exit->exit_id);
            if (exit != nullptr && !exit->on_rejected.empty())
                return exit->on_rejected;
        }
        return source ? std::span<const core::GameplayCommand>{source->lifecycle.on_leave_rejected}
                      : std::span<const core::GameplayCommand>{};
    };
    auto rejection_hook = [&](core::RoomRejectionStage stage) {
        return stage == core::RoomRejectionStage::TargetCanEnter
                   ? std::pair{ProjectHookKind::RoomRejectEnter, transition.target_room}
                   : std::pair{ProjectHookKind::RoomRejectLeave,
                               transition.source_room.value_or(transition.target_room)};
    };
    auto complete_rejection =
        [&](core::RoomRejectionStage stage) -> std::optional<core::FlowRunOutcome> {
        const auto [hook, hook_room] = rejection_hook(stage);
        auto invoked = invoke_hook(hook, hook_room, m_room_lifecycle_capabilities,
                                   ScriptInvocationResultKind::None, stage);
        if (!invoked)
            return fault(invoked.error());
        auto completed = m_flow.complete_room_rejection();
        if (!completed)
            return fault(completed.error());
        if (std::holds_alternative<core::CallerDestination>(transition.destination))
            return std::nullopt;
        return core::FlowModeChangedOutcome{m_state.mode()};
    };
    auto reject_navigation =
        [&](core::RoomRejectionStage stage) -> std::optional<core::FlowRunOutcome> {
        auto finalized = m_flow.finalize_room_rejection(transition.position, stage);
        if (!finalized)
            return fault(finalized.error());
        if (rejection_program(stage).empty())
            return complete_rejection(stage);
        return std::nullopt;
    };
    auto run_program_command = [&](std::span<const core::GameplayCommand> program,
                                   bool immediate_only) -> std::optional<core::FlowRunOutcome> {
        const auto plan = gameplay_program_plan(program);
        if (transition.position.next_effect >= plan.size())
            return std::nullopt;
        const auto& entry = plan[transition.position.next_effect];
        if (entry.command == nullptr)
            return fault(execution_error("execution.invalid_room_program",
                                         "Room program cursor does not resolve to a command"));
        if (transition.position.awaiting_completion) {
            auto next = transition.position;
            next.next_effect = entry.successor;
            next.awaiting_completion = false;
            auto advanced = m_flow.advance_room_program(transition.position, next);
            return advanced ? std::nullopt : fault(advanced.error());
        }
        if (immediate_only && !gameplay_command_is_immediate(*entry.command))
            return fault(execution_error(
                "execution.yielding_room_precommit_command",
                "Before Leave and Before Enter Room programs admit only immediate commands"));
        auto* live = std::get_if<core::RoomTransitionFrame>(&m_state.m_flow_stack.back());
        if (live == nullptr)
            return fault(execution_error("execution.invalid_room_transition",
                                         "Room program lost its transition frame"));
        if (gameplay_command_is_immediate(*entry.command)) {
            auto applied = apply_immediate_gameplay_batch(
                std::span<const core::GameplayCommand>{entry.command, 1}, {},
                live->command_results);
            if (!applied)
                return fault(applied.error());
            auto next = transition.position;
            next.next_effect = entry.successor;
            auto advanced = m_flow.advance_room_program(transition.position, next);
            return advanced ? std::nullopt : fault(advanced.error());
        }
        const auto sequential = entry.successor;
        return std::visit(
            [&](const auto& value) -> std::optional<core::FlowRunOutcome> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::RunLuaCommand>) {
                    auto applied = invoke_script(value.source, "room-gameplay-command");
                    const auto* outcome = applied.value_if();
                    if (outcome == nullptr)
                        return fault(execution_error("execution.room_script_failed",
                                                     applied.error().message));
                    auto next = transition.position;
                    if (std::holds_alternative<ScriptInvocationSuspended>(*outcome)) {
                        next.awaiting_completion = true;
                        auto marked = m_flow.mark_room_transition_wait(transition.position, next);
                        return marked
                                   ? std::optional<core::FlowRunOutcome>{core::FlowBlockedOutcome{
                                         *m_state.blocker()}}
                                   : fault(marked.error());
                    }
                    next.next_effect = sequential;
                    auto advanced = m_flow.advance_room_program(transition.position, next);
                    return advanced ? std::nullopt : fault(advanced.error());
                } else if constexpr (std::is_same_v<T, core::NotifyCommand>) {
                    auto message = resolve(value.message.source, runtime_locale);
                    const auto* text = message.value_if();
                    if (text == nullptr)
                        return fault(execution_diagnostics(message.error()));
                    auto requested = m_gateway.request_notification(*text);
                    if (!requested)
                        return fault(requested.error());
                } else if constexpr (std::is_same_v<T, core::PresentInventoryCommand>) {
                    const core::ConditionEvaluationContext context{
                        .interaction_bindings = {}, .command_results = live->command_results};
                    auto inventory = m_primitives.resolve_inventory(value.inventory, context);
                    if (!inventory)
                        return fault(inventory.error());
                    auto presented = present_inventory(*inventory.value_if(), value.layout);
                    if (!presented)
                        return fault(presented.error());
                } else if constexpr (std::is_same_v<T, core::CallSceneCommand>) {
                    auto next = transition.position;
                    next.next_effect = sequential;
                    auto called = m_flow.call_child(value.scene, core::FlowFramePosition{next});
                    return called ? std::nullopt : fault(called.error());
                } else if constexpr (std::is_same_v<T, core::CallDialogueCommand>) {
                    auto next = transition.position;
                    next.next_effect = sequential;
                    auto called = m_flow.call_child(value.dialogue, std::nullopt,
                                                    core::FlowFramePosition{next});
                    return called ? std::nullopt : fault(called.error());
                } else if constexpr (std::is_same_v<T, core::IfGameplayCommand>) {
                    const core::ConditionEvaluationContext context{
                        .interaction_bindings = {}, .command_results = live->command_results};
                    auto evaluated = m_primitives.evaluate(value.condition, context);
                    if (!evaluated)
                        return fault(evaluated.error());
                    auto next = transition.position;
                    next.next_effect = *evaluated.value_if() ? entry.then_first : entry.else_first;
                    auto advanced = m_flow.advance_room_program(transition.position, next);
                    return advanced ? std::nullopt : fault(advanced.error());
                } else {
                    return fault(execution_error(
                        "execution.invalid_room_program",
                        "Immediate Gameplay Command reached an observable Room program boundary"));
                }
                auto next = transition.position;
                next.next_effect = sequential;
                auto advanced = m_flow.advance_room_program(transition.position, next);
                return advanced ? std::nullopt : fault(advanced.error());
            },
            entry.command->value);
    };

    switch (transition.position.stage) {
    case core::RoomTransitionStage::SourceCanLeave: {
        const auto* source = transition.source_room
                                 ? m_world.resolved_configuration(*transition.source_room)
                                 : nullptr;
        if (source == nullptr || !transition.source_room)
            return fault(execution_error("execution.invalid_room_source",
                                         "Room transition source is missing"));
        auto declarative = guard_result(evaluate(source->lifecycle.can_leave));
        if (!declarative)
            return fault(declarative.error());
        bool allowed = *declarative.value_if();
        if (allowed) {
            auto scripted = hook_guard(ProjectHookKind::RoomCanLeave, *transition.source_room);
            if (!scripted)
                return fault(scripted.error());
            allowed = *scripted.value_if();
        }
        if (!allowed) {
            if (transition.kind == core::RoomTransitionKind::NavigationAttempt)
                return reject_navigation(core::RoomRejectionStage::SourceCanLeave);
            record_directed_guard(
                "Directed Room Change ignored a false source can-leave guard for '" +
                transition.source_room->text() + "'.");
        }
        return advance({transition.selected_exit ? core::RoomTransitionStage::ExitCondition
                                                 : core::RoomTransitionStage::TargetCanEnter,
                        0, false});
    }
    case core::RoomTransitionStage::ExitCondition: {
        const auto* source = transition.source_room
                                 ? m_world.resolved_configuration(*transition.source_room)
                                 : nullptr;
        const auto* exit = source != nullptr && transition.selected_exit
                               ? find_exit(*source, transition.selected_exit->exit_id)
                               : nullptr;
        if (exit == nullptr || exit->target != transition.target_room || !transition.source_room)
            return fault(execution_error("execution.invalid_room_exit",
                                         "Selected Room exit is missing or mismatched"));
        auto eligible = guard_result(evaluate(exit->condition));
        if (!eligible)
            return fault(eligible.error());
        if (!*eligible.value_if()) {
            if (transition.kind == core::RoomTransitionKind::NavigationAttempt)
                return reject_navigation(core::RoomRejectionStage::ExitEligibility);
            record_directed_guard("Directed Room Change ignored a false selected-exit guard for '" +
                                  transition.source_room->text() + "." + exit->id.text() + "'.");
        }
        return advance({core::RoomTransitionStage::TargetCanEnter, 0, false});
    }
    case core::RoomTransitionStage::TargetCanEnter: {
        auto declarative = guard_result(evaluate(target->lifecycle.can_enter));
        if (!declarative)
            return fault(declarative.error());
        bool allowed = *declarative.value_if();
        if (allowed) {
            auto scripted = hook_guard(ProjectHookKind::RoomCanEnter, transition.target_room);
            if (!scripted)
                return fault(scripted.error());
            allowed = *scripted.value_if();
        }
        if (!allowed) {
            if (transition.kind == core::RoomTransitionKind::NavigationAttempt)
                return reject_navigation(core::RoomRejectionStage::TargetCanEnter);
            if (transition.entry_cause == core::RoomEntryCause::Entrypoint)
                return fault(execution_error(
                    "execution.room_entry_rejected",
                    "Entrypoint Room rejected entry and no source Room exists to resume"));
            record_directed_guard(
                "Directed Room Change ignored a false target can-enter guard for '" +
                transition.target_room.text() + "'.");
        }
        return advance({transition.source_room ? core::RoomTransitionStage::BeforeLeave
                                               : core::RoomTransitionStage::BeforeEnter,
                        0, false});
    }
    case core::RoomTransitionStage::BeforeLeave:
    case core::RoomTransitionStage::BeforeEnter:
    case core::RoomTransitionStage::AfterLeave:
    case core::RoomTransitionStage::AfterEnter: {
        const auto program = lifecycle_program(transition.position.stage);
        const auto plan_size = gameplay_program_node_count(program);
        if (transition.position.next_effect < plan_size)
            return run_program_command(
                program, transition.position.stage == core::RoomTransitionStage::BeforeLeave ||
                             transition.position.stage == core::RoomTransitionStage::BeforeEnter);
        const auto hook = lifecycle_hook(transition.position.stage);
        const auto target_id = lifecycle_hook_target(transition);
        if (!hook || !target_id)
            return fault(execution_error("execution.invalid_room_hook_owner",
                                         "Room lifecycle hook owner is missing"));
        auto invoked = invoke_hook(*hook, *target_id, m_room_lifecycle_capabilities,
                                   ScriptInvocationResultKind::None);
        if (!invoked)
            return fault(invoked.error());
        return advance({next_hook_stage(transition), 0, false});
    }
    case core::RoomTransitionStage::RejectionProgram: {
        if (!transition.rejection_stage)
            return fault(execution_error("execution.invalid_room_rejection",
                                         "Finalized Room rejection is missing its failed stage"));
        const auto program = rejection_program(*transition.rejection_stage);
        if (transition.position.next_effect < gameplay_program_node_count(program))
            return run_program_command(program, false);
        return complete_rejection(*transition.rejection_stage);
    }
    case core::RoomTransitionStage::CommitRoomSwitch: {
        if (transition.position.awaiting_completion)
            return advance({transition.source_room ? core::RoomTransitionStage::AfterLeave
                                                   : core::RoomTransitionStage::AfterEnter,
                            0, false});

        if (m_state.room_visits(transition.target_room) ==
                std::numeric_limits<std::uint64_t>::max() ||
            m_state.room_entry_sequence() == std::numeric_limits<std::uint64_t>::max())
            return fault(execution_error("runtime.history_overflow",
                                         "Room entry history cannot be incremented"));

        RuntimeRoomComposition composition(m_scripts, m_gateway);
        auto prepared = m_presentation_model.prepare_room_navigation(
            m_project, m_world, m_state,
            core::RoomNavigationPreparationInput{transition.frame_id, transition.source_room,
                                                 transition.target_room, transition.selected_exit,
                                                 transition.entry_cause, transition.source_context,
                                                 std::nullopt, m_state.room_entry_sequence() + 1,
                                                 m_state.room_visits(transition.target_room) + 1},
            [this](const core::Condition& value) -> core::Result<bool, core::Diagnostics> {
                auto evaluated = evaluate(value);
                const auto* result = evaluated.value_if();
                if (result != nullptr)
                    return core::Result<bool, core::Diagnostics>::success(*result);
                return core::Result<bool, core::Diagnostics>::failure(
                    execution_diagnostics(evaluated.error()));
            },
            [this, runtime_locale](
                const core::TextSource& value) -> core::Result<std::string, core::Diagnostics> {
                auto resolved = resolve(value, runtime_locale);
                const auto* result = resolved.value_if();
                if (result != nullptr)
                    return core::Result<std::string, core::Diagnostics>::success(*result);
                return core::Result<std::string, core::Diagnostics>::failure(
                    execution_diagnostics(resolved.error()));
            },
            &composition);
        if (!prepared)
            return fault(prepared.error());

        const core::SessionState source_state = m_state;
        const auto source_room = m_room_presentation;
        auto committed = m_world.commit_room_navigation(prepared.value_if()->resolution);
        if (!committed)
            return fault(committed.error());
        m_room_presentation = std::move(prepared.value_if()->resolution);
        m_room_presentation_diagnostics.clear();
        m_room_presentation_locale = std::string(runtime_locale);
        m_room_presentation_dirty = false;

        const auto policy = prepared.value_if()->transition.policy;
        if (policy.kind == core::compiled::TransitionKind::Cut) {
            return advance({transition.source_room ? core::RoomTransitionStage::AfterLeave
                                                   : core::RoomTransitionStage::AfterEnter,
                            0, false});
        }

        auto waiting = begin(core::WaitSpec{core::PresentationCompletionWait{}});
        const auto* wait_outcome = waiting.value_if();
        const auto* blocked =
            wait_outcome == nullptr ? nullptr : std::get_if<core::WaitBlocked>(wait_outcome);
        const auto* presentation =
            blocked == nullptr ? nullptr
                               : std::get_if<core::PresentationFlowBlocker>(&blocked->blocker);
        if (presentation == nullptr) {
            m_state = source_state;
            m_room_presentation = source_room;
            return fault(
                waiting ? execution_error("execution.invalid_presentation_wait",
                                          "Room navigation did not allocate a presentation blocker")
                        : waiting.error());
        }
        auto marked = m_flow.mark_room_transition_wait(
            transition.position, {core::RoomTransitionStage::CommitRoomSwitch, 0, true});
        if (!marked) {
            m_state = source_state;
            m_room_presentation = source_room;
            return fault(marked.error());
        }

        stage_pending_presentation(
            PendingRoomNavigationOperation{
                transition.source_room, transition.target_room, policy.kind,
                std::chrono::milliseconds{policy.duration_ms}, policy.color, policy.skippable,
                core::PresentationFlowCompletion{presentation->owner, presentation->handle}},
            source_state, source_room);
        return core::FlowBlockedOutcome{*m_state.blocker()};
    }
    case core::RoomTransitionStage::Complete: {
        auto completed = m_flow.complete_room_transition();
        if (!completed)
            return fault(completed.error());
        if (std::holds_alternative<core::CallerDestination>(transition.destination))
            return std::nullopt;
        return core::FlowModeChangedOutcome{m_state.mode()};
    }
    }
    return fault(execution_error("execution.invalid_room_transition_position",
                                 "Room transition stage is invalid"));
}

core::Result<void, core::Diagnostics> RuntimeExecutor::navigate(const core::RoomExitId& exit)
{
    const auto* mode = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* room = mode == nullptr ? nullptr : m_world.resolved_configuration(mode->room);
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
    const auto* visit = m_state.room_visit() ? &*m_state.room_visit() : nullptr;
    if (visit == nullptr || !has_current_room_context())
        return core::Result<core::RoomView, RuntimeExecutionError>::failure(
            execution_error("execution.room_view_unavailable",
                            "Room view requires an active committed Room visit"));
    auto refreshed = refresh_room_presentation(runtime_locale);
    if (!refreshed)
        return core::Result<core::RoomView, RuntimeExecutionError>::failure(refreshed.error());
    if (!m_room_presentation)
        return core::Result<core::RoomView, RuntimeExecutionError>::failure(
            execution_error("execution.room_view_unavailable", "Room presentation is unavailable"));
    auto view = m_room_presentation->view;
    for (const auto& stack : m_state.item_stacks()) {
        const auto* location = std::get_if<core::compiled::RoomLocation>(&stack.location);
        const auto* definition = m_project.find_item_definition(stack.definition);
        if (location == nullptr || location->room != visit->room || definition == nullptr)
            continue;
        view.item_stacks.push_back({stack.id, stack.definition, stack.quantity, stack.location,
                                    m_world.effective_room(stack.id), definition->display_name,
                                    definition->description, definition->presentation,
                                    stack.traits});
    }
    std::ranges::sort(view.item_stacks, {}, [](const auto& stack) { return stack.stack.text(); });
    auto inventory = inventory_view(runtime_locale);
    const auto* inventory_value = inventory.value_if();
    if (inventory_value == nullptr)
        return core::Result<core::RoomView, RuntimeExecutionError>::failure(inventory.error());
    view.controls = inventory_value->controls;
    return core::Result<core::RoomView, RuntimeExecutionError>::success(std::move(view));
}

bool RuntimeExecutor::has_current_room_context() const noexcept
{
    return m_state.room_visit().has_value();
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

    RuntimeRoomComposition composition(m_scripts, m_gateway);
    auto resolution = m_presentation_model.resolve_room(
        m_project, m_world, m_state, *visit,
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

core::Result<void, RuntimeExecutionError>
RuntimeExecutor::refresh_scene_stage_presentations(std::string_view runtime_locale)
{
    std::vector<core::SceneStageRoomPresentation> resolved_stages;
    for (const auto& value : m_state.flow_stack()) {
        const auto* frame = std::get_if<core::SceneFrame>(&value);
        if (frame == nullptr || !frame->position.stage_initialized)
            continue;
        const auto* scene = m_project.find_scene(frame->scene);
        if (scene == nullptr)
            return core::Result<void, RuntimeExecutionError>::failure(
                execution_error("execution.invalid_scene", "Active Scene definition is missing"));
        const auto* staged = std::get_if<core::compiled::StagedRoomSceneStage>(&scene->stage);
        if (staged == nullptr)
            continue;
        auto resolution = m_presentation_model.resolve_staged_room(
            m_project, m_world, m_state, staged->room,
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
            });
        if (!resolution)
            return core::Result<void, RuntimeExecutionError>::failure(resolution.error());
        resolved_stages.push_back(core::SceneStageRoomPresentation{
            core::ScenePresentationOwner{frame->frame_id, frame->scene},
            std::move(*resolution.value_if())});
    }
    m_scene_stage_presentations = std::move(resolved_stages);
    return core::Result<void, RuntimeExecutionError>::success();
}

} // namespace noveltea::runtime
