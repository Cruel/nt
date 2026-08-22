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
                          std::vector<core::compiled::InteractionSubject> operands)
{
    const auto* room_mode = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* verb = m_project.find_verb(verb_id);
    if (room_mode == nullptr || verb == nullptr || !m_state.flow_stack().empty() ||
        operands.size() != verb->arity)
        return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
            "execution.invalid_interaction_invocation",
            "Interaction requires Room mode, a valid Verb, and matching operands"));
    if (!m_room_presentation || m_room_presentation_dirty ||
        m_room_presentation->presentation.visit.room != room_mode->room) {
        auto settled = room_view({});
        if (!settled)
            return core::Result<void, RuntimeExecutionError>::failure(settled.error());
    }
    for (const auto& operand : operands) {
        if (std::find(m_room_presentation->eligible_subjects.begin(),
                      m_room_presentation->eligible_subjects.end(),
                      operand) == m_room_presentation->eligible_subjects.end())
            return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
                "execution.interaction_subject_unavailable",
                "Interaction operand is not eligible in the active Room resolution"));
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
        std::size_t exact_operands = 0;
        std::size_t typed_wildcards = 0;
        std::size_t declaration_order = 0;
    };
    std::optional<Candidate> selected;
    std::size_t order = 0;
    for (const auto& interaction : m_project.interactions()) {
        for (const auto& rule : interaction.rules) {
            const auto current_order = order++;
            if (rule.verb != verb_id || rule.operands.size() != operands.size())
                continue;
            std::size_t exact = 0;
            std::size_t typed_wildcards = 0;
            bool matches = true;
            for (std::size_t index = 0; index < operands.size(); ++index) {
                if (const auto* expected =
                        std::get_if<core::compiled::ExactOperand>(&rule.operands[index])) {
                    matches = matches && expected->subject == operands[index];
                    ++exact;
                } else if (std::holds_alternative<core::compiled::AnyCharacterOperand>(
                               rule.operands[index])) {
                    matches = matches &&
                              std::holds_alternative<core::compiled::CharacterInteractionSubject>(
                                  operands[index]);
                    ++typed_wildcards;
                } else if (std::holds_alternative<core::compiled::AnyInteractableOperand>(
                               rule.operands[index])) {
                    matches =
                        matches &&
                        std::holds_alternative<core::compiled::InteractableInteractionSubject>(
                            operands[index]);
                    ++typed_wildcards;
                } else if (std::holds_alternative<core::compiled::AnyItemStackOperand>(
                               rule.operands[index])) {
                    matches = matches &&
                              std::holds_alternative<core::compiled::ItemStackInteractionSubject>(
                                  operands[index]);
                    ++typed_wildcards;
                }
            }
            if (!matches)
                continue;
            bool context_matches = std::visit(
                [this, &room_mode, &operands](const auto& context) {
                    using T = std::decay_t<decltype(context)>;
                    if constexpr (std::is_same_v<T, core::compiled::AnyInteractionContext>)
                        return true;
                    else if constexpr (std::is_same_v<T,
                                                      core::compiled::ActiveRoomInteractionContext>)
                        return context.room == room_mode->room;
                    else if constexpr (std::is_same_v<
                                           T, core::compiled::PlacementInteractionContext>) {
                        return std::any_of(
                            operands.begin(), operands.end(),
                            [this, &context](const auto& subject) {
                                if (context.placement.room !=
                                    m_room_presentation->presentation.visit.room)
                                    return false;
                                if (const auto* character =
                                        std::get_if<core::compiled::CharacterInteractionSubject>(
                                            &subject)) {
                                    return std::any_of(
                                        m_room_presentation->presentation.actors.begin(),
                                        m_room_presentation->presentation.actors.end(),
                                        [&context,
                                         character](const core::ResolvedRoomActor& actor) {
                                            return actor.character == character->character &&
                                                   actor.placement ==
                                                       context.placement.placement_id;
                                        });
                                }
                                std::optional<core::InteractableId> interactable_id;
                                if (const auto* interactable =
                                        std::get_if<core::compiled::InteractableInteractionSubject>(
                                            &subject)) {
                                    interactable_id = interactable->interactable;
                                } else if (const auto* feature = std::get_if<
                                               core::compiled::FeatureInteractionSubject>(
                                               &subject)) {
                                    const auto* owner = std::get_if<core::InteractableFeatureRef>(
                                        &feature->feature);
                                    if (owner == nullptr)
                                        return false;
                                    interactable_id = owner->interactable;
                                } else {
                                    return false;
                                }
                                return std::any_of(
                                    m_room_presentation->presentation.interactables.begin(),
                                    m_room_presentation->presentation.interactables.end(),
                                    [&context, &interactable_id](
                                        const core::ResolvedRoomInteractable& value) {
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
                {interaction.identity.id, rule.id}, exact, typed_wildcards, current_order};
            if (!selected || candidate.exact_operands > selected->exact_operands ||
                (candidate.exact_operands == selected->exact_operands &&
                 candidate.typed_wildcards > selected->typed_wildcards) ||
                (candidate.exact_operands == selected->exact_operands &&
                 candidate.typed_wildcards == selected->typed_wildcards &&
                 candidate.declaration_order < selected->declaration_order))
                selected = std::move(candidate);
        }
    }

    const core::InteractionProgramRef program =
        selected ? core::InteractionProgramRef{selected->reference}
                 : core::InteractionProgramRef{core::VerbDefaultProgramRef{verb_id}};
    auto started = m_flow.start_interaction(
        core::InteractionInvocationContext{verb_id, room_mode->room, std::move(operands)}, program);
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
                               frame->invocation.operands, frame->program, std::nullopt};
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
        view.controls.push_back({verb.identity.id, *text, verb.arity, verb.quick_action, *enabled});
    }
    return core::Result<core::InventoryView, RuntimeExecutionError>::success(std::move(view));
}

} // namespace noveltea::runtime
