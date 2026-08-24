#include "codec_internal.hpp"

namespace noveltea::core::save_state_codec {
namespace {

std::optional<double> decode_finite_number(Decoder& d, const nlohmann::json& value,
                                           std::string_view pointer)
{
    auto result = json_access::get<double>(value);
    if (!result || !std::isfinite(*result)) {
        d.error(k_type, "Expected a finite number.", std::string(pointer));
        return std::nullopt;
    }
    return result;
}

std::string_view room_entry_cause_name(RoomEntryCause cause) noexcept
{
    switch (cause) {
    case RoomEntryCause::Entrypoint:
        return "entrypoint";
    case RoomEntryCause::NavigationAttempt:
        return "navigation-attempt";
    case RoomEntryCause::DirectedRoomChange:
        return "directed-room-change";
    }
    return "directed-room-change";
}

std::optional<RoomEntryCause> decode_room_entry_cause(Decoder& d, const nlohmann::json& value,
                                                      std::string_view pointer)
{
    auto name = d.string(value, pointer);
    if (!name)
        return std::nullopt;
    if (*name == "entrypoint")
        return RoomEntryCause::Entrypoint;
    if (*name == "navigation-attempt")
        return RoomEntryCause::NavigationAttempt;
    if (*name == "directed-room-change")
        return RoomEntryCause::DirectedRoomChange;
    d.error(k_variant, "Unknown Room entry cause '" + *name + "'.", std::string(pointer));
    return std::nullopt;
}

std::optional<RoomTransitionKind>
decode_room_transition_kind(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    auto name = d.string(value, pointer);
    if (!name)
        return std::nullopt;
    if (*name == "navigation-attempt")
        return RoomTransitionKind::NavigationAttempt;
    if (*name == "directed-room-change")
        return RoomTransitionKind::DirectedRoomChange;
    d.error(k_variant, "Unknown Room transition kind '" + *name + "'.", std::string(pointer));
    return std::nullopt;
}

nlohmann::json encode_room_context(const std::optional<RoomVisitContext>& context)
{
    if (!context)
        return nullptr;
    nlohmann::json entry_exit = nullptr;
    if (context->entry_exit)
        entry_exit = {{"room", context->entry_exit->room.text()},
                      {"exit", context->entry_exit->exit_id.text()}};
    return {{"room", context->room.text()},
            {"sourceRoom", context->source_room ? nlohmann::json(context->source_room->text())
                                                : nlohmann::json(nullptr)},
            {"entryExit", std::move(entry_exit)},
            {"entryCause", room_entry_cause_name(context->entry_cause)},
            {"entrySequence", context->entry_sequence},
            {"visitIndex", context->visit_index}};
}

std::optional<std::optional<RoomVisitContext>>
decode_room_context(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return std::optional<RoomVisitContext>{};
    if (!d.object(value, pointer,
                  {"room", "sourceRoom", "entryExit", "entryCause", "entrySequence", "visitIndex"}))
        return std::nullopt;
    const auto* room = d.member(value, "room", pointer);
    const auto* source = d.member(value, "sourceRoom", pointer);
    const auto* entry = d.member(value, "entryExit", pointer);
    const auto* cause = d.member(value, "entryCause", pointer);
    const auto* sequence = d.member(value, "entrySequence", pointer);
    const auto* visit = d.member(value, "visitIndex", pointer);
    auto room_id = room ? d.id<RoomId>(*room, child(pointer, "room")) : std::nullopt;
    auto source_id = source ? d.optional_id<RoomId>(*source, child(pointer, "sourceRoom"))
                            : Decoder::OptionalId<RoomId>{};
    std::optional<compiled::RoomExitRef> entry_exit;
    bool entry_ok = entry != nullptr;
    if (entry && !entry->is_null()) {
        const auto entry_pointer = child(pointer, "entryExit");
        if (d.object(*entry, entry_pointer, {"room", "exit"})) {
            const auto* exit_room = d.member(*entry, "room", entry_pointer);
            const auto* exit_id = d.member(*entry, "exit", entry_pointer);
            auto parsed_room =
                exit_room ? d.id<RoomId>(*exit_room, child(entry_pointer, "room")) : std::nullopt;
            auto parsed_exit =
                exit_id ? d.id<RoomExitId>(*exit_id, child(entry_pointer, "exit")) : std::nullopt;
            entry_ok = parsed_room.has_value() && parsed_exit.has_value();
            if (entry_ok)
                entry_exit =
                    compiled::RoomExitRef{std::move(*parsed_room), std::move(*parsed_exit)};
        } else {
            entry_ok = false;
        }
    }
    auto parsed_cause =
        cause ? decode_room_entry_cause(d, *cause, child(pointer, "entryCause")) : std::nullopt;
    auto parsed_sequence =
        sequence
            ? d.unsigned_integer<std::uint64_t>(*sequence, child(pointer, "entrySequence"), true)
            : std::nullopt;
    auto parsed_visit =
        visit ? d.unsigned_integer<std::uint64_t>(*visit, child(pointer, "visitIndex"), true)
              : std::nullopt;
    if (!room_id || !source_id || !entry_ok || !parsed_cause || !parsed_sequence || !parsed_visit)
        return std::nullopt;
    return std::optional<RoomVisitContext>{
        RoomVisitContext{std::move(*room_id), std::move(source_id.value), std::move(entry_exit),
                         *parsed_cause, *parsed_sequence, *parsed_visit}};
}

} // namespace

nlohmann::json encode_destination(const ReturnDestination& destination)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, CallerDestination>)
                return {{"kind", "caller"}};
            else if constexpr (std::is_same_v<T, ResumeRoomDestination>)
                return {{"kind", "resume-room"}, {"room", value.room.text()}};
            else
                return {{"kind", "none"}};
        },
        destination);
}

std::optional<ReturnDestination> decode_destination(Decoder& d, const nlohmann::json& value,
                                                    std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a destination object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    if (*name == "caller") {
        d.object(value, pointer, {"kind"});
        return CallerDestination{};
    }
    if (*name == "none") {
        d.object(value, pointer, {"kind"});
        return NoReturnDestination{};
    }
    if (*name == "resume-room") {
        d.object(value, pointer, {"kind", "room"});
        const auto* room = d.member(value, "room", pointer);
        auto result = room ? d.id<RoomId>(*room, child(pointer, "room")) : std::nullopt;
        return result ? std::optional<ReturnDestination>(ResumeRoomDestination{std::move(*result)})
                      : std::nullopt;
    }
    d.error(k_variant, "Unknown return destination '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

// Frame encoding keeps every live cursor variant explicit. This is intentionally not a generic
// object serializer: all discriminants remain closed and all IDs retain their field type.
nlohmann::json encode_scene_position(const SceneFramePosition& position)
{
    nlohmann::json substate;
    std::visit(
        [&substate](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneStepReady>)
                substate = {{"kind", "ready"}};
            else if constexpr (std::is_same_v<T, SceneInstructionCompletionPosition>)
                substate = {{"kind", "instruction-complete"},
                            {"nextStep", encode_optional_id(value.next_step)},
                            {"autosaveSafePoint", value.autosave_safe_point}};
            else if constexpr (std::is_same_v<T, SceneAutosavePendingPosition>)
                substate = {{"kind", "autosave-pending"},
                            {"completedStep", value.completed_step.text()},
                            {"nextStep", encode_optional_id(value.next_step)}};
            else if constexpr (std::is_same_v<T, SceneChoiceSelectionPosition>)
                substate = {{"kind", "choice-selection"}};
            else
                substate = {{"kind", "choice-effects"},
                            {"option", value.option.text()},
                            {"nextEffect", value.next_effect},
                            {"awaitingCompletion", value.awaiting_completion}};
        },
        position.substate);
    return {{"nextStep", encode_optional_id(position.next_step)},
            {"substate", std::move(substate)}};
}

std::optional<SceneFramePosition> decode_scene_position(Decoder& d, const nlohmann::json& value,
                                                        std::string_view pointer)
{
    if (!d.object(value, pointer, {"nextStep", "substate"}))
        return std::nullopt;
    const auto* next = d.member(value, "nextStep", pointer);
    const auto* substate = d.member(value, "substate", pointer);
    auto next_id = next ? d.optional_id<SceneStepId>(*next, child(pointer, "nextStep"))
                        : Decoder::OptionalId<SceneStepId>{};
    if (!next_id || !substate || !substate->is_object()) {
        if (substate && !substate->is_object())
            d.error(k_type, "Expected a substate object.", child(pointer, "substate"));
        return std::nullopt;
    }
    const auto sub = child(pointer, "substate");
    const auto* kind = d.member(*substate, "kind", sub);
    auto name = kind ? d.string(*kind, child(sub, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    SceneStepSubstate decoded;
    if (*name == "ready") {
        d.object(*substate, sub, {"kind"});
        decoded = SceneStepReady{};
    } else if (*name == "instruction-complete") {
        d.object(*substate, sub, {"kind", "nextStep", "autosaveSafePoint"});
        const auto* after = d.member(*substate, "nextStep", sub);
        const auto* autosave = d.member(*substate, "autosaveSafePoint", sub);
        auto after_id = after ? d.optional_id<SceneStepId>(*after, child(sub, "nextStep"))
                              : Decoder::OptionalId<SceneStepId>{};
        auto safe = autosave ? d.boolean(*autosave, child(sub, "autosaveSafePoint")) : std::nullopt;
        if (!after_id || !safe)
            return std::nullopt;
        decoded = SceneInstructionCompletionPosition{std::move(after_id.value), *safe};
    } else if (*name == "autosave-pending") {
        d.object(*substate, sub, {"kind", "completedStep", "nextStep"});
        const auto* completed = d.member(*substate, "completedStep", sub);
        const auto* after = d.member(*substate, "nextStep", sub);
        auto completed_id =
            completed ? d.id<SceneStepId>(*completed, child(sub, "completedStep")) : std::nullopt;
        auto after_id = after ? d.optional_id<SceneStepId>(*after, child(sub, "nextStep"))
                              : Decoder::OptionalId<SceneStepId>{};
        if (!completed_id || !after_id)
            return std::nullopt;
        decoded = SceneAutosavePendingPosition{std::move(*completed_id), std::move(after_id.value)};
    } else if (*name == "choice-selection") {
        d.object(*substate, sub, {"kind"});
        decoded = SceneChoiceSelectionPosition{};
    } else if (*name == "choice-effects") {
        d.object(*substate, sub, {"kind", "option", "nextEffect", "awaitingCompletion"});
        const auto* option = d.member(*substate, "option", sub);
        const auto* effect = d.member(*substate, "nextEffect", sub);
        const auto* awaiting = d.member(*substate, "awaitingCompletion", sub);
        auto option_id =
            option ? d.id<SceneChoiceOptionId>(*option, child(sub, "option")) : std::nullopt;
        auto effect_index = effect
                                ? d.unsigned_integer<std::size_t>(*effect, child(sub, "nextEffect"))
                                : std::nullopt;
        auto awaiting_value =
            awaiting ? d.boolean(*awaiting, child(sub, "awaitingCompletion")) : std::nullopt;
        if (!option_id || !effect_index || !awaiting_value)
            return std::nullopt;
        decoded = SceneChoiceEffectPosition{std::move(*option_id), *effect_index, *awaiting_value};
    } else {
        d.error(k_variant, "Unknown Scene substate '" + *name + "'.", child(sub, "kind"));
        return std::nullopt;
    }
    return SceneFramePosition{std::move(next_id.value), std::move(decoded)};
}

nlohmann::json encode_dialogue_position(const DialogueFramePosition& value)
{
    static constexpr std::string_view names[] = {
        "enter-block",     "present-segment",      "apply-segment-effects",
        "present-choices", "apply-choice-effects", "follow-edge",
        "complete"};
    return {{"block", value.block.text()},
            {"segment", encode_optional_id(value.segment)},
            {"edge", encode_optional_id(value.edge)},
            {"stage", names[static_cast<std::size_t>(value.stage)]},
            {"nextEffect", value.next_effect},
            {"awaitingCompletion", value.awaiting_completion},
            {"nextCue", value.next_cue},
            {"revealOffset", value.reveal_offset}};
}

std::optional<DialogueFramePosition>
decode_dialogue_position(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer,
                  {"block", "segment", "edge", "stage", "nextEffect", "awaitingCompletion",
                   "nextCue", "revealOffset"}))
        return std::nullopt;
    const auto* block = d.member(value, "block", pointer);
    const auto* segment = d.member(value, "segment", pointer);
    const auto* edge = d.member(value, "edge", pointer);
    const auto* stage = d.member(value, "stage", pointer);
    const auto* effect = d.member(value, "nextEffect", pointer);
    const auto* awaiting = d.member(value, "awaitingCompletion", pointer);
    const auto* next_cue = d.member(value, "nextCue", pointer);
    const auto* reveal_offset = d.member(value, "revealOffset", pointer);
    auto block_id = block ? d.id<DialogueBlockId>(*block, child(pointer, "block")) : std::nullopt;
    auto segment_id = segment
                          ? d.optional_id<DialogueSegmentId>(*segment, child(pointer, "segment"))
                          : Decoder::OptionalId<DialogueSegmentId>{};
    auto edge_id = edge ? d.optional_id<DialogueEdgeId>(*edge, child(pointer, "edge"))
                        : Decoder::OptionalId<DialogueEdgeId>{};
    auto name = stage ? d.string(*stage, child(pointer, "stage")) : std::nullopt;
    auto effect_index = effect
                            ? d.unsigned_integer<std::size_t>(*effect, child(pointer, "nextEffect"))
                            : std::nullopt;
    auto awaiting_value =
        awaiting ? d.boolean(*awaiting, child(pointer, "awaitingCompletion")) : std::nullopt;
    auto next_cue_index =
        next_cue ? d.unsigned_integer<std::size_t>(*next_cue, child(pointer, "nextCue"))
                 : std::nullopt;
    auto reveal_value =
        reveal_offset
            ? d.unsigned_integer<std::uint64_t>(*reveal_offset, child(pointer, "revealOffset"))
            : std::nullopt;
    if (!block_id || !segment_id || !edge_id || !name || !effect_index || !awaiting_value ||
        !next_cue_index || !reveal_value)
        return std::nullopt;
    const std::array<std::string_view, 7> names = {
        "enter-block",     "present-segment",      "apply-segment-effects",
        "present-choices", "apply-choice-effects", "follow-edge",
        "complete"};
    const auto found = std::find(names.begin(), names.end(), *name);
    if (found == names.end()) {
        d.error(k_variant, "Unknown Dialogue stage '" + *name + "'.", child(pointer, "stage"));
        return std::nullopt;
    }
    return DialogueFramePosition{
        std::move(*block_id),
        std::move(segment_id.value),
        std::move(edge_id.value),
        static_cast<DialogueFramePosition::Stage>(std::distance(names.begin(), found)),
        *effect_index,
        *awaiting_value,
        *next_cue_index,
        *reveal_value};
}

nlohmann::json encode_interaction_program(const InteractionProgramRef& value)
{
    return std::visit(
        [](const auto& item) -> nlohmann::json {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, InteractionRuleProgramRef>)
                return {{"kind", "rule"},
                        {"interaction", item.interaction.text()},
                        {"rule", item.rule.text()}};
            else if constexpr (std::is_same_v<T, VerbDefaultProgramRef>)
                return {{"kind", "verb-default"}, {"verb", item.verb.text()}};
            else
                return {{"kind", "project-undefined"}};
        },
        value);
}

std::optional<InteractionProgramRef>
decode_interaction_program(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected an interaction program object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    if (!name)
        return std::nullopt;
    if (*name == "rule") {
        d.object(value, pointer, {"kind", "interaction", "rule"});
        const auto* interaction = d.member(value, "interaction", pointer);
        const auto* rule = d.member(value, "rule", pointer);
        auto interaction_id = interaction
                                  ? d.id<InteractionId>(*interaction, child(pointer, "interaction"))
                                  : std::nullopt;
        auto rule_id = rule ? d.id<InteractionRuleId>(*rule, child(pointer, "rule")) : std::nullopt;
        return interaction_id && rule_id
                   ? std::optional<InteractionProgramRef>(
                         InteractionRuleProgramRef{std::move(*interaction_id), std::move(*rule_id)})
                   : std::nullopt;
    }
    if (*name == "verb-default") {
        d.object(value, pointer, {"kind", "verb"});
        const auto* verb = d.member(value, "verb", pointer);
        auto verb_id = verb ? d.id<VerbId>(*verb, child(pointer, "verb")) : std::nullopt;
        return verb_id ? std::optional<InteractionProgramRef>(
                             VerbDefaultProgramRef{std::move(*verb_id)})
                       : std::nullopt;
    }
    if (*name == "project-undefined") {
        d.object(value, pointer, {"kind"});
        return InteractionProgramRef{ProjectUndefinedProgramRef{}};
    }
    d.error(k_variant, "Unknown interaction program kind '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_interaction_position(const InteractionFramePosition& value)
{
    static constexpr std::string_view stages[] = {"selected-program", "verb-default",
                                                  "undefined-interaction", "complete"};
    static constexpr std::string_view outcomes[] = {"pending", "handled", "unhandled", "failed"};
    return {{"nextInstruction", encode_optional_id(value.next_instruction)},
            {"fallbackStage", stages[static_cast<std::size_t>(value.fallback_stage)]},
            {"outcome", outcomes[static_cast<std::size_t>(value.outcome)]},
            {"awaitingCompletion", value.awaiting_completion}};
}

std::optional<InteractionFramePosition>
decode_interaction_position(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer,
                  {"nextInstruction", "fallbackStage", "outcome", "awaitingCompletion"}))
        return std::nullopt;
    const auto* next = d.member(value, "nextInstruction", pointer);
    const auto* stage = d.member(value, "fallbackStage", pointer);
    const auto* outcome = d.member(value, "outcome", pointer);
    const auto* awaiting = d.member(value, "awaitingCompletion", pointer);
    auto next_id =
        next ? d.optional_id<InteractionInstructionId>(*next, child(pointer, "nextInstruction"))
             : Decoder::OptionalId<InteractionInstructionId>{};
    auto stage_name = stage ? d.string(*stage, child(pointer, "fallbackStage")) : std::nullopt;
    auto outcome_name = outcome ? d.string(*outcome, child(pointer, "outcome")) : std::nullopt;
    auto awaiting_value =
        awaiting ? d.boolean(*awaiting, child(pointer, "awaitingCompletion")) : std::nullopt;
    if (!next_id || !stage_name || !outcome_name || !awaiting_value)
        return std::nullopt;
    const std::array<std::string_view, 4> stages = {"selected-program", "verb-default",
                                                    "undefined-interaction", "complete"};
    const std::array<std::string_view, 4> outcomes = {"pending", "handled", "unhandled", "failed"};
    const auto stage_found = std::find(stages.begin(), stages.end(), *stage_name);
    const auto outcome_found = std::find(outcomes.begin(), outcomes.end(), *outcome_name);
    if (stage_found == stages.end() || outcome_found == outcomes.end()) {
        d.error(k_variant, "Unknown interaction position value.", std::string(pointer));
        return std::nullopt;
    }
    return InteractionFramePosition{
        std::move(next_id.value),
        static_cast<InteractionFallbackStage>(std::distance(stages.begin(), stage_found)),
        static_cast<InteractionExecutionOutcome>(std::distance(outcomes.begin(), outcome_found)),
        *awaiting_value};
}

nlohmann::json encode_room_position(const RoomTransitionPosition& value)
{
    static constexpr std::string_view stages[] = {
        "source-can-leave",   "exit-condition", "target-can-enter", "before-leave", "before-enter",
        "commit-room-switch", "after-leave",    "after-enter",      "complete"};
    return {{"stage", stages[static_cast<std::size_t>(value.stage)]},
            {"nextEffect", value.next_effect},
            {"awaitingCompletion", value.awaiting_completion}};
}

std::optional<RoomTransitionPosition> decode_room_position(Decoder& d, const nlohmann::json& value,
                                                           std::string_view pointer)
{
    if (!d.object(value, pointer, {"stage", "nextEffect", "awaitingCompletion"}))
        return std::nullopt;
    const auto* stage = d.member(value, "stage", pointer);
    const auto* effect = d.member(value, "nextEffect", pointer);
    const auto* awaiting = d.member(value, "awaitingCompletion", pointer);
    auto name = stage ? d.string(*stage, child(pointer, "stage")) : std::nullopt;
    auto effect_index = effect
                            ? d.unsigned_integer<std::size_t>(*effect, child(pointer, "nextEffect"))
                            : std::nullopt;
    auto awaiting_value =
        awaiting ? d.boolean(*awaiting, child(pointer, "awaitingCompletion")) : std::nullopt;
    if (!name || !effect_index || !awaiting_value)
        return std::nullopt;
    const std::array<std::string_view, 9> names = {
        "source-can-leave",   "exit-condition", "target-can-enter", "before-leave", "before-enter",
        "commit-room-switch", "after-leave",    "after-enter",      "complete"};
    const auto found = std::find(names.begin(), names.end(), *name);
    if (found == names.end()) {
        d.error(k_variant, "Unknown Room transition stage '" + *name + "'.",
                child(pointer, "stage"));
        return std::nullopt;
    }
    return RoomTransitionPosition{
        static_cast<RoomTransitionStage>(std::distance(names.begin(), found)), *effect_index,
        *awaiting_value};
}

nlohmann::json encode_dialogue_stage_state(const DialogueStageSlotRuntimeState& slot)
{
    if (!slot.value)
        return {{"slot", slot.slot.text()}, {"value", nullptr}};
    const auto& value = *slot.value;
    const std::array<std::string_view, 4> positions = {"left", "center", "right", "custom"};
    return {{"slot", slot.slot.text()},
            {"value",
             {{"character", value.character.text()},
              {"profileId", value.profile_id.text()},
              {"poseId", value.pose_id.text()},
              {"expressionId", value.expression_id.text()},
              {"appearanceId", encode_optional_id(value.appearance_id)},
              {"position", positions[static_cast<std::size_t>(value.position)]},
              {"offset", {{"x", value.offset.x}, {"y", value.offset.y}}},
              {"scale", value.scale},
              {"visible", value.visible}}}};
}

std::optional<DialogueStageSlotRuntimeState>
decode_dialogue_stage_state(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer, {"slot", "value"}))
        return std::nullopt;
    const auto* slot_value = d.member(value, "slot", pointer);
    const auto* state_value = d.member(value, "value", pointer);
    auto slot =
        slot_value ? d.id<DialogueStageSlotId>(*slot_value, child(pointer, "slot")) : std::nullopt;
    if (!slot || state_value == nullptr)
        return std::nullopt;
    if (state_value->is_null())
        return DialogueStageSlotRuntimeState{std::move(*slot), std::nullopt};
    const auto state_pointer = child(pointer, "value");
    if (!d.object(*state_value, state_pointer,
                  {"character", "profileId", "poseId", "expressionId", "appearanceId", "position",
                   "offset", "scale", "visible"}))
        return std::nullopt;
    const auto* character_value = d.member(*state_value, "character", state_pointer);
    const auto* profile_value = d.member(*state_value, "profileId", state_pointer);
    const auto* pose_value = d.member(*state_value, "poseId", state_pointer);
    const auto* expression_value = d.member(*state_value, "expressionId", state_pointer);
    const auto* appearance_value = d.member(*state_value, "appearanceId", state_pointer);
    const auto* position_value = d.member(*state_value, "position", state_pointer);
    const auto* offset_value = d.member(*state_value, "offset", state_pointer);
    const auto* scale_value = d.member(*state_value, "scale", state_pointer);
    const auto* visible_value = d.member(*state_value, "visible", state_pointer);
    auto character = character_value
                         ? d.id<CharacterId>(*character_value, child(state_pointer, "character"))
                         : std::nullopt;
    auto profile = profile_value ? d.id<CharacterPresentationProfileId>(
                                       *profile_value, child(state_pointer, "profileId"))
                                 : std::nullopt;
    auto pose = pose_value ? d.id<CharacterPoseId>(*pose_value, child(state_pointer, "poseId"))
                           : std::nullopt;
    auto expression =
        expression_value
            ? d.id<CharacterExpressionId>(*expression_value, child(state_pointer, "expressionId"))
            : std::nullopt;
    auto appearance = appearance_value
                          ? d.optional_id<CharacterAppearanceId>(
                                *appearance_value, child(state_pointer, "appearanceId"))
                          : Decoder::OptionalId<CharacterAppearanceId>{};
    auto position_name =
        position_value ? d.string(*position_value, child(state_pointer, "position")) : std::nullopt;
    std::optional<compiled::ActorPosition> position;
    if (position_name) {
        if (*position_name == "left")
            position = compiled::ActorPosition::Left;
        else if (*position_name == "center")
            position = compiled::ActorPosition::Center;
        else if (*position_name == "right")
            position = compiled::ActorPosition::Right;
        else if (*position_name == "custom")
            position = compiled::ActorPosition::Custom;
        else
            d.error(k_variant, "Unknown Dialogue Stage position '" + *position_name + "'.",
                    child(state_pointer, "position"));
    }
    std::optional<compiled::Vector2> offset;
    if (offset_value && d.object(*offset_value, child(state_pointer, "offset"), {"x", "y"})) {
        const auto offset_pointer = child(state_pointer, "offset");
        const auto* x_value = d.member(*offset_value, "x", offset_pointer);
        const auto* y_value = d.member(*offset_value, "y", offset_pointer);
        auto x =
            x_value ? decode_finite_number(d, *x_value, child(offset_pointer, "x")) : std::nullopt;
        auto y =
            y_value ? decode_finite_number(d, *y_value, child(offset_pointer, "y")) : std::nullopt;
        if (x && y)
            offset = compiled::Vector2{*x, *y};
    }
    auto scale = scale_value ? decode_finite_number(d, *scale_value, child(state_pointer, "scale"))
                             : std::nullopt;
    auto visible =
        visible_value ? d.boolean(*visible_value, child(state_pointer, "visible")) : std::nullopt;
    if (!character || !profile || !pose || !expression || !appearance || !position || !offset ||
        !scale || *scale <= 0.0 || !visible)
        return std::nullopt;
    return DialogueStageSlotRuntimeState{
        std::move(*slot),
        compiled::DialogueStageSlotState{
            std::move(*character), std::move(*profile), std::move(*pose), std::move(*expression),
            std::move(appearance.value), *position, *offset, *scale, *visible}};
}

nlohmann::json encode_dialogue_media_content(const compiled::DialogueMediaContent& content)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::DialogueImageMedia>)
                return {{"kind", "image"}, {"asset", value.asset.text()}};
            else
                return {{"kind", "character"},
                        {"character", value.character.text()},
                        {"profileId", value.profile_id.text()},
                        {"poseId", value.pose_id.text()},
                        {"expressionId", value.expression_id.text()},
                        {"appearanceId", encode_optional_id(value.appearance_id)}};
        },
        content);
}

std::optional<compiled::DialogueMediaContent>
decode_dialogue_media_content(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object())
        return std::nullopt;
    const auto* kind_value = d.member(value, "kind", pointer);
    auto kind = kind_value ? d.string(*kind_value, child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "image") {
        if (!d.object(value, pointer, {"kind", "asset"}))
            return std::nullopt;
        const auto* asset_value = d.member(value, "asset", pointer);
        auto asset =
            asset_value ? d.id<AssetId>(*asset_value, child(pointer, "asset")) : std::nullopt;
        return asset ? std::optional<compiled::DialogueMediaContent>(
                           compiled::DialogueImageMedia{std::move(*asset)})
                     : std::nullopt;
    }
    if (*kind == "character") {
        if (!d.object(value, pointer,
                      {"kind", "character", "profileId", "poseId", "expressionId", "appearanceId"}))
            return std::nullopt;
        const auto* character_value = d.member(value, "character", pointer);
        const auto* profile_value = d.member(value, "profileId", pointer);
        const auto* pose_value = d.member(value, "poseId", pointer);
        const auto* expression_value = d.member(value, "expressionId", pointer);
        const auto* appearance_value = d.member(value, "appearanceId", pointer);
        auto character = character_value
                             ? d.id<CharacterId>(*character_value, child(pointer, "character"))
                             : std::nullopt;
        auto profile =
            profile_value
                ? d.id<CharacterPresentationProfileId>(*profile_value, child(pointer, "profileId"))
                : std::nullopt;
        auto pose = pose_value ? d.id<CharacterPoseId>(*pose_value, child(pointer, "poseId"))
                               : std::nullopt;
        auto expression =
            expression_value
                ? d.id<CharacterExpressionId>(*expression_value, child(pointer, "expressionId"))
                : std::nullopt;
        auto appearance = appearance_value ? d.optional_id<CharacterAppearanceId>(
                                                 *appearance_value, child(pointer, "appearanceId"))
                                           : Decoder::OptionalId<CharacterAppearanceId>{};
        return character && profile && pose && expression && appearance
                   ? std::optional<compiled::DialogueMediaContent>(compiled::DialogueCharacterMedia{
                         std::move(*character), std::move(*profile), std::move(*pose),
                         std::move(*expression), std::move(appearance.value)})
                   : std::nullopt;
    }
    d.error(k_variant, "Unknown Dialogue media kind '" + *kind + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_dialogue_media_state(const DialogueMediaSlotRuntimeState& slot)
{
    return {{"slot", slot.slot.text()},
            {"content",
             slot.content ? encode_dialogue_media_content(*slot.content) : nlohmann::json(nullptr)},
            {"visible", slot.visible}};
}

std::optional<DialogueMediaSlotRuntimeState>
decode_dialogue_media_state(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (!d.object(value, pointer, {"slot", "content", "visible"}))
        return std::nullopt;
    const auto* slot_value = d.member(value, "slot", pointer);
    const auto* content_value = d.member(value, "content", pointer);
    const auto* visible_value = d.member(value, "visible", pointer);
    auto slot =
        slot_value ? d.id<DialogueMediaSlotId>(*slot_value, child(pointer, "slot")) : std::nullopt;
    auto visible =
        visible_value ? d.boolean(*visible_value, child(pointer, "visible")) : std::nullopt;
    std::optional<compiled::DialogueMediaContent> content;
    bool content_ok = content_value != nullptr;
    if (content_value && !content_value->is_null()) {
        content = decode_dialogue_media_content(d, *content_value, child(pointer, "content"));
        content_ok = content.has_value();
    }
    return slot && visible && content_ok
               ? std::optional<DialogueMediaSlotRuntimeState>(
                     DialogueMediaSlotRuntimeState{std::move(*slot), std::move(content), *visible})
               : std::nullopt;
}

nlohmann::json encode_frame(const SavedFlowFrame& frame)
{
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedSceneFrame>)
                return {{"kind", "scene"},
                        {"id", value.snapshot_id.value},
                        {"scene", value.scene.text()},
                        {"position", encode_scene_position(value.position)},
                        {"destination", encode_destination(value.destination)}};
            else if constexpr (std::is_same_v<T, SavedDialogueFrame>) {
                nlohmann::json stage_slots = nlohmann::json::array();
                for (const auto& slot : value.stage_slots)
                    stage_slots.push_back(encode_dialogue_stage_state(slot));
                nlohmann::json media_slots = nlohmann::json::array();
                for (const auto& slot : value.media_slots)
                    media_slots.push_back(encode_dialogue_media_state(slot));
                return {{"kind", "dialogue"},
                        {"id", value.snapshot_id.value},
                        {"dialogue", value.dialogue.text()},
                        {"position", encode_dialogue_position(value.position)},
                        {"stageSlots", std::move(stage_slots)},
                        {"mediaSlots", std::move(media_slots)},
                        {"destination", encode_destination(value.destination)}};
            } else if constexpr (std::is_same_v<T, SavedInteractionFrame>) {
                nlohmann::json bindings = nlohmann::json::array();
                for (const auto& binding : value.invocation.bindings) {
                    auto subject_json = std::visit(
                        [](const auto& subject) {
                            using S = std::decay_t<decltype(subject)>;
                            if constexpr (std::is_same_v<S, compiled::CharacterInteractionSubject>)
                                return nlohmann::json{{"kind", "character"},
                                                      {"id", subject.character.text()}};
                            else if constexpr (std::is_same_v<
                                                   S, compiled::InteractableInteractionSubject>)
                                return nlohmann::json{{"kind", "interactable"},
                                                      {"id", subject.interactable.text()}};
                            else if constexpr (std::is_same_v<S,
                                                              compiled::FeatureInteractionSubject>)
                                return std::visit(
                                    [](const auto& reference) {
                                        using F = std::decay_t<decltype(reference)>;
                                        if constexpr (std::is_same_v<F, RoomFeatureRef>)
                                            return nlohmann::json{
                                                {"kind", "feature"},
                                                {"ownerKind", "room"},
                                                {"ownerId", reference.room.text()},
                                                {"featureId", reference.feature_id.text()}};
                                        else
                                            return nlohmann::json{
                                                {"kind", "feature"},
                                                {"ownerKind", "interactable"},
                                                {"ownerId", reference.interactable.text()},
                                                {"featureId", reference.feature_id.text()}};
                                    },
                                    subject.feature);
                            else
                                return nlohmann::json{{"kind", "item-stack"},
                                                      {"id", subject.item_stack.text()}};
                        },
                        binding.subject);
                    bindings.push_back(
                        {{"slotId", binding.slot_id.text()}, {"subject", std::move(subject_json)}});
                }
                return {{"kind", "interaction"},
                        {"id", value.snapshot_id.value},
                        {"invocation",
                         {{"verb", value.invocation.verb.text()},
                          {"room", encode_optional_id(value.invocation.room)},
                          {"bindings", std::move(bindings)}}},
                        {"program", encode_interaction_program(value.program)},
                        {"position", encode_interaction_position(value.position)},
                        {"destination", encode_destination(value.destination)}};
            } else
                return {{"kind", "room-transition"},
                        {"id", value.snapshot_id.value},
                        {"sourceRoom", encode_optional_id(value.source_room)},
                        {"targetRoom", value.target_room.text()},
                        {"selectedExit",
                         value.selected_exit
                             ? nlohmann::json{{"room", value.selected_exit->room.text()},
                                              {"exit", value.selected_exit->exit_id.text()}}
                             : nlohmann::json(nullptr)},
                        {"transitionKind", value.kind == RoomTransitionKind::NavigationAttempt
                                               ? "navigation-attempt"
                                               : "directed-room-change"},
                        {"entryCause", room_entry_cause_name(value.entry_cause)},
                        {"sourceContext", encode_room_context(value.source_context)},
                        {"position", encode_room_position(value.position)},
                        {"destination", encode_destination(value.destination)}};
        },
        frame);
}

std::optional<SavedFlowFrame> decode_frame(Decoder& d, const nlohmann::json& value,
                                           std::string_view pointer)
{
    if (!value.is_object()) {
        d.error(k_type, "Expected a flow frame object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    const auto* id = d.member(value, "id", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    auto snapshot =
        id ? d.unsigned_integer<std::uint64_t>(*id, child(pointer, "id"), true) : std::nullopt;
    if (!name || !snapshot)
        return std::nullopt;
    if (*name == "scene") {
        d.object(value, pointer, {"kind", "id", "scene", "position", "destination"});
        const auto* scene = d.member(value, "scene", pointer);
        const auto* position = d.member(value, "position", pointer);
        const auto* destination = d.member(value, "destination", pointer);
        auto scene_id = scene ? d.id<SceneId>(*scene, child(pointer, "scene")) : std::nullopt;
        auto saved_position = position
                                  ? decode_scene_position(d, *position, child(pointer, "position"))
                                  : std::nullopt;
        auto saved_destination =
            destination ? decode_destination(d, *destination, child(pointer, "destination"))
                        : std::nullopt;
        return scene_id && saved_position && saved_destination
                   ? std::optional<SavedFlowFrame>(SavedSceneFrame{{*snapshot},
                                                                   std::move(*scene_id),
                                                                   std::move(*saved_position),
                                                                   std::move(*saved_destination)})
                   : std::nullopt;
    }
    if (*name == "dialogue") {
        d.object(value, pointer,
                 {"kind", "id", "dialogue", "position", "stageSlots", "mediaSlots", "destination"});
        const auto* dialogue = d.member(value, "dialogue", pointer);
        const auto* position = d.member(value, "position", pointer);
        const auto* stage_slots = d.member(value, "stageSlots", pointer);
        const auto* media_slots = d.member(value, "mediaSlots", pointer);
        const auto* destination = d.member(value, "destination", pointer);
        auto dialogue_id =
            dialogue ? d.id<DialogueId>(*dialogue, child(pointer, "dialogue")) : std::nullopt;
        auto saved_position =
            position ? decode_dialogue_position(d, *position, child(pointer, "position"))
                     : std::nullopt;
        auto saved_destination =
            destination ? decode_destination(d, *destination, child(pointer, "destination"))
                        : std::nullopt;
        std::vector<DialogueStageSlotRuntimeState> decoded_stage_slots;
        if (!stage_slots || !stage_slots->is_array()) {
            if (stage_slots)
                d.error(k_type, "Expected an array.", child(pointer, "stageSlots"));
            return std::nullopt;
        }
        for (std::size_t item = 0; item < stage_slots->size(); ++item) {
            const auto* slot = json_access::element(*stage_slots, item);
            auto decoded = slot ? decode_dialogue_stage_state(
                                      d, *slot, index(child(pointer, "stageSlots"), item))
                                : std::nullopt;
            if (!decoded)
                return std::nullopt;
            decoded_stage_slots.push_back(std::move(*decoded));
        }
        std::vector<DialogueMediaSlotRuntimeState> decoded_media_slots;
        if (!media_slots || !media_slots->is_array()) {
            if (media_slots)
                d.error(k_type, "Expected an array.", child(pointer, "mediaSlots"));
            return std::nullopt;
        }
        for (std::size_t item = 0; item < media_slots->size(); ++item) {
            const auto* slot = json_access::element(*media_slots, item);
            auto decoded = slot ? decode_dialogue_media_state(
                                      d, *slot, index(child(pointer, "mediaSlots"), item))
                                : std::nullopt;
            if (!decoded)
                return std::nullopt;
            decoded_media_slots.push_back(std::move(*decoded));
        }
        return dialogue_id && saved_position && saved_destination
                   ? std::optional<SavedFlowFrame>(
                         SavedDialogueFrame{{*snapshot},
                                            std::move(*dialogue_id),
                                            std::move(*saved_position),
                                            std::move(decoded_stage_slots),
                                            std::move(decoded_media_slots),
                                            std::move(*saved_destination)})
                   : std::nullopt;
    }
    if (*name == "interaction") {
        d.object(value, pointer,
                 {"kind", "id", "invocation", "program", "position", "destination"});
        const auto* invocation = d.member(value, "invocation", pointer);
        const auto* program = d.member(value, "program", pointer);
        const auto* position = d.member(value, "position", pointer);
        const auto* destination = d.member(value, "destination", pointer);
        if (!invocation ||
            !d.object(*invocation, child(pointer, "invocation"), {"verb", "room", "bindings"}))
            return std::nullopt;
        const auto invoke = child(pointer, "invocation");
        const auto* verb = d.member(*invocation, "verb", invoke);
        const auto* room = d.member(*invocation, "room", invoke);
        const auto* bindings = d.member(*invocation, "bindings", invoke);
        auto verb_id = verb ? d.id<VerbId>(*verb, child(invoke, "verb")) : std::nullopt;
        auto room_id = room ? d.optional_id<RoomId>(*room, child(invoke, "room"))
                            : Decoder::OptionalId<RoomId>{};
        std::vector<InteractionSubjectBinding> decoded_bindings;
        if (!bindings || !bindings->is_array()) {
            if (bindings)
                d.error(k_type, "Expected an array.", child(invoke, "bindings"));
            return std::nullopt;
        }
        for (std::size_t item = 0; item < bindings->size(); ++item) {
            const auto* binding = json_access::element(*bindings, item);
            const auto binding_path = index(child(invoke, "bindings"), item);
            if (!binding || !d.object(*binding, binding_path, {"slotId", "subject"}))
                continue;
            const auto* slot = d.member(*binding, "slotId", binding_path);
            const auto* source = d.member(*binding, "subject", binding_path);
            auto slot_id =
                slot ? d.id<VerbSlotId>(*slot, child(binding_path, "slotId")) : std::nullopt;
            const auto subject_path = child(binding_path, "subject");
            if (!source || !source->is_object()) {
                if (source)
                    d.error(k_type, "Expected an Interaction subject object.", subject_path);
                continue;
            }
            std::optional<compiled::InteractionSubject> decoded_subject;
            const auto* kind = d.member(*source, "kind", subject_path);
            const auto name = kind ? d.string(*kind, child(subject_path, "kind")) : std::nullopt;
            if (name && *name == "character") {
                d.object(*source, subject_path, {"kind", "id"});
                const auto* id = d.member(*source, "id", subject_path);
                auto subject_id =
                    id ? d.id<CharacterId>(*id, child(subject_path, "id")) : std::nullopt;
                if (subject_id)
                    decoded_subject = compiled::CharacterInteractionSubject{std::move(*subject_id)};
            } else if (name && *name == "interactable") {
                d.object(*source, subject_path, {"kind", "id"});
                const auto* id = d.member(*source, "id", subject_path);
                auto subject_id =
                    id ? d.id<InteractableId>(*id, child(subject_path, "id")) : std::nullopt;
                if (subject_id)
                    decoded_subject =
                        compiled::InteractableInteractionSubject{std::move(*subject_id)};
            } else if (name && *name == "feature") {
                d.object(*source, subject_path, {"kind", "ownerKind", "ownerId", "featureId"});
                const auto* owner_kind = d.member(*source, "ownerKind", subject_path);
                const auto* owner_id = d.member(*source, "ownerId", subject_path);
                const auto* feature_id = d.member(*source, "featureId", subject_path);
                auto owner_name = owner_kind
                                      ? d.string(*owner_kind, child(subject_path, "ownerKind"))
                                      : std::nullopt;
                auto parsed_feature =
                    feature_id ? d.id<FeatureId>(*feature_id, child(subject_path, "featureId"))
                               : std::nullopt;
                if (owner_name && *owner_name == "room") {
                    auto parsed_owner =
                        owner_id ? d.id<RoomId>(*owner_id, child(subject_path, "ownerId"))
                                 : std::nullopt;
                    if (parsed_owner && parsed_feature)
                        decoded_subject = compiled::FeatureInteractionSubject{
                            RoomFeatureRef{std::move(*parsed_owner), std::move(*parsed_feature)}};
                } else if (owner_name && *owner_name == "interactable") {
                    auto parsed_owner =
                        owner_id ? d.id<InteractableId>(*owner_id, child(subject_path, "ownerId"))
                                 : std::nullopt;
                    if (parsed_owner && parsed_feature)
                        decoded_subject =
                            compiled::FeatureInteractionSubject{InteractableFeatureRef{
                                std::move(*parsed_owner), std::move(*parsed_feature)}};
                } else if (owner_name) {
                    d.error(k_variant, "Unknown Feature owner kind '" + *owner_name + "'.",
                            child(subject_path, "ownerKind"));
                }
            } else if (name && *name == "item-stack") {
                d.object(*source, subject_path, {"kind", "id"});
                const auto* id = d.member(*source, "id", subject_path);
                auto subject_id =
                    id ? d.id<ItemStackId>(*id, child(subject_path, "id")) : std::nullopt;
                if (subject_id)
                    decoded_subject = compiled::ItemStackInteractionSubject{std::move(*subject_id)};
            } else if (name) {
                d.error(k_variant, "Unknown Interaction subject kind '" + *name + "'.",
                        child(subject_path, "kind"));
            }
            if (slot_id && decoded_subject)
                decoded_bindings.push_back({std::move(*slot_id), std::move(*decoded_subject)});
        }
        auto saved_program =
            program ? decode_interaction_program(d, *program, child(pointer, "program"))
                    : std::nullopt;
        auto saved_position =
            position ? decode_interaction_position(d, *position, child(pointer, "position"))
                     : std::nullopt;
        auto saved_destination =
            destination ? decode_destination(d, *destination, child(pointer, "destination"))
                        : std::nullopt;
        return verb_id && room_id && saved_program && saved_position && saved_destination
                   ? std::optional<SavedFlowFrame>(
                         SavedInteractionFrame{{*snapshot},
                                               {std::move(*verb_id), std::move(room_id.value),
                                                std::move(decoded_bindings)},
                                               std::move(*saved_program),
                                               std::move(*saved_position),
                                               std::move(*saved_destination)})
                   : std::nullopt;
    }
    if (*name == "room-transition") {
        d.object(value, pointer,
                 {"kind", "id", "sourceRoom", "targetRoom", "selectedExit", "transitionKind",
                  "entryCause", "sourceContext", "position", "destination"});
        const auto* source = d.member(value, "sourceRoom", pointer);
        const auto* target = d.member(value, "targetRoom", pointer);
        const auto* selected = d.member(value, "selectedExit", pointer);
        const auto* transition_kind = d.member(value, "transitionKind", pointer);
        const auto* entry_cause = d.member(value, "entryCause", pointer);
        const auto* source_context = d.member(value, "sourceContext", pointer);
        const auto* position = d.member(value, "position", pointer);
        const auto* destination = d.member(value, "destination", pointer);
        auto source_id = source ? d.optional_id<RoomId>(*source, child(pointer, "sourceRoom"))
                                : Decoder::OptionalId<RoomId>{};
        auto target_id =
            target ? d.id<RoomId>(*target, child(pointer, "targetRoom")) : std::nullopt;
        std::optional<compiled::RoomExitRef> exit;
        if (selected && !selected->is_null()) {
            const auto selected_pointer = child(pointer, "selectedExit");
            if (d.object(*selected, selected_pointer, {"room", "exit"})) {
                const auto* room = d.member(*selected, "room", selected_pointer);
                const auto* exit_id = d.member(*selected, "exit", selected_pointer);
                auto room_id =
                    room ? d.id<RoomId>(*room, child(selected_pointer, "room")) : std::nullopt;
                auto parsed_exit = exit_id
                                       ? d.id<RoomExitId>(*exit_id, child(selected_pointer, "exit"))
                                       : std::nullopt;
                if (room_id && parsed_exit)
                    exit = compiled::RoomExitRef{std::move(*room_id), std::move(*parsed_exit)};
            }
        }
        auto parsed_kind =
            transition_kind
                ? decode_room_transition_kind(d, *transition_kind, child(pointer, "transitionKind"))
                : std::nullopt;
        auto parsed_cause =
            entry_cause ? decode_room_entry_cause(d, *entry_cause, child(pointer, "entryCause"))
                        : std::nullopt;
        auto parsed_source_context =
            source_context
                ? decode_room_context(d, *source_context, child(pointer, "sourceContext"))
                : std::nullopt;
        auto saved_position = position
                                  ? decode_room_position(d, *position, child(pointer, "position"))
                                  : std::nullopt;
        auto saved_destination =
            destination ? decode_destination(d, *destination, child(pointer, "destination"))
                        : std::nullopt;
        return source_id && target_id && parsed_kind && parsed_cause && parsed_source_context &&
                       saved_position && saved_destination &&
                       (selected == nullptr || selected->is_null() || exit)
                   ? std::optional<SavedFlowFrame>(
                         SavedRoomTransitionFrame{{*snapshot},
                                                  std::move(source_id.value),
                                                  std::move(*target_id),
                                                  std::move(exit),
                                                  *parsed_kind,
                                                  *parsed_cause,
                                                  std::move(*parsed_source_context),
                                                  std::move(*saved_position),
                                                  std::move(*saved_destination)})
                   : std::nullopt;
    }
    d.error(k_variant, "Unknown flow frame kind '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}

nlohmann::json encode_blocker(const std::optional<SavedFlowBlocker>& blocker)
{
    if (!blocker)
        return nullptr;
    return std::visit(
        [](const auto& value) -> nlohmann::json {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SavedInputBlocker>)
                return {{"kind", "input"}, {"owner", value.owner.value}};
            else
                return {{"kind", "duration"},
                        {"owner", value.owner.value},
                        {"remainingMs", value.remaining.count()}};
        },
        *blocker);
}

std::optional<std::optional<SavedFlowBlocker>>
decode_blocker(Decoder& d, const nlohmann::json& value, std::string_view pointer)
{
    if (value.is_null())
        return std::optional<SavedFlowBlocker>{};
    if (!value.is_object()) {
        d.error(k_type, "Expected a blocker object or null.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind = d.member(value, "kind", pointer);
    const auto* owner = d.member(value, "owner", pointer);
    auto name = kind ? d.string(*kind, child(pointer, "kind")) : std::nullopt;
    auto owner_id = owner ? d.unsigned_integer<std::uint64_t>(*owner, child(pointer, "owner"), true)
                          : std::nullopt;
    if (!name || !owner_id)
        return std::nullopt;
    if (*name == "input") {
        d.object(value, pointer, {"kind", "owner"});
        return std::optional<SavedFlowBlocker>(SavedInputBlocker{{*owner_id}});
    }
    if (*name == "duration") {
        d.object(value, pointer, {"kind", "owner", "remainingMs"});
        const auto* remaining = d.member(value, "remainingMs", pointer);
        auto duration =
            remaining
                ? d.unsigned_integer<std::uint64_t>(*remaining, child(pointer, "remainingMs"), true)
                : std::nullopt;
        if (!duration ||
            *duration > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
            if (duration)
                d.error(k_value, "Duration is outside the supported range.",
                        child(pointer, "remainingMs"));
            return std::nullopt;
        }
        return std::optional<SavedFlowBlocker>(
            SavedDurationBlocker{{*owner_id}, std::chrono::milliseconds(*duration)});
    }
    d.error(k_variant, "Unknown blocker kind '" + *name + "'.", child(pointer, "kind"));
    return std::nullopt;
}
} // namespace noveltea::core::save_state_codec
