#include "noveltea/runtime/runtime_executor.hpp"

#include <algorithm>
#include <limits>
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
    return execution_error("execution.dialogue_script_failed", error.message);
}

core::Diagnostics execution_diagnostics(const RuntimeExecutionError& error)
{
    if (const auto* diagnostics = std::get_if<core::Diagnostics>(&error))
        return *diagnostics;
    return script_diagnostics(std::get<ScriptInvocationError>(error));
}

const core::compiled::DialogueBlock* find_block(const core::compiled::DialogueDefinition& dialogue,
                                                const core::DialogueBlockId& block)
{
    const auto found = std::find_if(
        dialogue.program.blocks.begin(), dialogue.program.blocks.end(),
        [&block](const core::compiled::DialogueBlock& candidate) {
            return std::visit([&block](const auto& value) { return value.id == block; }, candidate);
        });
    return found == dialogue.program.blocks.end() ? nullptr : &*found;
}

const core::compiled::DialogueSegment*
find_segment(const core::compiled::DialogueSequenceBlock& block,
             const core::DialogueSegmentId& segment)
{
    const auto found = std::find_if(
        block.segments.begin(), block.segments.end(),
        [&segment](const core::compiled::DialogueSegment& candidate) {
            return std::visit([&segment](const auto& value) { return value.id == segment; },
                              candidate);
        });
    return found == block.segments.end() ? nullptr : &*found;
}

const core::compiled::DialogueEdge* find_edge(const core::compiled::DialogueDefinition& dialogue,
                                              const core::DialogueEdgeId& edge)
{
    const auto found = std::find_if(
        dialogue.program.edges.begin(), dialogue.program.edges.end(),
        [&edge](const core::compiled::DialogueEdge& candidate) {
            return std::visit([&edge](const auto& value) { return value.id == edge; }, candidate);
        });
    return found == dialogue.program.edges.end() ? nullptr : &*found;
}

const core::compiled::DialogueNextEdge*
find_next_edge(const core::compiled::DialogueDefinition& dialogue,
               const core::DialogueBlockId& block)
{
    const auto found =
        std::find_if(dialogue.program.edges.begin(), dialogue.program.edges.end(),
                     [&block](const core::compiled::DialogueEdge& candidate) {
                         const auto* next =
                             std::get_if<core::compiled::DialogueNextEdge>(&candidate);
                         return next != nullptr && next->from_block_id == block;
                     });
    return found == dialogue.program.edges.end()
               ? nullptr
               : std::get_if<core::compiled::DialogueNextEdge>(&*found);
}

const core::GameplayCommand* find_gameplay_command(std::span<const core::GameplayCommand> commands,
                                                   const core::InteractionInstructionId& id)
{
    for (const auto& command : commands) {
        if (command.id == id)
            return &command;
        if (const auto* branch = std::get_if<core::IfGameplayCommand>(&command.value)) {
            if (const auto* found = find_gameplay_command(branch->then_commands, id))
                return found;
            if (const auto* found = find_gameplay_command(branch->else_commands, id))
                return found;
        }
    }
    return nullptr;
}

std::optional<core::InteractionInstructionId>
next_gameplay_command(std::span<const core::GameplayCommand> commands,
                      const core::InteractionInstructionId& id,
                      std::optional<core::InteractionInstructionId> after_commands)
{
    for (std::size_t index = 0; index < commands.size(); ++index) {
        const auto successor =
            index + 1 < commands.size()
                ? std::optional<core::InteractionInstructionId>{commands[index + 1].id}
                : after_commands;
        if (commands[index].id == id)
            return successor;
        if (const auto* branch = std::get_if<core::IfGameplayCommand>(&commands[index].value)) {
            if (find_gameplay_command(branch->then_commands, id))
                return next_gameplay_command(branch->then_commands, id, successor);
            if (find_gameplay_command(branch->else_commands, id))
                return next_gameplay_command(branch->else_commands, id, successor);
        }
    }
    return std::nullopt;
}

const core::GameplayCommand*
current_dialogue_effect(const std::vector<core::GameplayCommand>& effects,
                        const core::DialogueFramePosition& position)
{
    if (position.next_effect >= effects.size())
        return nullptr;
    if (!position.effect_command)
        return &effects[position.next_effect];
    const auto* branch = std::get_if<core::IfGameplayCommand>(&effects[position.next_effect].value);
    if (!branch)
        return nullptr;
    if (const auto* found = find_gameplay_command(branch->then_commands, *position.effect_command))
        return found;
    return find_gameplay_command(branch->else_commands, *position.effect_command);
}

core::DialogueFramePosition
dialogue_position_after_effect(const std::vector<core::GameplayCommand>& effects,
                               core::DialogueFramePosition position)
{
    position.awaiting_completion = false;
    if (!position.effect_command) {
        ++position.next_effect;
        return position;
    }
    if (position.next_effect >= effects.size()) {
        position.effect_command.reset();
        return position;
    }
    const auto* branch = std::get_if<core::IfGameplayCommand>(&effects[position.next_effect].value);
    if (!branch) {
        position.effect_command.reset();
        ++position.next_effect;
        return position;
    }
    const auto id = *position.effect_command;
    std::optional<core::InteractionInstructionId> next;
    if (find_gameplay_command(branch->then_commands, id))
        next = next_gameplay_command(branch->then_commands, id, std::nullopt);
    else if (find_gameplay_command(branch->else_commands, id))
        next = next_gameplay_command(branch->else_commands, id, std::nullopt);
    if (next) {
        position.effect_command = *next;
        return position;
    }
    position.effect_command.reset();
    ++position.next_effect;
    return position;
}

core::DialogueFramePosition
dialogue_position_enter_branch(const std::vector<core::GameplayCommand>& effects,
                               core::DialogueFramePosition position,
                               const std::vector<core::GameplayCommand>& branch)
{
    if (!branch.empty()) {
        position.effect_command = branch.front().id;
        position.awaiting_completion = false;
        return position;
    }
    return dialogue_position_after_effect(effects, std::move(position));
}

core::DialogueFramePosition
sequence_position_after(const core::compiled::DialogueDefinition& dialogue,
                        const core::compiled::DialogueSequenceBlock& block,
                        const std::optional<core::DialogueSegmentId>& completed_segment)
{
    std::size_t next_index = 0;
    if (completed_segment) {
        const auto found = std::find_if(
            block.segments.begin(), block.segments.end(),
            [&completed_segment](const core::compiled::DialogueSegment& candidate) {
                return std::visit([&completed_segment](
                                      const auto& value) { return value.id == *completed_segment; },
                                  candidate);
            });
        next_index =
            found == block.segments.end()
                ? block.segments.size()
                : static_cast<std::size_t>(std::distance(block.segments.begin(), found)) + 1;
    }
    if (next_index < block.segments.size()) {
        const auto segment =
            std::visit([](const auto& value) { return value.id; }, block.segments[next_index]);
        return {block.id, segment, std::nullopt, core::DialogueFramePosition::Stage::PresentSegment,
                0,        false};
    }
    if (const auto* edge = find_next_edge(dialogue, block.id))
        return {block.id, std::nullopt, edge->id, core::DialogueFramePosition::Stage::FollowEdge,
                0,        false};
    return {block.id, std::nullopt, std::nullopt, core::DialogueFramePosition::Stage::Complete,
            0,        false};
}

bool logs_lines(core::compiled::DialogueLogMode mode) noexcept
{
    return mode == core::compiled::DialogueLogMode::Everything ||
           mode == core::compiled::DialogueLogMode::OnlyLines;
}

} // namespace

std::optional<core::FlowRunOutcome>
RuntimeExecutor::run_dialogue_unit(std::string_view runtime_locale)
{
    auto fault = [this](core::Diagnostics diagnostics) -> std::optional<core::FlowRunOutcome> {
        const auto copy = diagnostics;
        (void)m_flow.fault(std::move(diagnostics));
        return core::FlowFaultOutcome{copy};
    };

    if (m_state.flow_stack().empty())
        return fault(execution_error("execution.invalid_stack",
                                     "Dialogue execution requires an active frame"));
    const auto* active = std::get_if<core::DialogueFrame>(&m_state.flow_stack().back());
    if (active == nullptr)
        return fault(execution_error("execution.invalid_dialogue_frame",
                                     "Active flow frame is not a Dialogue"));
    const core::DialogueFrame frame = *active;
    const auto* dialogue = m_project.find_dialogue(frame.dialogue);
    const auto* block = dialogue == nullptr ? nullptr : find_block(*dialogue, frame.position.block);
    if (dialogue == nullptr || block == nullptr)
        return fault(execution_error("execution.invalid_dialogue_position",
                                     "Active Dialogue definition or block is missing"));

    auto commit = [this, &frame, &fault](
                      core::DialogueFramePosition position) -> std::optional<core::FlowRunOutcome> {
        auto advanced =
            m_flow.advance_dialogue(frame.dialogue, frame.position, std::move(position));
        return advanced ? std::nullopt : fault(advanced.error());
    };
    auto mark_wait =
        [this, &frame,
         &fault](core::DialogueFramePosition position) -> std::optional<core::FlowRunOutcome> {
        auto marked =
            m_flow.mark_dialogue_wait(frame.dialogue, frame.position, std::move(position));
        return marked ? std::nullopt : fault(marked.error());
    };
    auto apply_immediate_effects = [this](const std::vector<core::GameplayCommand>& effects,
                                          core::DialogueFramePosition position,
                                          std::vector<core::CommandResultBinding>& command_results)
        -> core::Result<core::DialogueFramePosition, core::Diagnostics> {
        std::vector<const core::GameplayCommand*> batch;
        auto cursor = position;
        while (const auto* command = current_dialogue_effect(effects, cursor)) {
            if (!gameplay_command_is_immediate(*command))
                break;
            batch.push_back(command);
            cursor = dialogue_position_after_effect(effects, std::move(cursor));
        }
        if (batch.empty())
            return core::Result<core::DialogueFramePosition, core::Diagnostics>::success(
                std::move(position));

        auto staged_state = m_state;
        core::FlowExecutor staged_flow(m_project, staged_state);
        core::SharedPrimitiveEvaluator staged_primitives(m_project, staged_state, staged_flow);
        RuntimeWorld staged_world(m_project, staged_state);
        auto staged_results = command_results;
        for (const auto* command : batch) {
            auto applied =
                apply_immediate_gameplay_command(*command, staged_state, staged_world, staged_flow,
                                                 staged_primitives, {}, staged_results);
            if (!applied)
                return core::Result<core::DialogueFramePosition, core::Diagnostics>::failure(
                    applied.error());
        }
        for (const auto* command : batch) {
            auto applied = apply_immediate_gameplay_command(*command, m_state, m_world, m_flow,
                                                            m_primitives, {}, command_results);
            if (!applied)
                return core::Result<core::DialogueFramePosition, core::Diagnostics>::failure(
                    applied.error());
        }
        return core::Result<core::DialogueFramePosition, core::Diagnostics>::success(
            std::move(cursor));
    };
    auto execute_boundary =
        [this, &frame, &fault, &mark_wait,
         runtime_locale](const core::GameplayCommand& command,
                         core::DialogueFramePosition next) -> std::optional<core::FlowRunOutcome> {
        return std::visit(
            [&](const auto& value) -> std::optional<core::FlowRunOutcome> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::NotifyCommand>) {
                    auto message = resolve(value.message.source, runtime_locale);
                    if (!message)
                        return fault(execution_diagnostics(message.error()));
                    auto requested = m_gateway.request_notification(*message.value_if());
                    if (!requested)
                        return fault(requested.error());
                    auto advanced = m_flow.advance_dialogue(frame.dialogue, frame.position, next);
                    return advanced ? std::nullopt : fault(advanced.error());
                } else if constexpr (std::is_same_v<T, core::PresentInventoryCommand>) {
                    const core::ConditionEvaluationContext context{
                        .interaction_bindings = {}, .command_results = frame.command_results};
                    auto inventory = m_primitives.resolve_inventory(value.inventory, context);
                    if (!inventory)
                        return fault(inventory.error());
                    auto presented = present_inventory(*inventory.value_if(), value.layout);
                    if (!presented)
                        return fault(presented.error());
                    auto advanced = m_flow.advance_dialogue(frame.dialogue, frame.position, next);
                    return advanced ? std::nullopt : fault(advanced.error());
                } else if constexpr (std::is_same_v<T, core::CallSceneCommand>) {
                    auto called = m_flow.call_child(value.scene, core::FlowFramePosition{next});
                    return called ? std::nullopt : fault(called.error());
                } else if constexpr (std::is_same_v<T, core::CallDialogueCommand>) {
                    auto called = m_flow.call_child(value.dialogue, std::nullopt,
                                                    core::FlowFramePosition{next});
                    return called ? std::nullopt : fault(called.error());
                } else if constexpr (std::is_same_v<T, core::RunLuaCommand>) {
                    auto invoked = invoke_script(value.source, "gameplay-command");
                    if (!invoked)
                        return fault(script_diagnostics(invoked.error()));
                    const auto* outcome = invoked.value_if();
                    const auto* suspended = outcome == nullptr
                                                ? nullptr
                                                : std::get_if<ScriptInvocationSuspended>(outcome);
                    if (suspended == nullptr) {
                        auto advanced =
                            m_flow.advance_dialogue(frame.dialogue, frame.position, next);
                        return advanced ? std::nullopt : fault(advanced.error());
                    }
                    auto waiting = frame.position;
                    waiting.awaiting_completion = true;
                    if (auto failed = mark_wait(std::move(waiting)))
                        return failed;
                    return core::FlowBlockedOutcome{*m_state.blocker()};
                } else
                    return fault(execution_error(
                        "execution.invalid_dialogue_gameplay_command",
                        "Immediate Gameplay Command reached an observable command boundary"));
            },
            command.value);
    };

    switch (frame.position.stage) {
    case core::DialogueFramePosition::Stage::EnterBlock: {
        if (const auto* sequence = std::get_if<core::compiled::DialogueSequenceBlock>(block))
            return commit(sequence_position_after(*dialogue, *sequence, std::nullopt));
        if (std::holds_alternative<core::compiled::DialogueChoiceBlock>(*block))
            return commit({frame.position.block, std::nullopt, std::nullopt,
                           core::DialogueFramePosition::Stage::PresentChoices, 0, false});
        const auto* redirect = std::get_if<core::compiled::DialogueRedirectBlock>(block);
        if (redirect == nullptr || find_block(*dialogue, redirect->target_block_id) == nullptr)
            return fault(execution_error("execution.invalid_dialogue_redirect",
                                         "Dialogue redirect target is missing"));
        return commit({redirect->target_block_id, std::nullopt, std::nullopt,
                       core::DialogueFramePosition::Stage::EnterBlock, 0, false});
    }
    case core::DialogueFramePosition::Stage::PresentSegment: {
        const auto* sequence = std::get_if<core::compiled::DialogueSequenceBlock>(block);
        const auto* segment = sequence != nullptr && frame.position.segment
                                  ? find_segment(*sequence, *frame.position.segment)
                                  : nullptr;
        if (sequence == nullptr || segment == nullptr)
            return fault(execution_error("execution.invalid_dialogue_segment",
                                         "Active Dialogue segment is missing"));

        const auto next = sequence_position_after(*dialogue, *sequence, frame.position.segment);
        if (const auto* line = std::get_if<core::compiled::DialogueLineSegment>(segment)) {
            const core::DialogueLineHistoryKey history{frame.dialogue, line->id};
            if (line->show_once && m_state.dialogue_line_visits(history) != 0)
                return commit(next);
            if (line->condition) {
                auto condition = evaluate(*line->condition);
                if (!condition)
                    return fault(execution_diagnostics(condition.error()));
                const auto* value = condition.value_if();
                if (value == nullptr)
                    return fault(execution_error("execution.invalid_condition_result",
                                                 "Dialogue line condition produced no value"));
                if (!*value)
                    return commit(next);
            }

            auto resolved = resolve(line->text.source, runtime_locale);
            if (!resolved)
                return fault(execution_diagnostics(resolved.error()));
            auto* text = resolved.value_if();
            if (text == nullptr)
                return fault(execution_error("execution.invalid_text_result",
                                             "Dialogue line text produced no value"));
            const auto speaker = line->speaker
                                     ? line->speaker
                                     : (sequence->default_speaker ? sequence->default_speaker
                                                                  : dialogue->default_speaker);
            if (m_state.dialogue_line_visits(history) == std::numeric_limits<std::uint64_t>::max())
                return fault(execution_error("runtime.history_overflow",
                                             "Dialogue line history cannot be incremented"));

            auto waiting = begin(core::WaitSpec{core::InputWait{}});
            if (!waiting)
                return fault(waiting.error());
            const auto* wait = waiting.value_if();
            const auto* blocked = wait == nullptr ? nullptr : std::get_if<core::WaitBlocked>(wait);
            if (blocked == nullptr)
                return fault(execution_error("execution.invalid_dialogue_wait",
                                             "Dialogue line did not create an input blocker"));

            auto presented = m_state.present_text(
                m_project, core::PresentedTextState{speaker, *text, line->text.markup});
            if (!presented) {
                (void)m_flow.cancel_blocker(core::flow_blocker_owner(blocked->blocker),
                                            core::flow_blocker_handle(blocked->blocker));
                return fault(presented.error());
            }
            auto recorded = m_state.record_dialogue_line(m_project, history);
            if (!recorded) {
                (void)m_flow.cancel_blocker(core::flow_blocker_owner(blocked->blocker),
                                            core::flow_blocker_handle(blocked->blocker));
                return fault(recorded.error());
            }
            if (line->logged && logs_lines(dialogue->settings.log_mode)) {
                auto logged = m_state.append_text_log(
                    m_project,
                    core::TextLogEntry{core::TextLogEntryKind::Line,
                                       core::DialogueLineTextLogOrigin{frame.dialogue, line->id},
                                       speaker, *text, line->text.markup});
                if (!logged) {
                    (void)m_flow.cancel_blocker(core::flow_blocker_owner(blocked->blocker),
                                                core::flow_blocker_handle(blocked->blocker));
                    return fault(logged.error());
                }
            }

            const core::DialogueFramePosition effects{
                frame.position.block,
                line->id,
                std::nullopt,
                core::DialogueFramePosition::Stage::ApplySegmentEffects,
                0,
                false};
            if (auto* live = std::get_if<core::DialogueFrame>(&m_state.m_flow_stack.back()))
                live->command_results.clear();
            if (auto failed = mark_wait(effects))
                return failed;
            return core::FlowBlockedOutcome{blocked->blocker};
        }

        if (const auto* call = std::get_if<core::compiled::DialogueCallSceneSegment>(segment)) {
            if (call->condition) {
                auto condition = evaluate(*call->condition);
                if (!condition)
                    return fault(execution_diagnostics(condition.error()));
                const auto* value = condition.value_if();
                if (value == nullptr)
                    return fault(
                        execution_error("execution.invalid_condition_result",
                                        "Dialogue child Scene condition produced no value"));
                if (!*value)
                    return commit(next);
            }
            auto called = m_flow.call_child(
                call->scene, call->inputs, next,
                call->ui_policy == core::compiled::DialogueChildSceneUiPolicy::Preserve);
            return called ? std::nullopt : fault(called.error());
        }

        if (const auto* handoff = std::get_if<core::compiled::DialogueHandoffSegment>(segment)) {
            if (handoff->condition) {
                auto condition = evaluate(*handoff->condition);
                if (!condition)
                    return fault(execution_diagnostics(condition.error()));
                const auto* value = condition.value_if();
                if (value == nullptr)
                    return fault(execution_error("execution.invalid_condition_result",
                                                 "Dialogue Handoff condition produced no value"));
                if (!*value)
                    return commit(next);
            }
            auto handed_off = m_flow.handoff_dialogue(next, handoff->payload);
            if (!handed_off)
                return fault(handed_off.error());
            if (!*handed_off.value_if()) {
                m_flow_diagnostics.push_back(core::Diagnostic{
                    .code = "execution.dialogue_handoff_without_awaiting_scene",
                    .message = "Dialogue Handoff has no direct awaiting Scene; Dialogue continues.",
                    .severity = core::ErrorSeverity::Warning});
                return std::nullopt;
            }
            m_gateway.request_autosave_safe_point();
            return core::FlowPresentationBoundaryOutcome{};
        }

        const auto* script = std::get_if<core::compiled::DialogueRunLuaSegment>(segment);
        if (script == nullptr)
            return fault(execution_error("execution.invalid_dialogue_segment",
                                         "Dialogue segment variant is invalid"));
        if (frame.position.awaiting_completion)
            return commit(next);
        if (script->condition) {
            auto condition = evaluate(*script->condition);
            if (!condition)
                return fault(execution_diagnostics(condition.error()));
            const auto* value = condition.value_if();
            if (value == nullptr)
                return fault(execution_error("execution.invalid_condition_result",
                                             "Dialogue script condition produced no value"));
            if (!*value)
                return commit(next);
        }
        auto invoked = invoke_script(script->source, "dialogue-run-lua");
        if (!invoked)
            return fault(script_diagnostics(invoked.error()));
        const auto* outcome = invoked.value_if();
        const auto* suspended =
            outcome == nullptr ? nullptr : std::get_if<ScriptInvocationSuspended>(outcome);
        if (suspended == nullptr)
            return commit(next);
        if (!script->may_yield) {
            (void)cancel_script(suspended->owner, suspended->invocation);
            return fault(execution_error("execution.dialogue_yield_forbidden",
                                         "Dialogue RunLua segment may not yield"));
        }
        auto waiting_position = frame.position;
        waiting_position.awaiting_completion = true;
        if (auto failed = mark_wait(waiting_position))
            return failed;
        return core::FlowBlockedOutcome{*m_state.blocker()};
    }
    case core::DialogueFramePosition::Stage::ApplySegmentEffects: {
        const auto* sequence = std::get_if<core::compiled::DialogueSequenceBlock>(block);
        const auto* segment = sequence != nullptr && frame.position.segment
                                  ? find_segment(*sequence, *frame.position.segment)
                                  : nullptr;
        const auto* line = segment == nullptr
                               ? nullptr
                               : std::get_if<core::compiled::DialogueLineSegment>(segment);
        if (sequence == nullptr || line == nullptr)
            return fault(execution_error("execution.invalid_dialogue_segment",
                                         "Dialogue line effect position is invalid"));
        if (frame.position.awaiting_completion) {
            return commit(dialogue_position_after_effect(line->effects, frame.position));
        }
        if (frame.position.next_effect >= line->effects.size()) {
            if (auto* live = std::get_if<core::DialogueFrame>(&m_state.m_flow_stack.back()))
                live->command_results.clear();
            if (line->autosave_safe_point)
                m_gateway.request_autosave_safe_point();
            return commit(sequence_position_after(*dialogue, *sequence, line->id));
        }
        auto* live = std::get_if<core::DialogueFrame>(&m_state.m_flow_stack.back());
        if (live == nullptr)
            return fault(execution_error("execution.invalid_dialogue_frame",
                                         "Dialogue frame disappeared during effect execution"));
        const auto* command = current_dialogue_effect(line->effects, frame.position);
        if (command == nullptr)
            return fault(execution_error("execution.invalid_dialogue_gameplay_command",
                                         "Dialogue effect command cursor is invalid"));
        if (gameplay_command_is_immediate(*command)) {
            auto applied =
                apply_immediate_effects(line->effects, frame.position, live->command_results);
            if (!applied)
                return fault(applied.error());
            return commit(std::move(*applied.value_if()));
        }
        if (const auto* branch = std::get_if<core::IfGameplayCommand>(&command->value)) {
            const core::ConditionEvaluationContext context{
                .interaction_bindings = {}, .command_results = live->command_results};
            auto condition = m_primitives.evaluate(branch->condition, context);
            if (!condition)
                return fault(condition.error());
            const auto& selected =
                *condition.value_if() ? branch->then_commands : branch->else_commands;
            return commit(dialogue_position_enter_branch(line->effects, frame.position, selected));
        }
        return execute_boundary(*command,
                                dialogue_position_after_effect(line->effects, frame.position));
    }
    case core::DialogueFramePosition::Stage::PresentChoices: {
        if (frame.position.awaiting_completion)
            return fault(execution_error("execution.dialogue_choice_without_blocker",
                                         "Dialogue choice selection lost its input blocker"));
        core::DialogueChoiceState choices{frame.dialogue, frame.position.block, {}};
        for (const auto& candidate : dialogue->program.edges) {
            const auto* edge = std::get_if<core::compiled::DialogueChoiceEdge>(&candidate);
            if (edge == nullptr || edge->from_block_id != frame.position.block)
                continue;
            bool enabled = true;
            if (edge->condition) {
                auto condition = evaluate(*edge->condition);
                if (!condition)
                    return fault(execution_diagnostics(condition.error()));
                const auto* value = condition.value_if();
                if (value == nullptr)
                    return fault(execution_error("execution.invalid_condition_result",
                                                 "Dialogue choice condition produced no value"));
                enabled = *value;
            }
            if (!enabled && !dialogue->settings.show_disabled_choices)
                continue;
            auto resolved = resolve(edge->label.source, runtime_locale);
            if (!resolved)
                return fault(execution_diagnostics(resolved.error()));
            auto* label = resolved.value_if();
            if (label == nullptr)
                return fault(execution_error("execution.invalid_text_result",
                                             "Dialogue choice label produced no value"));
            choices.options.push_back({edge->id, std::move(*label), enabled, edge->label.markup});
        }

        auto waiting = begin(core::WaitSpec{core::InputWait{}});
        if (!waiting)
            return fault(waiting.error());
        const auto* wait = waiting.value_if();
        const auto* blocked = wait == nullptr ? nullptr : std::get_if<core::WaitBlocked>(wait);
        if (blocked == nullptr)
            return fault(execution_error("execution.invalid_dialogue_wait",
                                         "Dialogue choice did not create an input blocker"));
        auto presented = m_state.present_choice(m_project, std::move(choices));
        if (!presented) {
            (void)m_flow.cancel_blocker(core::flow_blocker_owner(blocked->blocker),
                                        core::flow_blocker_handle(blocked->blocker));
            return fault(presented.error());
        }
        auto waiting_position = frame.position;
        waiting_position.awaiting_completion = true;
        if (auto failed = mark_wait(waiting_position))
            return failed;
        return core::FlowBlockedOutcome{blocked->blocker};
    }
    case core::DialogueFramePosition::Stage::ApplyChoiceEffects: {
        const auto* edge =
            frame.position.edge ? find_edge(*dialogue, *frame.position.edge) : nullptr;
        const auto* choice =
            edge == nullptr ? nullptr : std::get_if<core::compiled::DialogueChoiceEdge>(edge);
        if (choice == nullptr || choice->from_block_id != frame.position.block)
            return fault(execution_error("execution.invalid_dialogue_edge",
                                         "Dialogue choice effect position is invalid"));
        if (frame.position.awaiting_completion) {
            return commit(dialogue_position_after_effect(choice->effects, frame.position));
        }
        if (frame.position.next_effect >= choice->effects.size()) {
            if (auto* live = std::get_if<core::DialogueFrame>(&m_state.m_flow_stack.back()))
                live->command_results.clear();
            if (choice->autosave_safe_point)
                m_gateway.request_autosave_safe_point();
            return commit({frame.position.block, std::nullopt, choice->id,
                           core::DialogueFramePosition::Stage::FollowEdge, 0, false});
        }
        auto* live = std::get_if<core::DialogueFrame>(&m_state.m_flow_stack.back());
        if (live == nullptr)
            return fault(execution_error("execution.invalid_dialogue_frame",
                                         "Dialogue frame disappeared during effect execution"));
        const auto* command = current_dialogue_effect(choice->effects, frame.position);
        if (command == nullptr)
            return fault(execution_error("execution.invalid_dialogue_gameplay_command",
                                         "Dialogue choice effect command cursor is invalid"));
        if (gameplay_command_is_immediate(*command)) {
            auto applied =
                apply_immediate_effects(choice->effects, frame.position, live->command_results);
            if (!applied)
                return fault(applied.error());
            return commit(std::move(*applied.value_if()));
        }
        if (const auto* branch = std::get_if<core::IfGameplayCommand>(&command->value)) {
            const core::ConditionEvaluationContext context{
                .interaction_bindings = {}, .command_results = live->command_results};
            auto condition = m_primitives.evaluate(branch->condition, context);
            if (!condition)
                return fault(condition.error());
            const auto& selected =
                *condition.value_if() ? branch->then_commands : branch->else_commands;
            return commit(
                dialogue_position_enter_branch(choice->effects, frame.position, selected));
        }
        return execute_boundary(*command,
                                dialogue_position_after_effect(choice->effects, frame.position));
    }
    case core::DialogueFramePosition::Stage::FollowEdge: {
        const auto* edge =
            frame.position.edge ? find_edge(*dialogue, *frame.position.edge) : nullptr;
        if (edge == nullptr)
            return fault(execution_error("execution.invalid_dialogue_edge",
                                         "Active Dialogue edge is missing"));
        const auto from = std::visit([](const auto& value) { return value.from_block_id; }, *edge);
        const auto target = std::visit([](const auto& value) { return value.to_block_id; }, *edge);
        if (from != frame.position.block || find_block(*dialogue, target) == nullptr)
            return fault(execution_error("execution.invalid_dialogue_edge",
                                         "Dialogue edge target is missing or mismatched"));
        return commit({target, std::nullopt, std::nullopt,
                       core::DialogueFramePosition::Stage::EnterBlock, 0, false});
    }
    case core::DialogueFramePosition::Stage::Complete: {
        auto completed = m_flow.apply_target(dialogue->completion);
        return completed ? std::nullopt : fault(completed.error());
    }
    }
    return fault(
        execution_error("execution.invalid_dialogue_position", "Dialogue frame stage is invalid"));
}

core::Result<void, core::Diagnostics>
RuntimeExecutor::choose_dialogue_option(const core::FlowFrameId& owner,
                                        const core::InputFlowBlockerHandle& handle,
                                        const core::DialogueEdgeId& edge)
{
    return m_flow.choose_dialogue_option(owner, handle, edge);
}

core::Result<core::DialogueView, core::Diagnostics> RuntimeExecutor::dialogue_view() const
{
    if (m_state.flow_stack().empty())
        return core::Result<core::DialogueView, core::Diagnostics>::failure(
            execution_error("execution.dialogue_view_unavailable",
                            "Dialogue view requires an active Dialogue frame"));
    const auto* frame = std::get_if<core::DialogueFrame>(&m_state.flow_stack().back());
    if (frame == nullptr)
        return core::Result<core::DialogueView, core::Diagnostics>::failure(execution_error(
            "execution.dialogue_view_unavailable", "Active flow frame is not a Dialogue"));
    return dialogue_view(*frame);
}

core::Result<core::DialogueView, core::Diagnostics>
RuntimeExecutor::dialogue_view(const core::DialogueFrame& frame) const
{
    core::DialogueView view{.frame = frame.frame_id,
                            .dialogue = frame.dialogue,
                            .segment = frame.position.segment,
                            .reveal_offset = frame.position.reveal_offset,
                            .line = m_state.presented_text(),
                            .choice = std::nullopt,
                            .stage_slots = {},
                            .media_slots = {}};
    const auto* definition = m_project.find_dialogue(frame.dialogue);
    if (definition == nullptr)
        return core::Result<core::DialogueView, core::Diagnostics>::failure(execution_error(
            "execution.dialogue_view_unavailable", "Active Dialogue definition is missing"));
    view.stage_slots.reserve(frame.stage_slots.size());
    for (const auto& state : frame.stage_slots) {
        const auto slot =
            std::find_if(definition->stage_slots.begin(), definition->stage_slots.end(),
                         [&state](const auto& candidate) { return candidate.id == state.slot; });
        if (slot == definition->stage_slots.end())
            continue;
        const bool speaking = state.value && slot->speaker_sync && view.line &&
                              view.line->speaker && state.value->character == *view.line->speaker;
        view.stage_slots.push_back({state.slot, state.value, slot->speaker_sync, speaking});
    }
    view.media_slots.reserve(frame.media_slots.size());
    for (const auto& state : frame.media_slots)
        view.media_slots.push_back({state.slot, state.content, state.visible});
    if (m_state.active_choice()) {
        const auto* choice = std::get_if<core::DialogueChoiceState>(&*m_state.active_choice());
        if (choice != nullptr && choice->dialogue == frame.dialogue)
            view.choice = *choice;
    }
    return core::Result<core::DialogueView, core::Diagnostics>::success(std::move(view));
}

} // namespace noveltea::runtime
