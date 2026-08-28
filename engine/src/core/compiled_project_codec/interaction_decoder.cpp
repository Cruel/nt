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
                                ? decode_reference<InteractableInstanceId>(
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
                                ? decode_reference<InteractableInstanceId>(
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
                         "defaultProgram", "id", "offers", "slots"}))
        return std::nullopt;
    auto identity = decode_definition_identity<VerbId>(decoder, value, pointer);
    const auto* action_value = decoder.member(value, "actionText", pointer);
    const auto* completed_value = decoder.member(value, "completedCommandText", pointer);
    const auto* slots_value = decoder.member(value, "slots", pointer);
    const auto* binding_order_value = decoder.member(value, "bindingOrder", pointer);
    const auto* offers_value = decoder.member(value, "offers", pointer);
    const auto* availability_value = decoder.member(value, "availability", pointer);
    const auto* program_value = decoder.member(value, "defaultProgram", pointer);
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
    auto offers =
        offers_value
            ? decoder.array<VerbOffer>(
                  *offers_value, pointer_child(pointer, "offers"),
                  [&](const nlohmann::json& offer,
                      const std::string& offer_pointer) -> std::optional<VerbOffer> {
                      if (!decoder.object(
                              offer, offer_pointer,
                              {"condition", "id", "primary", "rank", "selectors", "slotId"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(offer, "id", offer_pointer);
                      const auto* slot_value = decoder.member(offer, "slotId", offer_pointer);
                      const auto* selectors_value =
                          decoder.member(offer, "selectors", offer_pointer);
                      const auto* rank_value = decoder.member(offer, "rank", offer_pointer);
                      const auto* primary_value = decoder.member(offer, "primary", offer_pointer);
                      auto id = id_value ? decoder.id<VerbOfferId>(
                                               *id_value, pointer_child(offer_pointer, "id"))
                                         : std::nullopt;
                      auto slot = slot_value
                                      ? decoder.id<VerbSlotId>(
                                            *slot_value, pointer_child(offer_pointer, "slotId"))
                                      : std::nullopt;
                      auto selectors =
                          selectors_value
                              ? decode_subject_selectors(decoder, *selectors_value,
                                                         pointer_child(offer_pointer, "selectors"))
                              : std::nullopt;
                      auto rank =
                          rank_value ? json_access::get<std::int64_t>(*rank_value) : std::nullopt;
                      if (rank_value && !rank)
                          decoder.error(k_code_type, "Expected an integer.",
                                        pointer_child(offer_pointer, "rank"));
                      auto primary = primary_value
                                         ? decoder.boolean(*primary_value,
                                                           pointer_child(offer_pointer, "primary"))
                                         : std::nullopt;
                      bool condition_valid = false;
                      auto condition =
                          decode_optional_condition(decoder, offer, offer_pointer, condition_valid);
                      return id && slot && selectors && rank && primary && condition_valid
                                 ? std::optional<VerbOffer>(VerbOffer{
                                       std::move(*id), std::move(*slot), std::move(*selectors),
                                       std::move(condition), *rank, *primary})
                                 : std::nullopt;
                  })
            : std::nullopt;
    if (offers)
        decoder.duplicate_ids(
            *offers, pointer_child(pointer, "offers"),
            [](const VerbOffer& offer) -> const VerbOfferId& { return offer.id; });
    auto availability = availability_value
                            ? decode_condition_impl(decoder, *availability_value,
                                                    pointer_child(pointer, "availability"))
                            : std::nullopt;
    auto program = program_value
                       ? decode_interaction_program(decoder, *program_value,
                                                    pointer_child(pointer, "defaultProgram"))
                       : std::nullopt;
    if (!identity || !action || !completed || !slots || !binding_order || !offers ||
        !availability || !program)
        return std::nullopt;
    return VerbDefinition{std::move(*identity),      std::move(*action),
                          std::move(*completed),     std::move(*slots),
                          std::move(*binding_order), std::move(*offers),
                          std::move(*availability),  std::move(*program)};
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
                      if (!decoder.object(
                              rule, rule_pointer,
                              {"guard", "id", "offer", "priority", "program", "slots", "verb"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(rule, "id", rule_pointer);
                      const auto* verb_value = decoder.member(rule, "verb", rule_pointer);
                      const auto* guard_value = decoder.member(rule, "guard", rule_pointer);
                      const auto* priority_value = decoder.member(rule, "priority", rule_pointer);
                      const auto* slots_value = decoder.member(rule, "slots", rule_pointer);
                      const auto* offer_value = decoder.member(rule, "offer", rule_pointer);
                      const auto* program_value = decoder.member(rule, "program", rule_pointer);
                      auto id = id_value ? decoder.id<InteractionRuleId>(
                                               *id_value, pointer_child(rule_pointer, "id"))
                                         : std::nullopt;
                      auto verb = verb_value ? decode_reference<VerbId>(
                                                   decoder, *verb_value,
                                                   pointer_child(rule_pointer, "verb"), "verb")
                                             : std::nullopt;
                      auto guard = guard_value
                                       ? decode_condition_impl(decoder, *guard_value,
                                                               pointer_child(rule_pointer, "guard"))
                                       : std::nullopt;
                      auto priority = priority_value
                                          ? json_access::get<std::int64_t>(*priority_value)
                                          : std::nullopt;
                      if (priority_value && !priority)
                          decoder.error(k_code_type, "Expected an integer.",
                                        pointer_child(rule_pointer, "priority"));
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
                      std::optional<InteractionOffer> offer;
                      bool offer_valid = offer_value != nullptr;
                      if (offer_value && !offer_value->is_null()) {
                          const auto offer_pointer = pointer_child(rule_pointer, "offer");
                          if (!decoder.object(*offer_value, offer_pointer,
                                              {"condition", "primary", "rank", "slotId"})) {
                              offer_valid = false;
                          } else {
                              const auto* slot_value =
                                  decoder.member(*offer_value, "slotId", offer_pointer);
                              const auto* rank_value =
                                  decoder.member(*offer_value, "rank", offer_pointer);
                              const auto* primary_value =
                                  decoder.member(*offer_value, "primary", offer_pointer);
                              auto slot = slot_value ? decoder.id<VerbSlotId>(
                                                           *slot_value,
                                                           pointer_child(offer_pointer, "slotId"))
                                                     : std::nullopt;
                              auto rank = rank_value ? json_access::get<std::int64_t>(*rank_value)
                                                     : std::nullopt;
                              if (rank_value && !rank)
                                  decoder.error(k_code_type, "Expected an integer.",
                                                pointer_child(offer_pointer, "rank"));
                              auto primary =
                                  primary_value
                                      ? decoder.boolean(*primary_value,
                                                        pointer_child(offer_pointer, "primary"))
                                      : std::nullopt;
                              bool condition_valid = false;
                              auto condition = decode_optional_condition(
                                  decoder, *offer_value, offer_pointer, condition_valid);
                              offer_valid = slot && rank && primary && condition_valid;
                              if (offer_valid)
                                  offer = InteractionOffer{std::move(*slot), std::move(condition),
                                                           *rank, *primary};
                          }
                      }
                      auto program =
                          program_value
                              ? decode_interaction_program(decoder, *program_value,
                                                           pointer_child(rule_pointer, "program"))
                              : std::nullopt;
                      if (id && verb && guard && priority && slots && offer_valid && program)
                          return InteractionRule{std::move(*id),     std::move(*verb),
                                                 std::move(*slots),  std::move(offer),
                                                 std::move(*guard),  *priority,
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
