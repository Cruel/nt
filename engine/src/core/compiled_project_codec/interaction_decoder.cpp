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

std::optional<SubjectFamily> decode_subject_family(Decoder& decoder, const nlohmann::json& value,
                                                   std::string_view pointer)
{
    return decoder.enumeration<SubjectFamily>(value, pointer,
                                              {{"character", SubjectFamily::Character},
                                               {"interactable", SubjectFamily::Interactable},
                                               {"feature", SubjectFamily::Feature},
                                               {"item-stack", SubjectFamily::ItemStack}});
}

std::optional<SubjectSelector>
decode_subject_selector(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!value.is_object()) {
        decoder.error(k_code_type, "Expected a Subject Selector object.", std::string(pointer));
        return std::nullopt;
    }
    const auto* kind_value = decoder.member(value, "kind", pointer);
    auto kind =
        kind_value ? decoder.string(*kind_value, pointer_child(pointer, "kind")) : std::nullopt;
    if (!kind)
        return std::nullopt;
    if (*kind == "any-subject") {
        decoder.object(value, pointer, {"kind"});
        return SubjectSelector{AnySubjectSelector{}};
    }
    if (*kind == "family") {
        decoder.object(value, pointer, {"family", "kind"});
        const auto* family_value = decoder.member(value, "family", pointer);
        auto family = family_value ? decode_subject_family(decoder, *family_value,
                                                           pointer_child(pointer, "family"))
                                   : std::nullopt;
        return family ? std::optional<SubjectSelector>(FamilySubjectSelector{*family})
                      : std::nullopt;
    }
    if (*kind == "trait") {
        decoder.object(value, pointer, {"kind", "trait"});
        const auto* trait_value = decoder.member(value, "trait", pointer);
        auto trait = trait_value
                         ? decode_reference<TraitId>(decoder, *trait_value,
                                                     pointer_child(pointer, "trait"), "trait")
                         : std::nullopt;
        return trait ? std::optional<SubjectSelector>(TraitSubjectSelector{std::move(*trait)})
                     : std::nullopt;
    }
    if (*kind == "item-definition") {
        decoder.object(value, pointer, {"itemDefinition", "kind"});
        const auto* definition_value = decoder.member(value, "itemDefinition", pointer);
        auto definition = definition_value
                              ? decode_reference<ItemDefinitionId>(
                                    decoder, *definition_value,
                                    pointer_child(pointer, "itemDefinition"), "item-definition")
                              : std::nullopt;
        return definition ? std::optional<SubjectSelector>(
                                ItemDefinitionSubjectSelector{std::move(*definition)})
                          : std::nullopt;
    }
    if (*kind == "qualified-pattern") {
        decoder.object(value, pointer, {"family", "kind", "pattern"});
        const auto* family_value = decoder.member(value, "family", pointer);
        const auto* pattern_value = decoder.member(value, "pattern", pointer);
        auto family = family_value ? decode_subject_family(decoder, *family_value,
                                                           pointer_child(pointer, "family"))
                                   : std::nullopt;
        auto pattern = pattern_value
                           ? decoder.string(*pattern_value, pointer_child(pointer, "pattern"), true)
                           : std::nullopt;
        if (pattern && (pattern->size() < 2 || pattern->back() != '*' ||
                        pattern->substr(0, pattern->size() - 1).find('*') != std::string::npos)) {
            decoder.error(
                k_code_type,
                "Qualified Subject Selector patterns require exactly one trailing wildcard.",
                pointer_child(pointer, "pattern"));
            pattern.reset();
        }
        return family && pattern ? std::optional<SubjectSelector>(QualifiedPatternSubjectSelector{
                                       *family, std::move(*pattern)})
                                 : std::nullopt;
    }
    if (*kind == "exact") {
        decoder.object(value, pointer, {"kind", "subject"});
        const auto* subject_value = decoder.member(value, "subject", pointer);
        auto subject = subject_value ? decode_interaction_subject(decoder, *subject_value,
                                                                  pointer_child(pointer, "subject"))
                                     : std::nullopt;
        return subject ? std::optional<SubjectSelector>(ExactSubjectSelector{std::move(*subject)})
                       : std::nullopt;
    }
    decoder.object(value, pointer, {"kind"});
    decoder.error(k_code_variant, "Unknown Subject Selector variant '" + *kind + "'.",
                  pointer_child(pointer, "kind"));
    return std::nullopt;
}

std::optional<std::vector<SubjectSelector>>
decode_subject_selectors(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    auto selectors = decoder.array<SubjectSelector>(
        value, pointer, [&](const nlohmann::json& selector, const std::string& selector_pointer) {
            return decode_subject_selector(decoder, selector, selector_pointer);
        });
    if (selectors && selectors->empty()) {
        decoder.error(k_code_type, "At least one Subject Selector is required.",
                      std::string(pointer));
        selectors.reset();
    }
    return selectors;
}

std::optional<VerbDefinition> decode_verb(Decoder& decoder, const nlohmann::json& value,
                                          std::string_view pointer)
{
    if (!decoder.object(value, pointer,
                        {"actionText", "availability", "bindingOrder", "completedCommandText",
                         "defaultProgram", "id", "quickAction", "slots"}))
        return std::nullopt;
    auto identity = decode_definition_identity<VerbId>(decoder, value, pointer);
    const auto* action_value = decoder.member(value, "actionText", pointer);
    const auto* completed_value = decoder.member(value, "completedCommandText", pointer);
    const auto* slots_value = decoder.member(value, "slots", pointer);
    const auto* binding_order_value = decoder.member(value, "bindingOrder", pointer);
    const auto* availability_value = decoder.member(value, "availability", pointer);
    const auto* program_value = decoder.member(value, "defaultProgram", pointer);
    const auto* quick_value = decoder.member(value, "quickAction", pointer);
    auto action = action_value
                      ? decode_text(decoder, *action_value, pointer_child(pointer, "actionText"))
                      : std::nullopt;
    auto completed = completed_value ? decode_text(decoder, *completed_value,
                                                   pointer_child(pointer, "completedCommandText"))
                                     : std::nullopt;
    auto slots =
        slots_value
            ? decoder.array<VerbSlot>(
                  *slots_value, pointer_child(pointer, "slots"),
                  [&](const nlohmann::json& slot,
                      const std::string& slot_pointer) -> std::optional<VerbSlot> {
                      if (!decoder.object(slot, slot_pointer,
                                          {"id", "label", "prompt", "selectors"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(slot, "id", slot_pointer);
                      const auto* label_value = decoder.member(slot, "label", slot_pointer);
                      const auto* prompt_value = decoder.member(slot, "prompt", slot_pointer);
                      const auto* selectors_value = decoder.member(slot, "selectors", slot_pointer);
                      auto slot_id =
                          id_value
                              ? decoder.id<VerbSlotId>(*id_value, pointer_child(slot_pointer, "id"))
                              : std::nullopt;
                      auto label = label_value ? decode_text(decoder, *label_value,
                                                             pointer_child(slot_pointer, "label"))
                                               : std::nullopt;
                      auto prompt = prompt_value
                                        ? decode_text(decoder, *prompt_value,
                                                      pointer_child(slot_pointer, "prompt"))
                                        : std::nullopt;
                      auto selectors =
                          selectors_value
                              ? decode_subject_selectors(decoder, *selectors_value,
                                                         pointer_child(slot_pointer, "selectors"))
                              : std::nullopt;
                      return slot_id && label && prompt && selectors
                                 ? std::optional<VerbSlot>(
                                       VerbSlot{std::move(*slot_id), std::move(*label),
                                                std::move(*prompt), std::move(*selectors)})
                                 : std::nullopt;
                  })
            : std::nullopt;
    if (slots)
        decoder.duplicate_ids(*slots, pointer_child(pointer, "slots"),
                              [](const VerbSlot& slot) -> const VerbSlotId& { return slot.id; });
    auto binding_order =
        binding_order_value ? decoder.array<VerbSlotId>(
                                  *binding_order_value, pointer_child(pointer, "bindingOrder"),
                                  [&](const nlohmann::json& item, const std::string& item_pointer) {
                                      return decoder.id<VerbSlotId>(item, item_pointer);
                                  })
                            : std::nullopt;
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
    if (!identity || !action || !completed || !slots || !binding_order || !availability ||
        !program || !quick)
        return std::nullopt;
    return VerbDefinition{std::move(*identity),      std::move(*action),
                          std::move(*completed),     std::move(*slots),
                          std::move(*binding_order), std::move(*availability),
                          std::move(*program),       *quick};
}

std::optional<InteractionDefinition>
decode_interaction(Decoder& decoder, const nlohmann::json& value, std::string_view pointer)
{
    if (!decoder.object(value, pointer, {"id", "rules"}))
        return std::nullopt;
    auto identity = decode_definition_identity<InteractionId>(decoder, value, pointer);
    const auto* rules_value = decoder.member(value, "rules", pointer);
    auto rules =
        rules_value
            ? decoder.array<InteractionRule>(
                  *rules_value, pointer_child(pointer, "rules"),
                  [&](const nlohmann::json& rule,
                      const std::string& rule_pointer) -> std::optional<InteractionRule> {
                      if (!decoder.object(rule, rule_pointer,
                                          {"context", "id", "program", "slots", "verb"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(rule, "id", rule_pointer);
                      const auto* verb_value = decoder.member(rule, "verb", rule_pointer);
                      const auto* context_value = decoder.member(rule, "context", rule_pointer);
                      const auto* slots_value = decoder.member(rule, "slots", rule_pointer);
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
                      auto slots =
                          slots_value
                              ? decoder.array<InteractionSlotSelector>(
                                    *slots_value, pointer_child(rule_pointer, "slots"),
                                    [&](const nlohmann::json& slot, const std::string& slot_pointer)
                                        -> std::optional<InteractionSlotSelector> {
                                        if (!decoder.object(slot, slot_pointer,
                                                            {"selectors", "slotId"}))
                                            return std::nullopt;
                                        const auto* slot_id_value =
                                            decoder.member(slot, "slotId", slot_pointer);
                                        const auto* selectors_value =
                                            decoder.member(slot, "selectors", slot_pointer);
                                        auto slot_id =
                                            slot_id_value
                                                ? decoder.id<VerbSlotId>(
                                                      *slot_id_value,
                                                      pointer_child(slot_pointer, "slotId"))
                                                : std::nullopt;
                                        auto selectors =
                                            selectors_value
                                                ? decode_subject_selectors(
                                                      decoder, *selectors_value,
                                                      pointer_child(slot_pointer, "selectors"))
                                                : std::nullopt;
                                        return slot_id && selectors
                                                   ? std::optional<InteractionSlotSelector>(
                                                         InteractionSlotSelector{
                                                             std::move(*slot_id),
                                                             std::move(*selectors)})
                                                   : std::nullopt;
                                    })
                              : std::nullopt;
                      auto program =
                          program_value
                              ? decode_interaction_program(decoder, *program_value,
                                                           pointer_child(rule_pointer, "program"))
                              : std::nullopt;
                      if (id && verb && context && slots && program)
                          return InteractionRule{std::move(*id), std::move(*verb),
                                                 std::move(*context), std::move(*slots),
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
