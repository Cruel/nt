#include "internal.hpp"

namespace noveltea::core::compiled::wire::detail {

std::optional<Condition> decode_optional_condition(Decoder& decoder, const nlohmann::json& object,
                                                   std::string_view pointer, bool& valid)
{
    const auto* value = json_access::member(object, "condition");
    if (!value) {
        valid = true;
        return std::nullopt;
    }
    auto condition = decode_condition_impl(decoder, *value, pointer_child(pointer, "condition"));
    valid = condition.has_value();
    return condition;
}

std::optional<std::vector<Effect>> decode_effects(Decoder& decoder, const nlohmann::json& value,
                                                  std::string_view pointer)
{
    return decoder.array<Effect>(
        value, pointer, [&](const nlohmann::json& effect, const std::string& item_pointer) {
            return decode_effect_impl(decoder, effect, item_pointer);
        });
}

std::optional<InteractionInstruction> decode_interaction_instruction(Decoder& decoder,
                                                                     const nlohmann::json& value,
                                                                     std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected an interaction instruction object.",
                      std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    const auto* id_value = decoder.member(value, "id", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    auto id = id_value
                  ? decoder.id<InteractionInstructionId>(*id_value, pointer_child(pointer, "id"))
                  : std::nullopt;
    if (!kind || !id)
        return std::nullopt;
    if (*kind == "apply-effect") {
        decoder.object(value, pointer, {"effect", "id", "kind"});
        const auto* effect_value = decoder.member(value, "effect", pointer);
        auto effect = effect_value ? decode_effect_impl(decoder, *effect_value,
                                                        pointer_child(pointer, "effect"))
                                   : std::nullopt;
        return effect ? std::optional<InteractionInstruction>(
                            ApplyEffectInstruction{std::move(*id), std::move(*effect)})
                      : std::nullopt;
    }
    if (*kind == "move-interactable") {
        decoder.object(value, pointer, {"id", "interactable", "kind", "target"});
        const auto* interactable_value = decoder.member(value, "interactable", pointer);
        const auto* target_value = decoder.member(value, "target", pointer);
        auto interactable = interactable_value
                                ? decode_reference<InteractableId>(
                                      decoder, *interactable_value,
                                      pointer_child(pointer, "interactable"), "interactable")
                                : std::nullopt;
        auto target =
            target_value ? decode_location(decoder, *target_value, pointer_child(pointer, "target"))
                         : std::nullopt;
        return interactable && target
                   ? std::optional<InteractionInstruction>(MoveInteractableInstruction{
                         std::move(*id), std::move(*interactable), std::move(*target)})
                   : std::nullopt;
    }
    if (*kind == "set-interactable-state") {
        decoder.object(value, pointer, {"enabled", "id", "interactable", "kind", "visible"});
        const auto* interactable_value = decoder.member(value, "interactable", pointer);
        auto interactable = interactable_value
                                ? decode_reference<InteractableId>(
                                      decoder, *interactable_value,
                                      pointer_child(pointer, "interactable"), "interactable")
                                : std::nullopt;
        std::optional<bool> enabled;
        bool enabled_ok = true;
        if (const auto* field = json_access::member(value, "enabled")) {
            enabled = decoder.boolean(*field, pointer_child(pointer, "enabled"));
            enabled_ok = enabled.has_value();
        }
        std::optional<bool> visible;
        bool visible_ok = true;
        if (const auto* field = json_access::member(value, "visible")) {
            visible = decoder.boolean(*field, pointer_child(pointer, "visible"));
            visible_ok = visible.has_value();
        }
        return interactable && enabled_ok && visible_ok
                   ? std::optional<InteractionInstruction>(SetInteractableStateInstruction{
                         std::move(*id), std::move(*interactable), enabled, visible})
                   : std::nullopt;
    }
    if (*kind == "notify") {
        decoder.object(value, pointer, {"id", "kind", "message"});
        const auto* message_value = decoder.member(value, "message", pointer);
        auto message = message_value
                           ? decode_text(decoder, *message_value, pointer_child(pointer, "message"))
                           : std::nullopt;
        return message ? std::optional<InteractionInstruction>(
                             NotifyInstruction{std::move(*id), std::move(*message)})
                       : std::nullopt;
    }
    if (*kind == "call-scene") {
        decoder.object(value, pointer, {"id", "kind", "scene"});
        const auto* scene_value = decoder.member(value, "scene", pointer);
        auto scene = scene_value
                         ? decode_reference<SceneId>(decoder, *scene_value,
                                                     pointer_child(pointer, "scene"), "scene")
                         : std::nullopt;
        return scene ? std::optional<InteractionInstruction>(
                           CallSceneInteractionInstruction{std::move(*id), std::move(*scene)})
                     : std::nullopt;
    }
    if (*kind == "call-dialogue") {
        decoder.object(value, pointer, {"dialogue", "id", "kind"});
        const auto* dialogue_value = decoder.member(value, "dialogue", pointer);
        auto dialogue =
            dialogue_value
                ? decode_reference<DialogueId>(decoder, *dialogue_value,
                                               pointer_child(pointer, "dialogue"), "dialogue")
                : std::nullopt;
        return dialogue ? std::optional<InteractionInstruction>(CallDialogueInteractionInstruction{
                              std::move(*id), std::move(*dialogue)})
                        : std::nullopt;
    }
    decoder.object(value, pointer, {"id", "kind"});
    decoder.error(k_code_variant, "Unknown interaction instruction variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<InteractionProgram>
decode_interaction_program(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"completion", "instructions", "outcome"}))
        return std::nullopt;
    const auto* instructions_value = decoder.member(value, "instructions", pointer);
    const auto* completion_value = decoder.member(value, "completion", pointer);
    const auto* outcome_value = decoder.member(value, "outcome", pointer);
    auto instructions =
        instructions_value
            ? decoder.array<InteractionInstruction>(
                  *instructions_value, pointer_child(pointer, "instructions"),
                  [&](const nlohmann::json& instruction, const std::string& item_pointer) {
                      return decode_interaction_instruction(decoder, instruction, item_pointer);
                  })
            : std::nullopt;
    auto completion = completion_value
                          ? decode_flow_target_impl(decoder, *completion_value,
                                                    pointer_child(pointer, "completion"))
                          : std::nullopt;
    auto outcome = outcome_value ? decoder.enumeration<InteractionOutcome>(
                                       *outcome_value, pointer_child(pointer, "outcome"),
                                       {{"handled", InteractionOutcome::Handled},
                                        {"unhandled", InteractionOutcome::Unhandled}})
                                 : std::nullopt;
    if (!instructions || !completion || !outcome)
        return std::nullopt;
    decoder.duplicate_ids(
        *instructions, pointer_child(pointer, "instructions"),
        [](const InteractionInstruction& instruction) -> const InteractionInstructionId& {
            return std::visit(
                [](const auto& typed) -> const InteractionInstructionId& { return typed.id; },
                instruction);
        });
    return InteractionProgram{std::move(*instructions), std::move(*completion), *outcome};
}

std::optional<VerbDefinition> decode_verb(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"actionText", "arity", "availability", "defaultProgram", "extends", "id",
                         "operandRoles", "propertyAssignments", "quickAction"}))
        return std::nullopt;
    auto identity = decode_identity<VerbId>(decoder, value, pointer);
    const auto* action_value = decoder.member(value, "actionText", pointer);
    const auto* arity_value = decoder.member(value, "arity", pointer);
    const auto* availability_value = decoder.member(value, "availability", pointer);
    const auto* program_value = decoder.member(value, "defaultProgram", pointer);
    const auto* roles_value = decoder.member(value, "operandRoles", pointer);
    const auto* quick_value = decoder.member(value, "quickAction", pointer);
    auto action = action_value
                      ? decode_text(decoder, *action_value, pointer_child(pointer, "actionText"))
                      : std::nullopt;
    auto arity =
        arity_value
            ? decoder.unsigned_integer<std::uint8_t>(*arity_value, pointer_child(pointer, "arity"))
            : std::nullopt;
    if (arity && *arity > 2) {
        decoder.error(k_code_enum, "Verb arity must be 0, 1, or 2.",
                      pointer_child(pointer, "arity"));
        arity.reset();
    }
    auto roles = roles_value
                     ? decoder.array<std::string>(
                           *roles_value, pointer_child(pointer, "operandRoles"),
                           [&](const nlohmann::json& role, const std::string& item_pointer) {
                               return decoder.string(role, item_pointer, true);
                           })
                     : std::nullopt;
    if (roles && roles->size() > 2) {
        decoder.error(k_code_type, "At most two operand roles are allowed.",
                      pointer_child(pointer, "operandRoles"));
        roles.reset();
    }
    auto quick = quick_value ? decoder.boolean(*quick_value, pointer_child(pointer, "quickAction"))
                             : std::nullopt;
    auto availability = availability_value
                            ? decode_condition_impl(decoder, *availability_value,
                                                    pointer_child(pointer, "availability"))
                            : std::nullopt;
    auto program = program_value
                       ? decode_interaction_program(decoder, *program_value,
                                                    pointer_child(pointer, "defaultProgram"))
                       : std::nullopt;
    if (!identity || !action || !arity || !availability || !program || !roles || !quick)
        return std::nullopt;
    return VerbDefinition{
        std::move(*identity), std::move(*action), *arity, std::move(*availability),
        std::move(*program),  std::move(*roles),  *quick};
}

std::optional<InteractionDefinition>
decode_interaction(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"extends", "id", "propertyAssignments", "rules"}))
        return std::nullopt;
    auto identity = decode_identity<InteractionId>(decoder, value, pointer);
    const auto* rules_value = decoder.member(value, "rules", pointer);
    auto rules =
        rules_value
            ? decoder.array<InteractionRule>(
                  *rules_value, pointer_child(pointer, "rules"),
                  [&](const nlohmann::json& rule,
                      const std::string& rule_pointer) -> std::optional<InteractionRule> {
                      if (!decoder.object(rule, rule_pointer,
                                          {"context", "id", "operands", "program", "verb"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(rule, "id", rule_pointer);
                      const auto* verb_value = decoder.member(rule, "verb", rule_pointer);
                      const auto* context_value = decoder.member(rule, "context", rule_pointer);
                      const auto* operands_value = decoder.member(rule, "operands", rule_pointer);
                      const auto* program_value = decoder.member(rule, "program", rule_pointer);
                      auto id = id_value ? decoder.id<InteractionRuleId>(
                                               *id_value, pointer_child(rule_pointer, "id"))
                                         : std::nullopt;
                      auto verb = verb_value ? decode_reference<VerbId>(
                                                   decoder, *verb_value,
                                                   pointer_child(rule_pointer, "verb"), "verb")
                                             : std::nullopt;
                      std::optional<InteractionContext> context;
                      if (context_value && context_value->is_object()) {
                          const auto context_pointer = pointer_child(rule_pointer, "context");
                          const auto* kind_value =
                              decoder.member(*context_value, "kind", context_pointer);
                          auto kind = kind_value
                                          ? decoder.string(*kind_value,
                                                           pointer_child(context_pointer, "kind"))
                                          : std::nullopt;
                          if (kind && *kind == "any") {
                              decoder.object(*context_value, context_pointer, {"kind"});
                              context = AnyInteractionContext{};
                          } else if (kind && *kind == "active-room") {
                              decoder.object(*context_value, context_pointer, {"kind", "room"});
                              const auto* room_value =
                                  decoder.member(*context_value, "room", context_pointer);
                              auto room = room_value
                                              ? decode_reference<RoomId>(
                                                    decoder, *room_value,
                                                    pointer_child(context_pointer, "room"), "room")
                                              : std::nullopt;
                              if (room)
                                  context = ActiveRoomInteractionContext{std::move(*room)};
                          } else if (kind && *kind == "room-placement") {
                              decoder.object(*context_value, context_pointer,
                                             {"kind", "placement"});
                              const auto* placement_value =
                                  decoder.member(*context_value, "placement", context_pointer);
                              auto placement =
                                  placement_value ? decode_placement_ref(
                                                        decoder, *placement_value,
                                                        pointer_child(context_pointer, "placement"))
                                                  : std::nullopt;
                              if (placement)
                                  context = PlacementInteractionContext{std::move(*placement)};
                          } else if (kind && *kind == "predicate") {
                              decoder.object(*context_value, context_pointer,
                                             {"condition", "kind"});
                              const auto* condition_value =
                                  decoder.member(*context_value, "condition", context_pointer);
                              auto condition =
                                  condition_value ? decode_condition_impl(
                                                        decoder, *condition_value,
                                                        pointer_child(context_pointer, "condition"))
                                                  : std::nullopt;
                              if (condition)
                                  context = PredicateInteractionContext{std::move(*condition)};
                          } else if (kind) {
                              decoder.object(*context_value, context_pointer, {"kind"});
                              decoder.error(k_code_variant,
                                            "Unknown interaction context variant '" + *kind + "'.",
                                            pointer_child(context_pointer, "kind"));
                          }
                      } else if (context_value) {
                          decoder.error(k_code_type, "Expected an object.",
                                        pointer_child(rule_pointer, "context"));
                      }
                      auto operands =
                          operands_value
                              ? decoder.array<InteractionOperand>(
                                    *operands_value, pointer_child(rule_pointer, "operands"),
                                    [&](const nlohmann::json& operand,
                                        const std::string& operand_pointer)
                                        -> std::optional<InteractionOperand> {
                                        if (!operand.is_object()) {
                                            decoder.error(k_code_type,
                                                          "Expected an operand object.",
                                                          operand_pointer);
                                            return std::nullopt;
                                        }
                                        const auto* kind_value =
                                            decoder.member(operand, "kind", operand_pointer);
                                        auto kind =
                                            kind_value ? decoder.string(
                                                             *kind_value,
                                                             pointer_child(operand_pointer, "kind"))
                                                       : std::nullopt;
                                        if (kind && *kind == "any-interactable") {
                                            decoder.object(operand, operand_pointer, {"kind"});
                                            return InteractionOperand{AnyInteractableOperand{}};
                                        }
                                        if (kind && *kind == "exact") {
                                            decoder.object(operand, operand_pointer,
                                                           {"interactable", "kind"});
                                            const auto* interactable_value = decoder.member(
                                                operand, "interactable", operand_pointer);
                                            auto interactable =
                                                interactable_value
                                                    ? decode_reference<InteractableId>(
                                                          decoder, *interactable_value,
                                                          pointer_child(operand_pointer,
                                                                        "interactable"),
                                                          "interactable")
                                                    : std::nullopt;
                                            return interactable
                                                       ? std::optional<InteractionOperand>(
                                                             ExactOperand{std::move(*interactable)})
                                                       : std::nullopt;
                                        }
                                        if (kind) {
                                            decoder.object(operand, operand_pointer, {"kind"});
                                            decoder.error(k_code_variant,
                                                          "Unknown interaction operand variant '" +
                                                              *kind + "'.",
                                                          pointer_child(operand_pointer, "kind"));
                                        }
                                        return std::nullopt;
                                    })
                              : std::nullopt;
                      if (operands && operands->size() > 2) {
                          decoder.error(k_code_type, "At most two operands are allowed.",
                                        pointer_child(rule_pointer, "operands"));
                          operands.reset();
                      }
                      auto program =
                          program_value
                              ? decode_interaction_program(decoder, *program_value,
                                                           pointer_child(rule_pointer, "program"))
                              : std::nullopt;
                      if (id && verb && context && operands && program)
                          return InteractionRule{std::move(*id), std::move(*verb),
                                                 std::move(*context), std::move(*operands),
                                                 std::move(*program)};
                      return std::nullopt;
                  })
            : std::nullopt;
    if (rules)
        decoder.duplicate_ids(
            *rules, pointer_child(pointer, "rules"),
            [](const InteractionRule& rule) -> const InteractionRuleId& { return rule.id; });
    if (!identity || !rules)
        return std::nullopt;
    return InteractionDefinition{std::move(*identity), std::move(*rules)};
}

} // namespace noveltea::core::compiled::wire::detail
