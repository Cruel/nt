#include "noveltea/runtime/runtime_executor.hpp"

#include "noveltea/core/save_state_codec.hpp"

#include <algorithm>
#include <chrono>
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
    return execution_error("execution.scene_script_failed", error.message);
}

runtime::RuntimeCapabilitySet issue_capabilities(runtime::RuntimeCommandGateway& gateway,
                                                 runtime::RuntimeCapabilityProfile profile)
{
    runtime::RuntimeCapabilityIssuer issuer(gateway, gateway.generation());
    return *issuer.issue(profile);
}

const core::compiled::SceneInstruction*
find_instruction(const core::compiled::SceneDefinition& scene, const core::SceneStepId& step)
{
    const auto found = std::find_if(
        scene.program.instructions.begin(), scene.program.instructions.end(),
        [&step](const core::compiled::SceneInstruction& instruction) {
            return std::visit([&step](const auto& value) { return value.id == step; }, instruction);
        });
    return found == scene.program.instructions.end() ? nullptr : &*found;
}

std::optional<core::SceneStepId> next_instruction(const core::compiled::SceneDefinition& scene,
                                                  const core::SceneStepId& step)
{
    for (std::size_t index = 0; index < scene.program.instructions.size(); ++index) {
        const bool matches = std::visit([&step](const auto& value) { return value.id == step; },
                                        scene.program.instructions[index]);
        if (!matches)
            continue;
        if (index + 1 == scene.program.instructions.size())
            return std::nullopt;
        return std::visit([](const auto& value) { return value.id; },
                          scene.program.instructions[index + 1]);
    }
    return std::nullopt;
}

const core::compiled::SceneChoiceOption*
find_choice_option(const core::compiled::ChoiceSceneInstruction& choice,
                   const core::SceneChoiceOptionId& option)
{
    const auto found = std::find_if(choice.options.begin(), choice.options.end(),
                                    [&option](const auto& value) { return value.id == option; });
    return found == choice.options.end() ? nullptr : &*found;
}

} // namespace

RuntimeExecutor::RuntimeExecutor(const core::CompiledProject& project,
                                 ScriptInvocationPort& scripts, core::SessionState state,
                                 CapabilityGeneration generation) noexcept
    : m_project(project), m_state(std::move(state)), m_flow(m_project, m_state),
      m_primitives(m_project, m_state, m_flow), m_gateway(m_project, m_state, generation),
      m_scripts(scripts), m_gameplay_capabilities(issue_capabilities(
                              m_gateway, runtime::RuntimeCapabilityProfile::GameplayScript)),
      m_expression_capabilities(
          issue_capabilities(m_gateway, runtime::RuntimeCapabilityProfile::SynchronousExpression))
{
}

core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>
RuntimeExecutor::create(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                        CapabilityGeneration generation)
{
    auto state = core::SessionState::create(project);
    auto* value = state.value_if();
    if (value == nullptr)
        return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::failure(
            state.error());
    return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::success(
        std::unique_ptr<RuntimeExecutor>(
            new RuntimeExecutor(project, scripts, std::move(*value), generation)));
}

core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>
RuntimeExecutor::restore(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                         const core::SaveState& save, CapabilityGeneration generation)
{
    auto state = core::FlowExecutor::restore_session(project, save);
    auto* value = state.value_if();
    if (value == nullptr)
        return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::failure(
            state.error());
    return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::success(
        std::unique_ptr<RuntimeExecutor>(
            new RuntimeExecutor(project, scripts, std::move(*value), generation)));
}

core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>
RuntimeExecutor::load_slot(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                           core::TypedSaveSlotStore& store, core::TypedSaveSlotId slot,
                           CapabilityGeneration generation)
{
    auto bytes = store.read_slot(slot);
    const auto* text = bytes.value_if();
    if (text == nullptr)
        return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::failure(
            bytes.error());
    auto save = core::decode_save_state_text(project, *text, "save-slot");
    const auto* value = save.value_if();
    if (value == nullptr)
        return core::Result<std::unique_ptr<RuntimeExecutor>, core::Diagnostics>::failure(
            save.error());
    return restore(project, scripts, *value, generation);
}

core::Result<bool, ScriptInvocationError>
RuntimeExecutor::evaluate_script(const core::LuaPredicate& predicate)
{
    runtime::ScriptInvocationRequest request{.source = predicate.source,
                                             .chunk_name = "lua-condition",
                                             .owner = std::nullopt,
                                             .invocation = std::nullopt,
                                             .source_context = m_gateway.current_source_context(),
                                             .result_kind =
                                                 runtime::ScriptInvocationResultKind::Boolean,
                                             .asset_path = std::nullopt};
    auto result = m_scripts.invoke(request, m_expression_capabilities);
    const auto* outcome = result.value_if();
    if (outcome == nullptr)
        return core::Result<bool, ScriptInvocationError>::failure(result.error());
    const auto* completed = std::get_if<runtime::ScriptInvocationCompleted>(outcome);
    const auto* value = completed == nullptr ? nullptr : std::get_if<bool>(&completed->value);
    return value ? core::Result<bool, ScriptInvocationError>::success(*value)
                 : core::Result<bool, ScriptInvocationError>::failure(
                       ScriptInvocationError{.code = ScriptInvocationErrorCode::InvalidResult,
                                             .message = "Lua condition did not return a boolean",
                                             .chunk = request.chunk_name,
                                             .traceback = {}});
}

core::Result<std::string, ScriptInvocationError>
RuntimeExecutor::resolve_script(const core::LuaTextExpression& expression)
{
    runtime::ScriptInvocationRequest request{.source = expression.source,
                                             .chunk_name = "lua-text-expression",
                                             .owner = std::nullopt,
                                             .invocation = std::nullopt,
                                             .source_context = m_gateway.current_source_context(),
                                             .result_kind =
                                                 runtime::ScriptInvocationResultKind::String,
                                             .asset_path = std::nullopt};
    auto result = m_scripts.invoke(request, m_expression_capabilities);
    const auto* outcome = result.value_if();
    if (outcome == nullptr)
        return core::Result<std::string, ScriptInvocationError>::failure(result.error());
    const auto* completed = std::get_if<runtime::ScriptInvocationCompleted>(outcome);
    const auto* value =
        completed == nullptr ? nullptr : std::get_if<std::string>(&completed->value);
    return value ? core::Result<std::string, ScriptInvocationError>::success(*value)
                 : core::Result<std::string, ScriptInvocationError>::failure(ScriptInvocationError{
                       .code = ScriptInvocationErrorCode::InvalidResult,
                       .message = "Lua text expression did not return a string",
                       .chunk = request.chunk_name,
                       .traceback = {}});
}

core::Result<ScriptInvocationOutcome, ScriptInvocationError>
RuntimeExecutor::invoke_script(std::string_view source, std::string_view chunk_name)
{
    using Result = core::Result<ScriptInvocationOutcome, ScriptInvocationError>;
    auto allocated = m_flow.block_top(core::FlowBlockerKind::Script);
    const auto* blocker = allocated.value_if();
    if (blocker == nullptr) {
        const std::string message = allocated.error().empty()
                                        ? "Script invocation blocker is invalid"
                                        : allocated.error().front().message;
        return Result::failure(
            ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                  .message = message,
                                  .chunk = std::string(chunk_name),
                                  .traceback = message});
    }
    const auto* script_blocker = std::get_if<core::ScriptFlowBlocker>(blocker);
    if (script_blocker == nullptr) {
        return Result::failure(
            ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                  .message = "FlowExecutor allocated a non-script blocker",
                                  .chunk = std::string(chunk_name),
                                  .traceback = {}});
    }

    runtime::ScriptInvocationRequest request{.source = std::string(source),
                                             .chunk_name = std::string(chunk_name),
                                             .owner = script_blocker->owner,
                                             .invocation = script_blocker->handle,
                                             .source_context = m_gateway.current_source_context(),
                                             .result_kind =
                                                 runtime::ScriptInvocationResultKind::None,
                                             .asset_path = std::nullopt};
    auto invoked = m_scripts.invoke(request, m_gameplay_capabilities);
    if (!invoked) {
        (void)m_flow.cancel_blocker(script_blocker->owner, script_blocker->handle);
        return Result::failure(invoked.error());
    }
    const auto* outcome = invoked.value_if();
    if (outcome != nullptr && std::holds_alternative<ScriptInvocationCompleted>(*outcome)) {
        auto completed = m_flow.resume_blocker(script_blocker->owner, script_blocker->handle);
        if (!completed) {
            const std::string message = completed.error().empty()
                                            ? "Script invocation blocker is invalid"
                                            : completed.error().front().message;
            return Result::failure(
                ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                      .message = message,
                                      .chunk = std::string(chunk_name),
                                      .traceback = message});
        }
    }
    return invoked;
}

core::Result<bool, RuntimeExecutionError>
RuntimeExecutor::evaluate(const core::Condition& condition)
{
    if (const auto* lua = std::get_if<core::LuaPredicate>(&condition)) {
        auto result = evaluate_script(*lua);
        const auto* value = result.value_if();
        return value ? core::Result<bool, RuntimeExecutionError>::success(*value)
                     : core::Result<bool, RuntimeExecutionError>::failure(result.error());
    }
    auto result = m_primitives.evaluate(condition);
    const auto* value = result.value_if();
    return value ? core::Result<bool, RuntimeExecutionError>::success(*value)
                 : core::Result<bool, RuntimeExecutionError>::failure(result.error());
}

core::Result<RuntimeEffectOutcome, RuntimeExecutionError>
RuntimeExecutor::apply(const core::Effect& effect, std::string_view chunk_name)
{
    if (const auto* lua = std::get_if<core::RunLuaEffect>(&effect)) {
        auto result = invoke_script(lua->source, chunk_name);
        const auto* outcome = result.value_if();
        if (outcome == nullptr)
            return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::failure(
                result.error());
        return std::visit(
            [](const auto& value) -> core::Result<RuntimeEffectOutcome, RuntimeExecutionError> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, ScriptInvocationCompleted>)
                    return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::success(
                        core::WaitCompleted{});
                else
                    return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::success(
                        value);
            },
            *outcome);
    }
    auto result = m_primitives.apply(effect);
    if (!result)
        return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::failure(result.error());
    return core::Result<RuntimeEffectOutcome, RuntimeExecutionError>::success(
        core::WaitCompleted{});
}

core::Result<std::string, RuntimeExecutionError>
RuntimeExecutor::resolve(const core::TextSource& source, std::string_view runtime_locale)
{
    if (const auto* lua = std::get_if<core::LuaTextExpression>(&source)) {
        auto result = resolve_script(*lua);
        const auto* value = result.value_if();
        return value ? core::Result<std::string, RuntimeExecutionError>::success(*value)
                     : core::Result<std::string, RuntimeExecutionError>::failure(result.error());
    }
    auto result = m_primitives.resolve(source, runtime_locale);
    const auto* value = result.value_if();
    return value ? core::Result<std::string, RuntimeExecutionError>::success(*value)
                 : core::Result<std::string, RuntimeExecutionError>::failure(result.error());
}

core::Result<core::WaitEvaluation, core::Diagnostics>
RuntimeExecutor::begin(const core::WaitSpec& wait)
{
    return m_primitives.begin(wait);
}

core::Result<void, core::Diagnostics>
RuntimeExecutor::complete(const core::FlowFrameId& owner, const core::AnyFlowBlockerHandle& handle)
{
    return m_primitives.complete(owner, handle);
}

core::Result<void, core::Diagnostics>
RuntimeExecutor::cancel(const core::FlowFrameId& owner, const core::AnyFlowBlockerHandle& handle)
{
    return m_primitives.cancel(owner, handle);
}

core::Result<bool, core::Diagnostics>
RuntimeExecutor::advance(const core::FlowFrameId& owner,
                         const core::DurationFlowBlockerHandle& handle,
                         std::chrono::milliseconds elapsed)
{
    return m_primitives.advance(owner, handle, elapsed);
}

core::Result<ScriptInvocationOutcome, ScriptInvocationError>
RuntimeExecutor::resume_script(const core::FlowFrameId& owner,
                               const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<ScriptInvocationOutcome, ScriptInvocationError>;
    auto valid = m_flow.validate_blocker(owner, invocation);
    if (!valid) {
        const std::string message = valid.error().empty() ? "Script invocation blocker is invalid"
                                                          : valid.error().front().message;
        return Result::failure(
            ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                  .message = message,
                                  .chunk = "resume",
                                  .traceback = message});
    }
    auto resumed = m_scripts.resume(invocation, m_gameplay_capabilities);
    if (!resumed) {
        (void)m_flow.cancel_blocker(owner, invocation);
        return Result::failure(resumed.error());
    }
    const auto* outcome = resumed.value_if();
    if (outcome != nullptr && std::holds_alternative<ScriptInvocationCompleted>(*outcome)) {
        auto completed = m_flow.resume_blocker(owner, invocation);
        if (!completed) {
            const std::string message = completed.error().empty()
                                            ? "Script invocation blocker is invalid"
                                            : completed.error().front().message;
            return Result::failure(
                ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                      .message = message,
                                      .chunk = "resume",
                                      .traceback = message});
        }
    }
    return resumed;
}

core::Result<void, ScriptInvocationError>
RuntimeExecutor::cancel_script(const core::FlowFrameId& owner,
                               const core::ScriptInvocationHandle& invocation)
{
    using Result = core::Result<void, ScriptInvocationError>;
    auto valid = m_flow.validate_blocker(owner, invocation);
    if (!valid) {
        const std::string message = valid.error().empty() ? "Script invocation blocker is invalid"
                                                          : valid.error().front().message;
        return Result::failure(
            ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                  .message = message,
                                  .chunk = "cancel",
                                  .traceback = message});
    }
    m_scripts.cancel(invocation, runtime::ScriptCancellationReason::OwnerEnded);
    auto released = m_flow.cancel_blocker(owner, invocation);
    if (released)
        return Result::success();
    const std::string message = released.error().empty() ? "Script invocation blocker is invalid"
                                                         : released.error().front().message;
    return Result::failure(ScriptInvocationError{.code = ScriptInvocationErrorCode::StaleInvocation,
                                                 .message = message,
                                                 .chunk = "cancel",
                                                 .traceback = message});
}

core::FlowRunOutcome RuntimeExecutor::run_until_blocked(std::size_t instruction_budget,
                                                        std::string_view runtime_locale)
{
    if (m_state.gameplay_paused())
        return core::FlowBudgetYieldOutcome{0};

    auto fault = [this](core::Diagnostics diagnostics) -> core::FlowRunOutcome {
        const auto copy = diagnostics;
        (void)m_flow.fault(std::move(diagnostics));
        return core::FlowFaultOutcome{copy};
    };
    auto commit =
        [this, &fault](const core::SceneId& scene, const core::SceneStepId& step,
                       core::SceneFramePosition position) -> std::optional<core::FlowRunOutcome> {
        auto result = m_flow.advance_scene(scene, step, std::move(position));
        if (!result)
            return fault(result.error());
        return std::nullopt;
    };
    auto queue_autosave = [this](const core::SceneId& scene, const core::SceneStepId& step) {
        (void)scene;
        (void)step;
        m_gateway.request_autosave_safe_point();
    };

    auto started = m_flow.begin_run();
    if (!started)
        return core::FlowFaultOutcome{started.error()};
    struct RunGuard {
        core::FlowExecutor& flow;
        ~RunGuard() { flow.end_run(); }
    } run_guard{m_flow};

    if (m_state.execution_fault())
        return core::FlowFaultOutcome{*m_state.execution_fault()};
    if (m_state.blocker())
        return core::FlowBlockedOutcome{*m_state.blocker()};
    if (!std::holds_alternative<core::FlowMode>(m_state.mode()))
        return core::FlowModeChangedOutcome{m_state.mode()};
    if (instruction_budget == 0)
        return core::FlowBudgetYieldOutcome{0};

    std::size_t executed = 0;
    while (executed < instruction_budget) {
        if (m_gateway.has_frame_sensitive_command())
            return core::FlowBudgetYieldOutcome{executed};
        if (m_state.gameplay_paused())
            return core::FlowBudgetYieldOutcome{executed};
        if (m_state.blocker())
            return core::FlowBlockedOutcome{*m_state.blocker()};
        if (!std::holds_alternative<core::FlowMode>(m_state.mode()))
            return core::FlowModeChangedOutcome{m_state.mode()};
        if (m_state.flow_stack().empty())
            return fault(execution_error("execution.invalid_stack",
                                         "Flow mode requires an active typed frame"));
        if (std::holds_alternative<core::RoomTransitionFrame>(m_state.flow_stack().back())) {
            auto outcome = run_room_unit(runtime_locale);
            if (outcome)
                return *outcome;
            ++executed;
            continue;
        }
        if (std::holds_alternative<core::DialogueFrame>(m_state.flow_stack().back())) {
            auto outcome = run_dialogue_unit(runtime_locale);
            if (outcome)
                return *outcome;
            ++executed;
            continue;
        }
        if (std::holds_alternative<core::InteractionFrame>(m_state.flow_stack().back())) {
            auto outcome = run_interaction_unit(runtime_locale);
            if (outcome)
                return *outcome;
            ++executed;
            continue;
        }
        const auto* frame = std::get_if<core::SceneFrame>(&m_state.flow_stack().back());
        if (frame == nullptr)
            return fault(execution_error("execution.invalid_frame_variant",
                                         "The active Flow frame variant is not executable"));
        const auto* scene = m_project.find_scene(frame->scene);
        if (scene == nullptr)
            return fault(execution_error("execution.invalid_scene",
                                         "The active Scene definition is missing"));

        if (!frame->position.next_step) {
            auto applied = m_flow.apply_target(scene->continuation);
            if (!applied)
                return fault(applied.error());
            ++executed;
            continue;
        }
        const auto step = *frame->position.next_step;
        const auto sequential = next_instruction(*scene, step);

        if (const auto* completion =
                std::get_if<core::SceneInstructionCompletionPosition>(&frame->position.substate)) {
            const auto* completed_instruction = find_instruction(*scene, step);
            const auto* transition =
                completed_instruction == nullptr
                    ? nullptr
                    : std::get_if<core::compiled::TransitionInstruction>(completed_instruction);
            if (transition != nullptr) {
                auto changed =
                    m_state.set_transition({transition->transition_kind, transition->color, true});
                if (!changed)
                    return fault(changed.error());
            }
            if (completion->autosave_safe_point)
                queue_autosave(frame->scene, step);
            if (auto failed =
                    commit(frame->scene, step, {completion->next_step, core::SceneStepReady{}}))
                return *failed;
            ++executed;
            continue;
        }
        if (const auto* pending =
                std::get_if<core::SceneAutosavePendingPosition>(&frame->position.substate)) {
            queue_autosave(frame->scene, pending->completed_step);
            if (auto failed =
                    commit(frame->scene, step, {pending->next_step, core::SceneStepReady{}}))
                return *failed;
            ++executed;
            continue;
        }
        if (const auto* effects =
                std::get_if<core::SceneChoiceEffectPosition>(&frame->position.substate)) {
            const auto* instruction = find_instruction(*scene, step);
            const auto* choice =
                instruction == nullptr
                    ? nullptr
                    : std::get_if<core::compiled::ChoiceSceneInstruction>(instruction);
            const auto* option =
                choice == nullptr ? nullptr : find_choice_option(*choice, effects->option);
            if (choice == nullptr || option == nullptr)
                return fault(execution_error("execution.invalid_scene_choice",
                                             "Active Scene choice position is invalid"));
            if (effects->next_effect >= option->effects.size()) {
                if (choice->autosave_safe_point)
                    queue_autosave(frame->scene, step);
                if (auto failed = commit(frame->scene, step,
                                         {option->target_instruction_id, core::SceneStepReady{}}))
                    return *failed;
                ++executed;
                continue;
            }
            if (effects->awaiting_completion) {
                if (auto failed =
                        commit(frame->scene, step,
                               {step, core::SceneChoiceEffectPosition{
                                          effects->option, effects->next_effect + 1, false}}))
                    return *failed;
                ++executed;
                continue;
            }
            auto applied = apply(option->effects[effects->next_effect], "scene-choice-effect");
            if (!applied) {
                if (const auto* diagnostics = std::get_if<core::Diagnostics>(&applied.error()))
                    return fault(*diagnostics);
                return fault(script_diagnostics(std::get<ScriptInvocationError>(applied.error())));
            }
            const auto* applied_outcome = applied.value_if();
            const bool suspended =
                applied_outcome != nullptr &&
                std::holds_alternative<ScriptInvocationSuspended>(*applied_outcome);
            core::SceneChoiceEffectPosition next{
                effects->option, effects->next_effect + (suspended ? 0 : 1), suspended};
            if (suspended) {
                auto marked = m_flow.mark_scene_wait(frame->scene, step, next);
                if (!marked)
                    return fault(marked.error());
                return core::FlowBlockedOutcome{*m_state.blocker()};
            }
            if (auto failed = commit(frame->scene, step, {step, next}))
                return *failed;
            ++executed;
            continue;
        }
        if (std::holds_alternative<core::SceneChoiceSelectionPosition>(frame->position.substate))
            return fault(execution_error("execution.scene_choice_without_blocker",
                                         "Scene choice selection lost its input blocker"));

        const auto* instruction = find_instruction(*scene, step);
        if (instruction == nullptr)
            return fault(execution_error("execution.invalid_scene_position",
                                         "Active Scene instruction is missing"));

        auto outcome = std::visit(
            [&, this](const auto& value) -> std::optional<core::FlowRunOutcome> {
                using T = std::decay_t<decltype(value)>;
                if (value.condition) {
                    auto condition = evaluate(*value.condition);
                    if (!condition) {
                        if (const auto* diagnostics =
                                std::get_if<core::Diagnostics>(&condition.error()))
                            return fault(*diagnostics);
                        return fault(
                            script_diagnostics(std::get<ScriptInvocationError>(condition.error())));
                    }
                    const auto* condition_value = condition.value_if();
                    if (condition_value == nullptr)
                        return fault(execution_error("execution.invalid_condition_result",
                                                     "Scene condition produced no value"));
                    if (!*condition_value)
                        return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                }

                if constexpr (std::is_same_v<T, core::compiled::SetBackgroundInstruction>) {
                    auto changed = m_state.set_background(m_project, value.background);
                    if (!changed)
                        return fault(changed.error());
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::ActorCueInstruction>) {
                    const auto* character = m_project.find_character(value.character);
                    if (character == nullptr)
                        return fault(execution_error("execution.invalid_actor_character",
                                                     "Actor cue Character is missing"));
                    const auto* current = m_state.actor({frame->scene, value.slot_id});
                    const auto pose = value.pose_id ? *value.pose_id : character->defaults.pose_id;
                    const auto expression = value.expression_id ? *value.expression_id
                                                                : character->defaults.expression_id;
                    bool visible = current != nullptr && current->visible;
                    if (value.action == core::compiled::ActorCueAction::Show)
                        visible = true;
                    else if (value.action == core::compiled::ActorCueAction::Hide)
                        visible = false;
                    core::ActorState actor{{frame->scene, value.slot_id},
                                           value.character,
                                           pose,
                                           expression,
                                           {value.position, value.offset, value.scale},
                                           visible,
                                           value.transition ==
                                               core::compiled::ActorTransition::None};
                    auto changed = m_state.set_actor(m_project, std::move(actor));
                    if (!changed)
                        return fault(changed.error());
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::CallDialogueSceneInstruction>) {
                    core::SceneStepSubstate substate =
                        value.autosave_safe_point
                            ? core::SceneStepSubstate{core::SceneAutosavePendingPosition{
                                  step, sequential}}
                            : core::SceneStepSubstate{core::SceneStepReady{}};
                    auto called = m_flow.call_child(
                        value.dialogue, value.start_block_id,
                        core::SceneFramePosition{value.autosave_safe_point
                                                     ? std::optional<core::SceneStepId>{step}
                                                     : sequential,
                                                 std::move(substate)});
                    return called ? std::nullopt
                                  : std::optional<core::FlowRunOutcome>{fault(called.error())};
                } else if constexpr (std::is_same_v<T, core::compiled::ShowTextInstruction>) {
                    auto text = resolve(value.text.source, runtime_locale);
                    if (!text) {
                        if (const auto* diagnostics = std::get_if<core::Diagnostics>(&text.error()))
                            return fault(*diagnostics);
                        return fault(
                            script_diagnostics(std::get<ScriptInvocationError>(text.error())));
                    }
                    auto* resolved_text = text.value_if();
                    if (resolved_text == nullptr)
                        return fault(execution_error("execution.invalid_text_result",
                                                     "Scene text produced no value"));
                    auto presented = m_state.present_text(
                        m_project, {value.speaker, *resolved_text, value.text.markup});
                    if (!presented)
                        return fault(presented.error());
                    auto logged = m_state.append_text_log(
                        m_project,
                        {core::TextLogEntryKind::Line, core::SceneTextLogOrigin{frame->scene, step},
                         value.speaker, *resolved_text, value.text.markup});
                    if (!logged)
                        return fault(logged.error());
                    core::WaitSpec wait = std::visit(
                        [](const auto& item) -> core::WaitSpec { return item; }, value.wait);
                    auto waiting = begin(wait);
                    if (!waiting)
                        return fault(waiting.error());
                    const auto* wait_outcome = waiting.value_if();
                    if (wait_outcome != nullptr &&
                        std::holds_alternative<core::WaitBlocked>(*wait_outcome)) {
                        auto marked =
                            m_flow.mark_scene_wait(frame->scene, step,
                                                   core::SceneInstructionCompletionPosition{
                                                       sequential, value.autosave_safe_point});
                        if (!marked)
                            return fault(marked.error());
                        return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                    }
                    if (value.autosave_safe_point)
                        queue_autosave(frame->scene, step);
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::AudioCueInstruction>) {
                    const bool playing = value.action == core::compiled::AudioAction::Play ||
                                         value.action == core::compiled::AudioAction::FadeIn;
                    auto changed = m_state.set_audio_channel(
                        m_project, {value.channel, playing ? value.asset : std::nullopt,
                                    value.volume, value.loop, playing});
                    if (!changed)
                        return fault(changed.error());
                    core::WaitSpec wait = std::visit(
                        [](const auto& item) -> core::WaitSpec { return item; }, value.wait);
                    auto waiting = begin(wait);
                    if (!waiting)
                        return fault(waiting.error());
                    const auto* wait_outcome = waiting.value_if();
                    if (wait_outcome != nullptr &&
                        std::holds_alternative<core::WaitBlocked>(*wait_outcome)) {
                        auto marked = m_flow.mark_scene_wait(
                            frame->scene, step,
                            core::SceneInstructionCompletionPosition{sequential, false});
                        if (!marked)
                            return fault(marked.error());
                        return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::SetVariableSceneInstruction>) {
                    auto changed =
                        apply(core::Effect{core::SetVariable{value.variable, value.value}});
                    if (!changed) {
                        if (const auto* diagnostics =
                                std::get_if<core::Diagnostics>(&changed.error()))
                            return fault(*diagnostics);
                        return fault(
                            script_diagnostics(std::get<ScriptInvocationError>(changed.error())));
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::RunLuaSceneInstruction>) {
                    auto invoked = invoke_script(value.source, "scene-run-lua");
                    if (!invoked)
                        return fault(script_diagnostics(invoked.error()));
                    const auto* invocation_outcome = invoked.value_if();
                    if (invocation_outcome != nullptr &&
                        std::holds_alternative<ScriptInvocationSuspended>(*invocation_outcome)) {
                        if (!value.may_yield) {
                            const auto& suspended =
                                std::get<ScriptInvocationSuspended>(*invocation_outcome);
                            (void)cancel_script(suspended.owner, suspended.invocation);
                            return fault(execution_error("execution.scene_yield_forbidden",
                                                         "Scene RunLua instruction may not yield"));
                        }
                        auto marked =
                            m_flow.mark_scene_wait(frame->scene, step,
                                                   core::SceneInstructionCompletionPosition{
                                                       sequential, value.autosave_safe_point});
                        if (!marked)
                            return fault(marked.error());
                        return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                    }
                    if (value.autosave_safe_point)
                        queue_autosave(frame->scene, step);
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::WaitDurationInstruction>) {
                    auto waiting = begin(core::WaitSpec{value.wait});
                    if (!waiting)
                        return fault(waiting.error());
                    const auto* wait_outcome = waiting.value_if();
                    if (wait_outcome != nullptr &&
                        std::holds_alternative<core::WaitBlocked>(*wait_outcome)) {
                        auto marked = m_flow.mark_scene_wait(
                            frame->scene, step,
                            core::SceneInstructionCompletionPosition{sequential, false});
                        if (!marked)
                            return fault(marked.error());
                        return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::WaitInputInstruction>) {
                    auto waiting = begin(core::WaitSpec{core::InputWait{}});
                    if (!waiting)
                        return fault(waiting.error());
                    auto marked = m_flow.mark_scene_wait(
                        frame->scene, step,
                        core::SceneInstructionCompletionPosition{sequential, false});
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::ConditionalBranchInstruction>) {
                    for (const auto& branch : value.branches) {
                        auto condition = evaluate(branch.condition);
                        if (!condition) {
                            if (const auto* diagnostics =
                                    std::get_if<core::Diagnostics>(&condition.error()))
                                return fault(*diagnostics);
                            return fault(script_diagnostics(
                                std::get<ScriptInvocationError>(condition.error())));
                        }
                        const auto* condition_value = condition.value_if();
                        if (condition_value == nullptr)
                            return fault(execution_error("execution.invalid_condition_result",
                                                         "Scene branch produced no value"));
                        if (*condition_value)
                            return commit(frame->scene, step,
                                          {branch.target_instruction_id, core::SceneStepReady{}});
                    }
                    return commit(frame->scene, step,
                                  {value.fallback_instruction_id, core::SceneStepReady{}});
                } else if constexpr (std::is_same_v<T, core::compiled::ChoiceSceneInstruction>) {
                    core::SceneChoiceState state{frame->scene, step, std::nullopt, {}};
                    if (value.prompt) {
                        auto prompt = resolve(value.prompt->source, runtime_locale);
                        if (!prompt) {
                            if (const auto* diagnostics =
                                    std::get_if<core::Diagnostics>(&prompt.error()))
                                return fault(*diagnostics);
                            return fault(script_diagnostics(
                                std::get<ScriptInvocationError>(prompt.error())));
                        }
                        auto* prompt_value = prompt.value_if();
                        if (prompt_value == nullptr)
                            return fault(execution_error("execution.invalid_text_result",
                                                         "Scene choice prompt produced no value"));
                        state.prompt = std::move(*prompt_value);
                    }
                    for (const auto& option : value.options) {
                        bool enabled = true;
                        if (option.condition) {
                            auto condition = evaluate(*option.condition);
                            if (!condition) {
                                if (const auto* diagnostics =
                                        std::get_if<core::Diagnostics>(&condition.error()))
                                    return fault(*diagnostics);
                                return fault(script_diagnostics(
                                    std::get<ScriptInvocationError>(condition.error())));
                            }
                            const auto* condition_value = condition.value_if();
                            if (condition_value == nullptr)
                                return fault(
                                    execution_error("execution.invalid_condition_result",
                                                    "Scene choice condition produced no value"));
                            enabled = *condition_value;
                        }
                        auto label = resolve(option.label.source, runtime_locale);
                        if (!label) {
                            if (const auto* diagnostics =
                                    std::get_if<core::Diagnostics>(&label.error()))
                                return fault(*diagnostics);
                            return fault(
                                script_diagnostics(std::get<ScriptInvocationError>(label.error())));
                        }
                        auto* label_value = label.value_if();
                        if (label_value == nullptr)
                            return fault(execution_error("execution.invalid_text_result",
                                                         "Scene choice label produced no value"));
                        state.options.push_back({option.id, std::move(*label_value), enabled});
                    }
                    auto waiting = begin(core::WaitSpec{core::InputWait{}});
                    if (!waiting)
                        return fault(waiting.error());
                    auto presented = m_state.present_choice(m_project, std::move(state));
                    if (!presented)
                        return fault(presented.error());
                    auto marked = m_flow.mark_scene_wait(frame->scene, step,
                                                         core::SceneChoiceSelectionPosition{});
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowBlockedOutcome{*m_state.blocker()};
                } else if constexpr (std::is_same_v<T, core::compiled::SetLayoutInstruction>) {
                    core::Result<void, core::Diagnostics> changed =
                        core::Result<void, core::Diagnostics>::success();
                    if (value.action == core::compiled::LayoutAction::Hide)
                        changed = m_state.clear_layout(value.slot);
                    else if (value.layout)
                        changed = m_state.set_layout(m_project, value.slot, *value.layout);
                    else
                        changed = core::Result<void, core::Diagnostics>::failure(
                            execution_error("execution.invalid_scene_layout",
                                            "Scene layout action requires a Layout"));
                    if (!changed)
                        return fault(changed.error());
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                } else {
                    auto changed = m_state.set_transition(
                        {value.transition_kind, value.color,
                         std::holds_alternative<core::ImmediateWait>(value.wait)});
                    if (!changed)
                        return fault(changed.error());
                    core::WaitSpec wait = std::visit(
                        [](const auto& item) -> core::WaitSpec { return item; }, value.wait);
                    auto waiting = begin(wait);
                    if (!waiting)
                        return fault(waiting.error());
                    const auto* wait_outcome = waiting.value_if();
                    if (wait_outcome != nullptr &&
                        std::holds_alternative<core::WaitBlocked>(*wait_outcome)) {
                        auto marked = m_flow.mark_scene_wait(
                            frame->scene, step,
                            core::SceneInstructionCompletionPosition{sequential, false});
                        if (!marked)
                            return fault(marked.error());
                        return core::FlowRunOutcome{core::FlowBlockedOutcome{*m_state.blocker()}};
                    }
                    return commit(frame->scene, step, {sequential, core::SceneStepReady{}});
                }
            },
            *instruction);
        if (outcome)
            return *outcome;
        ++executed;
    }
    return core::FlowBudgetYieldOutcome{executed};
}

core::Result<void, core::Diagnostics>
RuntimeExecutor::choose_scene_option(const core::FlowFrameId& owner,
                                     const core::InputFlowBlockerHandle& handle,
                                     const core::SceneChoiceOptionId& option)
{
    return m_flow.choose_scene_option(owner, handle, option);
}

core::Result<core::SceneView, core::Diagnostics> RuntimeExecutor::scene_view() const
{
    if (m_state.flow_stack().empty())
        return core::Result<core::SceneView, core::Diagnostics>::failure(execution_error(
            "execution.scene_view_unavailable", "Scene view requires an active Scene frame"));
    const auto* frame = std::get_if<core::SceneFrame>(&m_state.flow_stack().back());
    if (frame == nullptr)
        return core::Result<core::SceneView, core::Diagnostics>::failure(execution_error(
            "execution.scene_view_unavailable", "Active flow frame is not a Scene"));
    core::SceneView view{.scene = frame->scene,
                         .background = m_state.background(),
                         .actors = {},
                         .text = m_state.presented_text(),
                         .choice = std::nullopt,
                         .layouts = m_state.layouts(),
                         .transition = m_state.transition(),
                         .audio_channels = m_state.audio_channels()};
    if (m_state.active_choice())
        view.choice =
            std::get_if<core::SceneChoiceState>(&*m_state.active_choice())
                ? std::optional<core::SceneChoiceState>{*std::get_if<core::SceneChoiceState>(
                      &*m_state.active_choice())}
                : std::nullopt;
    for (const auto& actor : m_state.actors()) {
        if (actor.key.scene == frame->scene)
            view.actors.push_back({actor.key, actor.character, actor.pose, actor.expression,
                                   actor.placement, actor.visible, actor.presentation_complete});
    }
    return core::Result<core::SceneView, core::Diagnostics>::success(std::move(view));
}

core::Result<core::SaveState, core::Diagnostics> RuntimeExecutor::snapshot_save() const
{
    return core::make_save_state(m_project, m_state);
}

} // namespace noveltea::runtime
