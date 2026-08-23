#include "noveltea/runtime/runtime_executor.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace noveltea::runtime {
namespace {

core::Diagnostics interaction_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

const core::compiled::InteractionProgram* program_for(const core::CompiledProject& project,
                                                      const core::InteractionProgramRef& reference)
{
    return std::visit(
        [&project](const auto& value) -> const core::compiled::InteractionProgram* {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::InteractionRuleProgramRef>) {
                const auto* interaction = project.find_interaction(value.interaction);
                if (interaction == nullptr)
                    return nullptr;
                const auto found =
                    std::find_if(interaction->rules.begin(), interaction->rules.end(),
                                 [&value](const core::compiled::InteractionRule& rule) {
                                     return rule.id == value.rule;
                                 });
                return found == interaction->rules.end() ? nullptr : &found->program;
            } else {
                const auto* verb = project.find_verb(value.verb);
                return verb == nullptr ? nullptr : &verb->default_program;
            }
        },
        reference);
}

std::optional<core::InteractionInstructionId>
first_instruction(const core::compiled::InteractionProgram& program)
{
    if (program.instructions.empty())
        return std::nullopt;
    return std::visit([](const auto& value) { return value.id; }, program.instructions.front());
}

const core::compiled::InteractionInstruction*
find_instruction(const core::compiled::InteractionProgram& program,
                 const core::InteractionInstructionId& id)
{
    const auto found = std::find_if(
        program.instructions.begin(), program.instructions.end(),
        [&id](const core::compiled::InteractionInstruction& instruction) {
            return std::visit([&id](const auto& value) { return value.id == id; }, instruction);
        });
    return found == program.instructions.end() ? nullptr : &*found;
}

std::optional<core::InteractionInstructionId>
next_instruction(const core::compiled::InteractionProgram& program,
                 const core::InteractionInstructionId& id)
{
    for (std::size_t index = 0; index < program.instructions.size(); ++index) {
        const bool found = std::visit([&id](const auto& value) { return value.id == id; },
                                      program.instructions[index]);
        if (!found)
            continue;
        if (index + 1 == program.instructions.size())
            return std::nullopt;
        return std::visit([](const auto& value) { return value.id; },
                          program.instructions[index + 1]);
    }
    return std::nullopt;
}

} // namespace

core::Result<void, RuntimeExecutionError>
RuntimeExecutor::interact(core::VerbId verb_id,
                          std::vector<core::InteractionSubjectBinding> bindings)
{
    const auto* room_mode = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* verb = m_project.find_verb(verb_id);
    if (room_mode == nullptr || verb == nullptr || !m_state.flow_stack().empty())
        return core::Result<void, RuntimeExecutionError>::failure(
            interaction_error("execution.invalid_interaction_invocation",
                              "Interaction requires Room mode and a valid Verb"));

    if (!m_room_presentation || m_room_presentation_dirty ||
        m_room_presentation->presentation.visit.room != room_mode->room) {
        auto settled = room_view({});
        if (!settled)
            return core::Result<void, RuntimeExecutionError>::failure(settled.error());
    }

    auto subject_family = [](const core::compiled::InteractionSubject& subject) {
        if (std::holds_alternative<core::compiled::CharacterInteractionSubject>(subject))
            return core::compiled::SubjectFamily::Character;
        if (std::holds_alternative<core::compiled::InteractableInteractionSubject>(subject))
            return core::compiled::SubjectFamily::Interactable;
        if (std::holds_alternative<core::compiled::FeatureInteractionSubject>(subject))
            return core::compiled::SubjectFamily::Feature;
        return core::compiled::SubjectFamily::ItemStack;
    };
    auto subject_identity = [](const core::compiled::InteractionSubject& subject) {
        return std::visit(
            [](const auto& value) -> std::string {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>)
                    return std::string("character:") + value.character.text();
                else if constexpr (std::is_same_v<T,
                                                  core::compiled::InteractableInteractionSubject>)
                    return std::string("interactable:") + value.interactable.text();
                else if constexpr (std::is_same_v<T, core::compiled::ItemStackInteractionSubject>)
                    return std::string("item-stack:") + value.item_stack.text();
                else
                    return std::visit(
                        [](const auto& feature) {
                            using F = std::decay_t<decltype(feature)>;
                            if constexpr (std::is_same_v<F, core::RoomFeatureRef>)
                                return std::string("room:") + feature.room.text() + "#" +
                                       feature.feature_id.text();
                            else
                                return std::string("interactable:") + feature.interactable.text() +
                                       "#" + feature.feature_id.text();
                        },
                        value.feature);
            },
            subject);
    };
    auto has_trait = [this](const core::compiled::InteractionSubject& subject,
                            const core::TraitId& trait) {
        const auto* traits = std::visit(
            [this](const auto& value) -> const std::vector<core::TraitId>* {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>) {
                    const auto* config = m_world.resolved_configuration(value.character);
                    return config ? &config->identity.traits : nullptr;
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::InteractableInteractionSubject>) {
                    const auto* config = m_world.resolved_configuration(value.interactable);
                    return config ? &config->identity.traits : nullptr;
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::ItemStackInteractionSubject>) {
                    const auto* stack = m_world.item_stack(value.item_stack);
                    return stack ? &stack->traits : nullptr;
                } else {
                    return std::visit(
                        [this](const auto& feature) -> const std::vector<core::TraitId>* {
                            const auto* owner = m_world.resolved_configuration([&]() {
                                if constexpr (std::is_same_v<std::decay_t<decltype(feature)>,
                                                             core::RoomFeatureRef>)
                                    return feature.room;
                                else
                                    return feature.interactable;
                            }());
                            if (!owner)
                                return nullptr;
                            const auto found =
                                std::find_if(owner->features.begin(), owner->features.end(),
                                             [&](const auto& item) {
                                                 return item.identity.id == feature.feature_id;
                                             });
                            return found == owner->features.end() ? nullptr
                                                                  : &found->identity.traits;
                        },
                        value.feature);
                }
            },
            subject);
        return traits && std::find(traits->begin(), traits->end(), trait) != traits->end();
    };
    auto selector_matches = [&](const core::compiled::SubjectSelector& selector,
                                const core::compiled::InteractionSubject& subject) {
        return std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::AnySubjectSelector>)
                    return true;
                else if constexpr (std::is_same_v<T, core::compiled::FamilySubjectSelector>)
                    return value.family == subject_family(subject);
                else if constexpr (std::is_same_v<T, core::compiled::TraitSubjectSelector>)
                    return has_trait(subject, value.trait);
                else if constexpr (std::is_same_v<T,
                                                  core::compiled::ItemDefinitionSubjectSelector>) {
                    const auto* stack =
                        std::get_if<core::compiled::ItemStackInteractionSubject>(&subject);
                    const auto* state = stack ? m_world.item_stack(stack->item_stack) : nullptr;
                    return state && state->definition == value.item_definition;
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::QualifiedPatternSubjectSelector>) {
                    if (value.family != subject_family(subject))
                        return false;
                    const auto identity = subject_identity(subject);
                    const auto prefix = value.pattern.substr(0, value.pattern.size() - 1);
                    return identity.starts_with(prefix);
                } else
                    return value.subject == subject;
            },
            selector);
    };
    auto selector_union_matches = [&](const std::vector<core::compiled::SubjectSelector>& selectors,
                                      const core::compiled::InteractionSubject& subject) {
        return std::any_of(selectors.begin(), selectors.end(), [&](const auto& selector) {
            return selector_matches(selector, subject);
        });
    };

    if (bindings.size() != verb->slots.size())
        return core::Result<void, RuntimeExecutionError>::failure(
            interaction_error("execution.invalid_interaction_bindings",
                              "Interaction must bind every named Verb slot exactly once"));
    std::vector<core::VerbSlotId> seen_slots;
    for (const auto& binding : bindings) {
        const auto slot =
            std::find_if(verb->slots.begin(), verb->slots.end(),
                         [&](const auto& item) { return item.id == binding.slot_id; });
        if (slot == verb->slots.end() ||
            std::find(seen_slots.begin(), seen_slots.end(), binding.slot_id) != seen_slots.end() ||
            !selector_union_matches(slot->selectors, binding.subject))
            return core::Result<void, RuntimeExecutionError>::failure(
                interaction_error("execution.invalid_interaction_bindings",
                                  "Interaction binding does not satisfy the named Verb slot"));
        seen_slots.push_back(binding.slot_id);
        if (std::find(m_room_presentation->eligible_subjects.begin(),
                      m_room_presentation->eligible_subjects.end(),
                      binding.subject) == m_room_presentation->eligible_subjects.end())
            return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
                "execution.interaction_subject_unavailable",
                "Interaction subject is not eligible in the active Room resolution"));
    }

    auto available = evaluate(verb->availability);
    const auto* availability_value = available.value_if();
    if (availability_value == nullptr)
        return core::Result<void, RuntimeExecutionError>::failure(available.error());
    if (!*availability_value)
        return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
            "execution.verb_unavailable", "Verb availability rejected the interaction"));

    struct Candidate {
        core::InteractionRuleProgramRef reference;
        std::size_t exact_selectors = 0;
        std::size_t constrained_selectors = 0;
        std::size_t declaration_order = 0;
    };
    std::optional<Candidate> selected;
    std::size_t order = 0;
    for (const auto& interaction : m_project.interactions()) {
        for (const auto& rule : interaction.rules) {
            const auto current_order = order++;
            if (rule.verb != verb_id || rule.slots.size() != bindings.size())
                continue;
            std::size_t exact = 0;
            std::size_t constrained = 0;
            bool matches = true;
            for (const auto& rule_slot : rule.slots) {
                const auto binding =
                    std::find_if(bindings.begin(), bindings.end(), [&](const auto& item) {
                        return item.slot_id == rule_slot.slot_id;
                    });
                if (binding == bindings.end() ||
                    !selector_union_matches(rule_slot.selectors, binding->subject)) {
                    matches = false;
                    break;
                }
                if (std::any_of(
                        rule_slot.selectors.begin(), rule_slot.selectors.end(),
                        [](const auto& selector) {
                            return std::holds_alternative<core::compiled::ExactSubjectSelector>(
                                selector);
                        }))
                    ++exact;
                if (std::any_of(
                        rule_slot.selectors.begin(), rule_slot.selectors.end(),
                        [](const auto& selector) {
                            return !std::holds_alternative<core::compiled::AnySubjectSelector>(
                                selector);
                        }))
                    ++constrained;
            }
            if (!matches)
                continue;
            bool context_matches = std::visit(
                [this, &room_mode, &bindings](const auto& context) {
                    using T = std::decay_t<decltype(context)>;
                    if constexpr (std::is_same_v<T, core::compiled::AnyInteractionContext>)
                        return true;
                    else if constexpr (std::is_same_v<T,
                                                      core::compiled::ActiveRoomInteractionContext>)
                        return context.room == room_mode->room;
                    else if constexpr (std::is_same_v<
                                           T, core::compiled::PlacementInteractionContext>) {
                        return std::any_of(
                            bindings.begin(), bindings.end(),
                            [this, &context](const auto& binding) {
                                const auto& subject = binding.subject;
                                if (context.placement.room !=
                                    m_room_presentation->presentation.visit.room)
                                    return false;
                                if (const auto* character =
                                        std::get_if<core::compiled::CharacterInteractionSubject>(
                                            &subject))
                                    return std::any_of(
                                        m_room_presentation->presentation.actors.begin(),
                                        m_room_presentation->presentation.actors.end(),
                                        [&context,
                                         character](const core::ResolvedRoomActor& actor) {
                                            return actor.character == character->character &&
                                                   actor.placement ==
                                                       context.placement.placement_id;
                                        });
                                std::optional<core::InteractableId> interactable_id;
                                if (const auto* interactable =
                                        std::get_if<core::compiled::InteractableInteractionSubject>(
                                            &subject))
                                    interactable_id = interactable->interactable;
                                else if (const auto* feature =
                                             std::get_if<core::compiled::FeatureInteractionSubject>(
                                                 &subject)) {
                                    const auto* owner = std::get_if<core::InteractableFeatureRef>(
                                        &feature->feature);
                                    if (!owner)
                                        return false;
                                    interactable_id = owner->interactable;
                                } else
                                    return false;
                                return std::any_of(
                                    m_room_presentation->presentation.interactables.begin(),
                                    m_room_presentation->presentation.interactables.end(),
                                    [&context, &interactable_id](const auto& value) {
                                        return value.interactable == *interactable_id &&
                                               value.placement == context.placement.placement_id;
                                    });
                            });
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::PredicateInteractionContext>) {
                        auto evaluated = evaluate(context.condition);
                        const auto* value = evaluated.value_if();
                        return value != nullptr && *value;
                    } else
                        return false;
                },
                rule.context);
            if (!context_matches)
                continue;
            Candidate candidate{
                {interaction.identity.id, rule.id}, exact, constrained, current_order};
            if (!selected || candidate.exact_selectors > selected->exact_selectors ||
                (candidate.exact_selectors == selected->exact_selectors &&
                 candidate.constrained_selectors > selected->constrained_selectors) ||
                (candidate.exact_selectors == selected->exact_selectors &&
                 candidate.constrained_selectors == selected->constrained_selectors &&
                 candidate.declaration_order < selected->declaration_order))
                selected = std::move(candidate);
        }
    }

    const core::InteractionProgramRef program =
        selected ? core::InteractionProgramRef{selected->reference}
                 : core::InteractionProgramRef{core::VerbDefaultProgramRef{verb_id}};
    auto started = m_flow.start_interaction(
        core::InteractionInvocationContext{verb_id, room_mode->room, std::move(bindings)}, program);
    return started ? core::Result<void, RuntimeExecutionError>::success()
                   : core::Result<void, RuntimeExecutionError>::failure(started.error());
}

std::optional<core::FlowRunOutcome>
RuntimeExecutor::run_interaction_unit(std::string_view runtime_locale)
{
    auto fault = [this](core::Diagnostics diagnostics) -> core::FlowRunOutcome {
        const auto copy = diagnostics;
        (void)m_flow.fault(std::move(diagnostics));
        return core::FlowFaultOutcome{copy};
    };
    const auto* frame = std::get_if<core::InteractionFrame>(&m_state.flow_stack().back());
    if (frame == nullptr)
        return fault(
            interaction_error("execution.invalid_interaction", "Interaction frame is missing"));
    const auto expected = frame->position;
    const auto* program = program_for(m_project, frame->program);
    if (program == nullptr)
        return fault(interaction_error("execution.invalid_interaction_program",
                                       "Interaction program is missing"));

    if (expected.awaiting_completion) {
        auto next = expected;
        next.awaiting_completion = false;
        next.next_instruction = expected.next_instruction
                                    ? next_instruction(*program, *expected.next_instruction)
                                    : std::nullopt;
        auto advanced = m_flow.advance_interaction(expected, frame->program, next);
        if (!advanced)
            return fault(advanced.error());
        return std::nullopt;
    }

    if (!expected.next_instruction) {
        const auto outcome = program->outcome == core::compiled::InteractionOutcome::Handled
                                 ? core::InteractionExecutionOutcome::Handled
                                 : core::InteractionExecutionOutcome::Unhandled;
        if (outcome == core::InteractionExecutionOutcome::Handled) {
            auto applied = m_flow.apply_target(program->completion);
            if (!applied)
                return fault(applied.error());
            return std::nullopt;
        }

        if (std::get_if<core::VerbDefaultProgramRef>(&frame->program) == nullptr) {
            core::InteractionProgramRef next_program =
                core::VerbDefaultProgramRef{frame->invocation.verb};
            const auto* next_definition = program_for(m_project, next_program);
            if (next_definition == nullptr)
                return fault(interaction_error("execution.invalid_interaction_program",
                                               "Verb default program is missing"));
            auto next = core::InteractionFramePosition{
                first_instruction(*next_definition), core::InteractionFallbackStage::VerbDefault,
                core::InteractionExecutionOutcome::Pending, false};
            auto advanced = m_flow.advance_interaction(expected, std::move(next_program), next);
            if (!advanced)
                return fault(advanced.error());
            return std::nullopt;
        }

        auto requested = m_gateway.request_notification("Nothing happens.");
        if (!requested)
            return fault(requested.error());
        auto returned = m_flow.return_from_flow();
        if (!returned)
            return fault(returned.error());
        return std::nullopt;
    }

    const auto instruction_id = *expected.next_instruction;
    const auto* instruction = find_instruction(*program, instruction_id);
    if (instruction == nullptr)
        return fault(interaction_error("execution.invalid_interaction_instruction",
                                       "Interaction instruction is missing"));
    const auto sequential = next_instruction(*program, instruction_id);
    return std::visit(
        [this, &fault, &expected, &frame, &sequential,
         runtime_locale](const auto& value) -> std::optional<core::FlowRunOutcome> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::compiled::ApplyEffectInstruction>) {
                auto applied = apply(value.effect, "typed-interaction-effect");
                const auto* outcome = applied.value_if();
                if (outcome == nullptr) {
                    if (const auto* script = std::get_if<ScriptInvocationError>(&applied.error()))
                        return fault(interaction_error("execution.interaction_script_failed",
                                                       script->message));
                    return fault(std::get<core::Diagnostics>(applied.error()));
                }
                auto next = expected;
                if (std::holds_alternative<ScriptInvocationSuspended>(*outcome)) {
                    next.awaiting_completion = true;
                    auto marked = m_flow.mark_interaction_wait(expected, next);
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowBlockedOutcome{*m_state.blocker()};
                }
                next.next_instruction = sequential;
                auto advanced = m_flow.advance_interaction(expected, frame->program, next);
                return advanced ? std::nullopt
                                : std::optional<core::FlowRunOutcome>{fault(advanced.error())};
            } else if constexpr (std::is_same_v<T, core::compiled::MoveInteractableInstruction>) {
                auto moved = m_world.move_interactable(value.interactable, value.target);
                if (!moved)
                    return fault(moved.error());
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::SetInteractableStateInstruction>) {
                if (value.enabled) {
                    auto changed =
                        m_world.set_interactable_enabled(value.interactable, *value.enabled);
                    if (!changed)
                        return fault(changed.error());
                }
                if (value.visible) {
                    auto changed =
                        m_world.set_interactable_visible(value.interactable, *value.visible);
                    if (!changed)
                        return fault(changed.error());
                }
            } else if constexpr (std::is_same_v<T, core::compiled::NotifyInstruction>) {
                auto message = resolve(value.message.source, runtime_locale);
                const auto* text = message.value_if();
                if (text == nullptr) {
                    if (const auto* script = std::get_if<ScriptInvocationError>(&message.error()))
                        return fault(interaction_error("execution.interaction_text_failed",
                                                       script->message));
                    return fault(std::get<core::Diagnostics>(message.error()));
                }
                auto requested = m_gateway.request_notification(*text);
                if (!requested)
                    return fault(requested.error());
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::CallSceneInteractionInstruction>) {
                auto next = expected;
                next.next_instruction = sequential;
                auto called = m_flow.call_child(value.scene, core::FlowFramePosition{next});
                return called ? std::nullopt
                              : std::optional<core::FlowRunOutcome>{fault(called.error())};
            } else if constexpr (std::is_same_v<
                                     T, core::compiled::CallDialogueInteractionInstruction>) {
                auto next = expected;
                next.next_instruction = sequential;
                auto called =
                    m_flow.call_child(value.dialogue, std::nullopt, core::FlowFramePosition{next});
                return called ? std::nullopt
                              : std::optional<core::FlowRunOutcome>{fault(called.error())};
            }
            auto next = expected;
            next.next_instruction = sequential;
            auto advanced = m_flow.advance_interaction(expected, frame->program, next);
            return advanced ? std::nullopt
                            : std::optional<core::FlowRunOutcome>{fault(advanced.error())};
        },
        *instruction);
}

core::Result<core::InteractionView, RuntimeExecutionError>
RuntimeExecutor::interaction_view(std::string_view)
{
    const auto* frame = m_state.flow_stack().empty()
                            ? nullptr
                            : std::get_if<core::InteractionFrame>(&m_state.flow_stack().back());
    if (frame == nullptr)
        return core::Result<core::InteractionView, RuntimeExecutionError>::failure(
            interaction_error("execution.no_interaction_view", "No Interaction is active"));
    core::InteractionView view{frame->invocation.verb, frame->invocation.room,
                               frame->invocation.bindings, frame->program, std::nullopt};
    for (auto it = m_gateway.events().rbegin(); it != m_gateway.events().rend(); ++it) {
        const auto* notification = std::get_if<runtime::NotificationEvent>(&*it);
        if (notification != nullptr) {
            view.notification = notification->message;
            break;
        }
    }
    return core::Result<core::InteractionView, RuntimeExecutionError>::success(std::move(view));
}

core::Result<core::InventoryView, RuntimeExecutionError>
RuntimeExecutor::inventory_view(std::string_view runtime_locale)
{
    core::InventoryView view;
    const auto owner_room = [&](const core::compiled::InventoryOwnerRef& owner) {
        return std::visit(
            [&](const auto& value) -> std::optional<core::RoomId> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInventoryOwner>)
                    return m_world.effective_room(value.character);
                else if constexpr (std::is_same_v<T, core::compiled::InteractableInventoryOwner>)
                    return m_world.effective_room(value.interactable);
                else if constexpr (std::is_same_v<T, core::RoomFeatureRef>)
                    return value.room;
                else if constexpr (std::is_same_v<T, core::InteractableFeatureRef>)
                    return m_world.effective_room(value.interactable);
                else
                    return std::nullopt;
            },
            owner);
    };
    const auto append_inventories =
        [&](const core::compiled::InventoryOwnerRef& owner,
            const std::vector<core::compiled::InventoryDefinition>& values) {
            for (const auto& inventory : values) {
                core::compiled::InventoryRef reference{owner, inventory.id};
                view.inventories.push_back(
                    {reference, inventory.label, owner_room(reference.owner)});
            }
        };
    append_inventories(core::compiled::ProjectInventoryOwner{}, m_project.inventories());
    for (const auto& record : m_state.runtime_characters()) {
        const auto& character = record.effective_configuration();
        append_inventories(core::compiled::CharacterInventoryOwner{record.id},
                           character.inventories);
    }
    for (const auto& record : m_state.runtime_rooms()) {
        const auto& room = record.effective_configuration();
        for (const auto& feature : room.features)
            append_inventories(core::RoomFeatureRef{record.id, feature.identity.id},
                               feature.inventories);
    }
    for (const auto& record : m_state.runtime_interactables()) {
        const auto& interactable = record.effective_configuration();
        append_inventories(core::compiled::InteractableInventoryOwner{record.id},
                           interactable.inventories);
        for (const auto& feature : interactable.features)
            append_inventories(core::InteractableFeatureRef{record.id, feature.identity.id},
                               feature.inventories);
    }
    for (const auto& state : m_state.interactables()) {
        const auto* location = std::get_if<core::compiled::InventoryLocation>(&state.location);
        if (location == nullptr)
            continue;
        const auto* definition = m_world.resolved_configuration(state.interactable);
        if (definition == nullptr || !m_world.has_inventory(location->inventory))
            return core::Result<core::InventoryView, RuntimeExecutionError>::failure(
                interaction_error("execution.invalid_inventory",
                                  "Inventory definition or membership reference is missing"));
        view.items.push_back({state.interactable, location->inventory,
                              m_world.effective_room(state.interactable), definition->display_name,
                              definition->presentation, state.enabled, state.visible});
    }
    for (const auto& stack : m_state.item_stacks()) {
        const auto* location = std::get_if<core::compiled::InventoryLocation>(&stack.location);
        const auto* definition = m_project.find_item_definition(stack.definition);
        if (location == nullptr || definition == nullptr ||
            !m_world.has_inventory(location->inventory))
            continue;
        view.item_stacks.push_back({stack.id, stack.definition, stack.quantity, stack.location,
                                    m_world.effective_room(stack.id), definition->display_name,
                                    definition->description, definition->presentation,
                                    stack.traits});
    }
    std::ranges::sort(view.item_stacks, {}, [](const auto& stack) { return stack.stack.text(); });
    for (const auto& verb : m_project.verbs()) {
        auto label = resolve(verb.action_text.source, runtime_locale);
        const auto* text = label.value_if();
        if (text == nullptr)
            return core::Result<core::InventoryView, RuntimeExecutionError>::failure(label.error());
        auto available = evaluate(verb.availability);
        const auto* enabled = available.value_if();
        if (enabled == nullptr)
            return core::Result<core::InventoryView, RuntimeExecutionError>::failure(
                available.error());
        view.controls.push_back(
            {verb.identity.id, *text, verb.binding_order, verb.quick_action, *enabled});
    }
    return core::Result<core::InventoryView, RuntimeExecutionError>::success(std::move(view));
}

} // namespace noveltea::runtime
