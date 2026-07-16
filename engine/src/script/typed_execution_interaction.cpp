#include "noveltea/script/typed_execution_kernel.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace noveltea::script {
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

std::vector<const core::compiled::VerbDefinition*> verb_chain(const core::CompiledProject& project,
                                                              const core::VerbId& leaf)
{
    std::vector<const core::compiled::VerbDefinition*> result;
    const auto* current = project.find_verb(leaf);
    while (current != nullptr) {
        result.push_back(current);
        const auto parent = project.verb_parent_index(current->identity.id);
        current = parent ? &project.verbs()[*parent] : nullptr;
    }
    return result;
}

bool placement_matches(const core::InteractableState& state,
                       const core::compiled::RoomPlacementRef& placement)
{
    const auto* current = std::get_if<core::compiled::RoomPlacementRef>(&state.location);
    return current != nullptr && current->room == placement.room &&
           current->placement_id == placement.placement_id;
}

} // namespace

core::Result<void, TypedExecutionError>
TypedExecutionKernel::interact(core::VerbId verb_id, std::vector<core::InteractableId> operands)
{
    const auto* room_mode = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* verb = m_project.find_verb(verb_id);
    if (room_mode == nullptr || verb == nullptr || !m_state.flow_stack().empty() ||
        operands.size() != verb->arity)
        return core::Result<void, TypedExecutionError>::failure(interaction_error(
            "execution.invalid_interaction_invocation",
            "Interaction requires Room mode, a valid Verb, and matching operands"));
    for (const auto& operand : operands) {
        const auto* state = m_state.interactable(operand);
        if (state == nullptr || !state->enabled)
            return core::Result<void, TypedExecutionError>::failure(
                interaction_error("execution.interactable_unavailable",
                                  "Interaction operand is missing or disabled"));
    }

    auto chain = verb_chain(m_project, verb_id);
    for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
        auto available = evaluate((*it)->availability);
        const auto* value = available.value_if();
        if (value == nullptr)
            return core::Result<void, TypedExecutionError>::failure(available.error());
        if (!*value)
            return core::Result<void, TypedExecutionError>::failure(interaction_error(
                "execution.verb_unavailable", "Verb availability rejected the interaction"));
    }

    struct Candidate {
        core::InteractionRuleProgramRef reference;
        std::size_t exact_operands = 0;
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
            bool matches = true;
            for (std::size_t index = 0; index < operands.size(); ++index) {
                if (const auto* expected =
                        std::get_if<core::compiled::ExactOperand>(&rule.operands[index])) {
                    matches = matches && expected->interactable == operands[index];
                    ++exact;
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
                        return std::any_of(operands.begin(), operands.end(),
                                           [this, &context](const auto& id) {
                                               const auto* state = m_state.interactable(id);
                                               return state != nullptr &&
                                                      placement_matches(*state, context.placement);
                                           });
                    } else {
                        auto evaluated = evaluate(context.condition);
                        const auto* value = evaluated.value_if();
                        return value != nullptr && *value;
                    }
                },
                rule.context);
            if (!context_matches)
                continue;
            Candidate candidate{{interaction.identity.id, rule.id}, exact, current_order};
            if (!selected || candidate.exact_operands > selected->exact_operands ||
                (candidate.exact_operands == selected->exact_operands &&
                 candidate.declaration_order < selected->declaration_order))
                selected = std::move(candidate);
        }
    }

    const core::InteractionProgramRef program =
        selected ? core::InteractionProgramRef{selected->reference}
                 : core::InteractionProgramRef{core::VerbDefaultProgramRef{verb_id}};
    auto started = m_flow.start_interaction(
        core::InteractionInvocationContext{verb_id, room_mode->room, std::move(operands)}, program);
    return started ? core::Result<void, TypedExecutionError>::success()
                   : core::Result<void, TypedExecutionError>::failure(started.error());
}

std::optional<core::FlowRunOutcome>
TypedExecutionKernel::run_interaction_unit(std::string_view runtime_locale)
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

        auto chain = verb_chain(m_project, frame->invocation.verb);
        auto current = std::get_if<core::VerbDefaultProgramRef>(&frame->program);
        std::size_t index = 0;
        if (current != nullptr) {
            const auto found =
                std::find_if(chain.begin(), chain.end(), [&current](const auto* item) {
                    return item->identity.id == current->verb;
                });
            index = found == chain.end() ? chain.size()
                                         : static_cast<std::size_t>(found - chain.begin()) + 1;
        }
        if (current == nullptr)
            index = 0;
        if (index < chain.size()) {
            core::InteractionProgramRef next_program =
                core::VerbDefaultProgramRef{chain[index]->identity.id};
            const auto* next_definition = program_for(m_project, next_program);
            auto next = core::InteractionFramePosition{
                first_instruction(*next_definition), core::InteractionFallbackStage::ParentVerb,
                core::InteractionExecutionOutcome::Pending, false};
            auto advanced = m_flow.advance_interaction(expected, std::move(next_program), next);
            if (!advanced)
                return fault(advanced.error());
            return std::nullopt;
        }

        auto requested = m_host.request_notification("Nothing happens.");
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
                    if (const auto* script = std::get_if<ScriptError>(&applied.error()))
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
                auto moved = m_state.move_interactable(m_project, value.interactable, value.target);
                if (!moved)
                    return fault(moved.error());
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::SetInteractableStateInstruction>) {
                if (value.enabled) {
                    auto changed = m_state.set_interactable_enabled(m_project, value.interactable,
                                                                    *value.enabled);
                    if (!changed)
                        return fault(changed.error());
                }
                if (value.visible) {
                    auto changed = m_state.set_interactable_visible(m_project, value.interactable,
                                                                    *value.visible);
                    if (!changed)
                        return fault(changed.error());
                }
            } else if constexpr (std::is_same_v<T, core::compiled::NotifyInstruction>) {
                auto message = resolve(value.message.source, runtime_locale);
                const auto* text = message.value_if();
                if (text == nullptr) {
                    if (const auto* script = std::get_if<ScriptError>(&message.error()))
                        return fault(interaction_error("execution.interaction_text_failed",
                                                       script->message));
                    return fault(std::get<core::Diagnostics>(message.error()));
                }
                auto requested = m_host.request_notification(*text);
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

core::Result<core::InteractionView, TypedExecutionError>
TypedExecutionKernel::interaction_view(std::string_view)
{
    const auto* frame = m_state.flow_stack().empty()
                            ? nullptr
                            : std::get_if<core::InteractionFrame>(&m_state.flow_stack().back());
    if (frame == nullptr)
        return core::Result<core::InteractionView, TypedExecutionError>::failure(
            interaction_error("execution.no_interaction_view", "No Interaction is active"));
    core::InteractionView view{frame->invocation.verb, frame->invocation.room,
                               frame->invocation.operands, frame->program, std::nullopt};
    for (auto it = m_host.actions().rbegin(); it != m_host.actions().rend(); ++it) {
        const auto* event = std::get_if<runtime::RuntimeEvent>(&*it);
        const auto* notification =
            event == nullptr ? nullptr : std::get_if<runtime::NotificationEvent>(event);
        if (notification != nullptr) {
            view.notification = notification->message;
            break;
        }
    }
    return core::Result<core::InteractionView, TypedExecutionError>::success(std::move(view));
}

core::Result<core::InventoryView, TypedExecutionError>
TypedExecutionKernel::inventory_view(std::string_view runtime_locale)
{
    core::InventoryView view;
    for (const auto& state : m_state.interactables()) {
        if (!std::holds_alternative<core::compiled::InventoryLocation>(state.location))
            continue;
        const auto* definition = m_project.find_interactable(state.interactable);
        if (definition == nullptr)
            return core::Result<core::InventoryView, TypedExecutionError>::failure(
                interaction_error("execution.invalid_inventory",
                                  "Inventory definition is missing"));
        view.items.push_back({state.interactable, definition->display_name,
                              definition->presentation, state.enabled, state.visible});
    }
    for (const auto& verb : m_project.verbs()) {
        auto label = resolve(verb.action_text.source, runtime_locale);
        const auto* text = label.value_if();
        if (text == nullptr)
            return core::Result<core::InventoryView, TypedExecutionError>::failure(label.error());
        auto chain = verb_chain(m_project, verb.identity.id);
        bool enabled = true;
        for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
            auto available = evaluate((*it)->availability);
            const auto* value = available.value_if();
            if (value == nullptr)
                return core::Result<core::InventoryView, TypedExecutionError>::failure(
                    available.error());
            enabled = enabled && *value;
        }
        view.controls.push_back({verb.identity.id, *text, verb.arity, verb.quick_action, enabled});
    }
    return core::Result<core::InventoryView, TypedExecutionError>::success(std::move(view));
}

} // namespace noveltea::script
