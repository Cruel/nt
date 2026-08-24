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

const compiled::CharacterPresentationProfile*
find_profile(const compiled::CharacterDefinition& character,
             const CharacterPresentationProfileId& profile)
{
    const auto found = std::find_if(character.profiles.begin(), character.profiles.end(),
                                    [&profile](const auto& value) { return value.id == profile; });
    return found == character.profiles.end() ? nullptr : &*found;
}

bool has_expression(const compiled::CharacterDefinition& character,
                    const CharacterExpressionId& expression)
{
    return std::any_of(character.expressions.begin(), character.expressions.end(),
                       [&expression](const auto& value) { return value.id == expression; });
}

bool has_appearance(const compiled::CharacterDefinition& character,
                    const std::optional<CharacterAppearanceId>& appearance)
{
    return !appearance ||
           std::any_of(character.appearances.begin(), character.appearances.end(),
                       [&appearance](const auto& value) { return value.id == *appearance; });
}

std::optional<compiled::DialogueStageSlotState>
default_stage_state(const compiled::CharacterDefinition& character)
{
    const auto* profile = find_profile(character, character.defaults.profile_id);
    if (profile == nullptr)
        return std::nullopt;
    return compiled::DialogueStageSlotState{character.identity.id,
                                            character.defaults.profile_id,
                                            profile->default_pose_id,
                                            character.defaults.expression_id,
                                            character.defaults.appearance_id,
                                            compiled::ActorPosition::Center,
                                            {0.0, 0.0},
                                            1.0,
                                            true};
}

bool valid_stage_state(const CompiledProject& project,
                       const compiled::DialogueStageSlotState& state)
{
    const auto* character = project.find_character(state.character);
    if (character == nullptr)
        return false;
    const auto* profile = find_profile(*character, state.profile_id);
    return profile != nullptr &&
           std::any_of(profile->poses.begin(), profile->poses.end(),
                       [&state](const auto& pose) { return pose.id == state.pose_id; }) &&
           has_expression(*character, state.expression_id) &&
           has_appearance(*character, state.appearance_id) && state.scale > 0.0;
}

const compiled::DialogueStageSlotDefinition*
find_stage_definition(const compiled::DialogueDefinition& dialogue, const DialogueStageSlotId& id)
{
    const auto found = std::find_if(dialogue.stage_slots.begin(), dialogue.stage_slots.end(),
                                    [&id](const auto& slot) { return slot.id == id; });
    return found == dialogue.stage_slots.end() ? nullptr : &*found;
}

bool valid_media(const CompiledProject& project, const compiled::DialogueMediaContent& content)
{
    return std::visit(
        [&project](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::DialogueImageMedia>) {
                const auto* asset = project.find_asset(value.asset);
                return asset != nullptr && asset->kind == compiled::AssetKind::Image;
            } else {
                return valid_stage_state(
                    project, compiled::DialogueStageSlotState{value.character,
                                                              value.profile_id,
                                                              value.pose_id,
                                                              value.expression_id,
                                                              value.appearance_id,
                                                              compiled::ActorPosition::Center,
                                                              {0.0, 0.0},
                                                              1.0,
                                                              true});
            }
        },
        content);
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

Result<void, Diagnostics>
FlowExecutor::apply_dialogue_presentation(const DialogueId& dialogue,
                                          const DialogueFramePosition& expected_position,
                                          const std::optional<CharacterId>& speaker,
                                          const compiled::DialogueLinePresentation& presentation)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    auto* frame = !m_state.m_flow_stack.empty()
                      ? std::get_if<DialogueFrame>(&m_state.m_flow_stack.back())
                      : nullptr;
    const auto* definition = m_project.find_dialogue(dialogue);
    if (frame == nullptr || definition == nullptr || frame->dialogue != dialogue ||
        frame->position != expected_position)
        return fail(execution_error("execution.stale_dialogue_position",
                                    "Dialogue presentation does not match the active position"));

    auto stage_slots = frame->stage_slots;
    auto media_slots = frame->media_slots;
    for (const auto& mutation : presentation.stage) {
        auto slot = std::find_if(stage_slots.begin(), stage_slots.end(),
                                 [&](const auto& value) { return value.slot == mutation.slot_id; });
        if (slot == stage_slots.end() ||
            find_stage_definition(*definition, mutation.slot_id) == nullptr)
            return fail(execution_error("execution.invalid_dialogue_stage_slot",
                                        "Dialogue Stage mutation references an unknown slot"));
        if (mutation.action == compiled::DialogueSlotMutationAction::Clear) {
            slot->value.reset();
            continue;
        }

        std::optional<compiled::DialogueStageSlotState> value = slot->value;
        if (mutation.character) {
            const auto* character = m_project.find_character(*mutation.character);
            if (character == nullptr)
                return fail(
                    execution_error("execution.invalid_dialogue_character",
                                    "Dialogue Stage mutation references an unknown Character"));
            auto replacement = default_stage_state(*character);
            if (!replacement)
                return fail(
                    execution_error("execution.invalid_dialogue_character_presentation",
                                    "Dialogue Character has no valid default presentation"));
            if (value) {
                replacement->position = value->position;
                replacement->offset = value->offset;
                replacement->scale = value->scale;
                replacement->visible = value->visible;
            }
            value = std::move(replacement);
        }
        if (!value)
            return fail(
                execution_error("execution.empty_dialogue_stage_slot",
                                "Dialogue Stage mutation requires a populated slot or Character"));

        const auto* character = m_project.find_character(value->character);
        if (character == nullptr)
            return fail(execution_error("execution.invalid_dialogue_character",
                                        "Dialogue Stage Slot Character is unavailable"));
        if (mutation.profile_id) {
            const auto* profile = find_profile(*character, *mutation.profile_id);
            if (profile == nullptr)
                return fail(
                    execution_error("execution.invalid_dialogue_profile",
                                    "Dialogue Stage mutation references an invalid Profile"));
            value->profile_id = *mutation.profile_id;
            value->pose_id = profile->default_pose_id;
        }
        if (mutation.pose_id)
            value->pose_id = *mutation.pose_id;
        if (mutation.expression_id)
            value->expression_id = *mutation.expression_id;
        if (mutation.appearance_id)
            value->appearance_id = *mutation.appearance_id;
        if (mutation.position)
            value->position = *mutation.position;
        if (mutation.offset)
            value->offset = *mutation.offset;
        if (mutation.scale)
            value->scale = *mutation.scale;
        if (mutation.action == compiled::DialogueSlotMutationAction::Show)
            value->visible = true;
        else if (mutation.action == compiled::DialogueSlotMutationAction::Hide)
            value->visible = false;
        if (!valid_stage_state(m_project, *value))
            return fail(
                execution_error("execution.invalid_dialogue_stage_state",
                                "Dialogue Stage mutation produces invalid Character presentation"));
        slot->value = std::move(value);
    }

    if (presentation.speaker_expression_id && speaker) {
        for (auto& slot : stage_slots) {
            const auto* slot_definition = find_stage_definition(*definition, slot.slot);
            if (!slot.value || slot_definition == nullptr || !slot_definition->speaker_sync ||
                slot.value->character != *speaker)
                continue;
            const auto* character = m_project.find_character(slot.value->character);
            if (character == nullptr ||
                !has_expression(*character, *presentation.speaker_expression_id))
                return fail(
                    execution_error("execution.invalid_dialogue_speaker_expression",
                                    "Speaker Expression is unavailable on the speaking Character"));
            slot.value->expression_id = *presentation.speaker_expression_id;
        }
    }

    for (const auto& mutation : presentation.media) {
        auto slot = std::find_if(media_slots.begin(), media_slots.end(),
                                 [&](const auto& value) { return value.slot == mutation.slot_id; });
        if (slot == media_slots.end())
            return fail(execution_error("execution.invalid_dialogue_media_slot",
                                        "Dialogue Media mutation references an unknown slot"));
        if (mutation.action == compiled::DialogueSlotMutationAction::Clear) {
            slot->content.reset();
            continue;
        }
        if (mutation.content) {
            if (!valid_media(m_project, *mutation.content))
                return fail(execution_error("execution.invalid_dialogue_media",
                                            "Dialogue Media mutation contains invalid content"));
            slot->content = mutation.content;
        }
        if (!slot->content)
            return fail(execution_error("execution.empty_dialogue_media_slot",
                                        "Dialogue Media mutation requires populated content"));
        if (mutation.action == compiled::DialogueSlotMutationAction::Show)
            slot->visible = true;
        else if (mutation.action == compiled::DialogueSlotMutationAction::Hide)
            slot->visible = false;
    }

    frame->stage_slots = std::move(stage_slots);
    frame->media_slots = std::move(media_slots);
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
