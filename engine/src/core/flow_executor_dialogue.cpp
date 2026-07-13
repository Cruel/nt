#include "noveltea/core/flow_executor.hpp"

#include <algorithm>
#include <limits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics execution_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

const compiled::DialogueChoiceEdge* find_choice_edge(const compiled::DialogueDefinition& dialogue,
                                                     const DialogueEdgeId& edge)
{
    const auto found = std::find_if(dialogue.program.edges.begin(), dialogue.program.edges.end(),
                                    [&edge](const compiled::DialogueEdge& candidate) {
                                        const auto* choice =
                                            std::get_if<compiled::DialogueChoiceEdge>(&candidate);
                                        return choice != nullptr && choice->id == edge;
                                    });
    return found == dialogue.program.edges.end()
               ? nullptr
               : std::get_if<compiled::DialogueChoiceEdge>(&*found);
}

bool logs_choices(compiled::DialogueLogMode mode) noexcept
{
    return mode == compiled::DialogueLogMode::Everything ||
           mode == compiled::DialogueLogMode::OnlyChoices;
}

} // namespace

Result<void, Diagnostics>
FlowExecutor::advance_dialogue(const DialogueId& dialogue,
                               const DialogueFramePosition& expected_position,
                               DialogueFramePosition next_position)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    auto* frame = std::get_if<DialogueFrame>(&m_state.m_flow_stack.back());
    if (frame == nullptr || frame->dialogue != dialogue || frame->position != expected_position)
        return fail(execution_error("execution.stale_dialogue_position",
                                    "Dialogue advancement does not match the active position"));
    auto valid = validate_position(*frame, FlowFramePosition{next_position});
    if (!valid)
        return fail(valid.error());
    frame->position = std::move(next_position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
FlowExecutor::mark_dialogue_wait(const DialogueId& dialogue,
                                 const DialogueFramePosition& expected_position,
                                 DialogueFramePosition next_position)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    auto* frame = !m_state.m_flow_stack.empty()
                      ? std::get_if<DialogueFrame>(&m_state.m_flow_stack.back())
                      : nullptr;
    if (frame == nullptr || frame->dialogue != dialogue || frame->position != expected_position ||
        !m_state.m_blocker || flow_blocker_owner(*m_state.m_blocker) != frame->frame_id)
        return fail(
            execution_error("execution.invalid_dialogue_wait",
                            "Dialogue wait does not match the active position and blocker"));
    auto valid = validate_position(*frame, FlowFramePosition{next_position});
    if (!valid)
        return fail(valid.error());
    frame->position = std::move(next_position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::choose_dialogue_option(const FlowFrameId& owner,
                                                               const InputFlowBlockerHandle& handle,
                                                               const DialogueEdgeId& edge)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    auto* blocker =
        m_state.m_blocker ? std::get_if<InputFlowBlocker>(&*m_state.m_blocker) : nullptr;
    auto* frame = !m_state.m_flow_stack.empty()
                      ? std::get_if<DialogueFrame>(&m_state.m_flow_stack.back())
                      : nullptr;
    const auto* choice_state = m_state.m_active_choice
                                   ? std::get_if<DialogueChoiceState>(&*m_state.m_active_choice)
                                   : nullptr;
    if (blocker == nullptr || blocker->owner != owner || blocker->handle != handle ||
        frame == nullptr || frame->frame_id != owner ||
        frame->position.stage != DialogueFramePosition::Stage::PresentChoices ||
        frame->position.segment || frame->position.edge || frame->position.next_effect != 0 ||
        !frame->position.awaiting_completion || choice_state == nullptr ||
        choice_state->dialogue != frame->dialogue || choice_state->block != frame->position.block)
        return Result<void, Diagnostics>::failure(
            execution_error("execution.stale_dialogue_choice",
                            "Dialogue choice does not match the active selection"));

    const auto selected = std::find_if(choice_state->options.begin(), choice_state->options.end(),
                                       [&edge](const DialogueChoiceOptionState& candidate) {
                                           return candidate.edge == edge && candidate.enabled;
                                       });
    const auto* dialogue = m_project.find_dialogue(frame->dialogue);
    const auto* compiled_edge = dialogue == nullptr ? nullptr : find_choice_edge(*dialogue, edge);
    if (selected == choice_state->options.end() || compiled_edge == nullptr ||
        compiled_edge->from_block_id != frame->position.block)
        return Result<void, Diagnostics>::failure(execution_error(
            "execution.invalid_dialogue_choice", "Dialogue choice edge is missing or disabled"));

    DialogueFramePosition position{frame->position.block,
                                   std::nullopt,
                                   edge,
                                   DialogueFramePosition::Stage::ApplyChoiceEffects,
                                   0,
                                   false};
    auto valid = validate_position(*frame, FlowFramePosition{position});
    if (!valid)
        return fail(valid.error());

    const DialogueChoiceHistoryKey history{frame->dialogue, edge};
    if (m_state.dialogue_choice_visits(history) == std::numeric_limits<std::uint64_t>::max())
        return fail(execution_error("runtime.history_overflow",
                                    "Dialogue choice history cannot be incremented"));

    auto recorded = m_state.record_dialogue_choice(m_project, history);
    if (!recorded)
        return fail(recorded.error());
    if (compiled_edge->logged && logs_choices(dialogue->settings.log_mode)) {
        auto logged = m_state.append_text_log(
            m_project, TextLogEntry{TextLogEntryKind::Choice,
                                    DialogueChoiceTextLogOrigin{frame->dialogue, edge},
                                    std::nullopt, selected->label, selected->markup});
        if (!logged)
            return fail(logged.error());
    }

    m_state.m_blocker.reset();
    m_state.m_active_choice.reset();
    frame->position = std::move(position);
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
