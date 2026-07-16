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
            if (auto failed = mark_wait(effects))
                return failed;
            return core::FlowBlockedOutcome{blocked->blocker};
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
            auto position = frame.position;
            ++position.next_effect;
            position.awaiting_completion = false;
            return commit(std::move(position));
        }
        if (frame.position.next_effect >= line->effects.size()) {
            if (line->autosave_safe_point)
                m_gateway.request_autosave_safe_point();
            return commit(sequence_position_after(*dialogue, *sequence, line->id));
        }
        auto applied = apply(line->effects[frame.position.next_effect], "dialogue-line-effect");
        if (!applied)
            return fault(execution_diagnostics(applied.error()));
        const auto* effect = applied.value_if();
        const auto* suspended =
            effect == nullptr ? nullptr : std::get_if<ScriptInvocationSuspended>(effect);
        auto position = frame.position;
        if (suspended != nullptr) {
            position.awaiting_completion = true;
            if (auto failed = mark_wait(position))
                return failed;
            return core::FlowBlockedOutcome{*m_state.blocker()};
        }
        ++position.next_effect;
        return commit(std::move(position));
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
            auto position = frame.position;
            ++position.next_effect;
            position.awaiting_completion = false;
            return commit(std::move(position));
        }
        if (frame.position.next_effect >= choice->effects.size()) {
            if (choice->autosave_safe_point)
                m_gateway.request_autosave_safe_point();
            return commit({frame.position.block, std::nullopt, choice->id,
                           core::DialogueFramePosition::Stage::FollowEdge, 0, false});
        }
        auto applied = apply(choice->effects[frame.position.next_effect], "dialogue-choice-effect");
        if (!applied)
            return fault(execution_diagnostics(applied.error()));
        const auto* effect = applied.value_if();
        const auto* suspended =
            effect == nullptr ? nullptr : std::get_if<ScriptInvocationSuspended>(effect);
        auto position = frame.position;
        if (suspended != nullptr) {
            position.awaiting_completion = true;
            if (auto failed = mark_wait(position))
                return failed;
            return core::FlowBlockedOutcome{*m_state.blocker()};
        }
        ++position.next_effect;
        return commit(std::move(position));
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
    core::DialogueView view{
        .dialogue = frame->dialogue, .line = m_state.presented_text(), .choice = std::nullopt};
    if (m_state.active_choice()) {
        const auto* choice = std::get_if<core::DialogueChoiceState>(&*m_state.active_choice());
        if (choice != nullptr && choice->dialogue == frame->dialogue)
            view.choice = *choice;
    }
    return core::Result<core::DialogueView, core::Diagnostics>::success(std::move(view));
}

} // namespace noveltea::runtime
