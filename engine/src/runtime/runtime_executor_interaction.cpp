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
    return interact_with_context(std::move(verb_id), std::move(operands), std::nullopt);
}

core::Result<void, RuntimeExecutionError>
RuntimeExecutor::interact_with_context(core::VerbId verb_id,
                                       std::vector<core::compiled::InteractionSubject> operands,
                                       std::optional<core::compiled::HotspotRef> hotspot)
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
        bool exact_hotspot = false;
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
                    matches = std::holds_alternative<core::compiled::CharacterInteractionSubject>(
                        operands[index]);
                    ++typed_wildcards;
                } else if (std::holds_alternative<core::compiled::AnyInteractableOperand>(
                               rule.operands[index])) {
                    matches =
                        std::holds_alternative<core::compiled::InteractableInteractionSubject>(
                            operands[index]);
                    ++typed_wildcards;
                }
            }
            if (!matches)
                continue;
            bool context_matches = std::visit(
                [this, &room_mode, &operands, &hotspot](const auto& context) {
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
                                const auto* interactable =
                                    std::get_if<core::compiled::InteractableInteractionSubject>(
                                        &subject);
                                return interactable != nullptr &&
                                       std::any_of(
                                           m_room_presentation->presentation.interactables.begin(),
                                           m_room_presentation->presentation.interactables.end(),
                                           [&context, interactable](
                                               const core::ResolvedRoomInteractable& value) {
                                               return value.interactable ==
                                                          interactable->interactable &&
                                                      value.placement ==
                                                          context.placement.placement_id;
                                           });
                            });
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::PredicateInteractionContext>) {
                        auto evaluated = evaluate(context.condition);
                        const auto* value = evaluated.value_if();
                        return value != nullptr && *value;
                    } else if constexpr (std::is_same_v<T,
                                                        core::compiled::HotspotInteractionContext>)
                        return hotspot && context.hotspot == *hotspot;
                    else
                        return false;
                },
                rule.context);
            if (!context_matches)
                continue;
            const bool exact_hotspot =
                std::holds_alternative<core::compiled::HotspotInteractionContext>(rule.context);
            Candidate candidate{{interaction.identity.id, rule.id},
                                exact,
                                typed_wildcards,
                                exact_hotspot,
                                current_order};
            if (!selected || candidate.exact_operands > selected->exact_operands ||
                (candidate.exact_operands == selected->exact_operands &&
                 candidate.typed_wildcards > selected->typed_wildcards) ||
                (candidate.exact_operands == selected->exact_operands &&
                 candidate.typed_wildcards == selected->typed_wildcards &&
                 candidate.exact_hotspot && !selected->exact_hotspot) ||
                (candidate.exact_operands == selected->exact_operands &&
                 candidate.typed_wildcards == selected->typed_wildcards &&
                 candidate.exact_hotspot == selected->exact_hotspot &&
                 candidate.declaration_order < selected->declaration_order))
                selected = std::move(candidate);
        }
    }

    const core::InteractionProgramRef program =
        selected ? core::InteractionProgramRef{selected->reference}
                 : core::InteractionProgramRef{core::VerbDefaultProgramRef{verb_id}};
    auto started = m_flow.start_interaction(
        core::InteractionInvocationContext{verb_id, room_mode->room, std::move(operands),
                                           std::move(hotspot)},
        program);
    return started ? core::Result<void, RuntimeExecutionError>::success()
                   : core::Result<void, RuntimeExecutionError>::failure(started.error());
}

core::Result<void, RuntimeExecutionError>
RuntimeExecutor::activate_hotspot(const core::compiled::HotspotRef& hotspot)
{
    const auto* room_mode = std::get_if<core::RoomMode>(&m_state.mode());
    if (room_mode == nullptr || !m_state.flow_stack().empty())
        return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
            "execution.invalid_hotspot_activation", "Hotspot activation requires idle Room mode"));
    if (!m_room_presentation || m_room_presentation_dirty ||
        m_room_presentation->presentation.visit.room != room_mode->room) {
        auto settled = room_view({});
        if (!settled)
            return core::Result<void, RuntimeExecutionError>::failure(settled.error());
    }

    return std::visit(
        [this, &hotspot,
         &room_mode](const auto& reference) -> core::Result<void, RuntimeExecutionError> {
            using T = std::decay_t<decltype(reference)>;
            if constexpr (std::is_same_v<T, core::compiled::RoomHotspotRef>) {
                if (reference.room != room_mode->room)
                    return core::Result<void, RuntimeExecutionError>::failure(
                        interaction_error("execution.hotspot_owner_unavailable",
                                          "Room hotspot owner is not the active Room"));
                const auto* room = m_world.resolved_configuration(reference.room);
                if (room == nullptr)
                    return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
                        "execution.unknown_hotspot", "Room hotspot definition is missing"));
                const auto found = std::find_if(
                    room->hotspots.begin(), room->hotspots.end(),
                    [&reference](const auto& value) { return value.id == reference.hotspot_id; });
                if (found == room->hotspots.end())
                    return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
                        "execution.unknown_hotspot", "Room hotspot definition is missing"));
                auto condition = evaluate(found->condition);
                if (!condition || !*condition.value_if())
                    return core::Result<void, RuntimeExecutionError>::failure(
                        condition ? interaction_error("execution.hotspot_unavailable",
                                                      "Hotspot condition rejected activation")
                                  : condition.error());
                if (const auto* verb =
                        std::get_if<core::compiled::VerbHotspotActivation>(&found->activation))
                    return interact_with_context(verb->verb, {}, hotspot);
                const auto& exit =
                    std::get<core::compiled::RoomExitHotspotActivation>(found->activation);
                auto navigated = navigate(exit.exit_id);
                return navigated ? core::Result<void, RuntimeExecutionError>::success()
                                 : core::Result<void, RuntimeExecutionError>::failure(
                                       std::move(navigated).error());
            } else {
                const auto* owner = m_world.resolved_configuration(reference.interactable);
                const auto present =
                    std::find_if(m_room_presentation->presentation.interactables.begin(),
                                 m_room_presentation->presentation.interactables.end(),
                                 [&reference](const core::ResolvedRoomInteractable& value) {
                                     return value.interactable == reference.interactable &&
                                            value.enabled && value.visible;
                                 });
                if (owner == nullptr ||
                    present == m_room_presentation->presentation.interactables.end())
                    return core::Result<void, RuntimeExecutionError>::failure(
                        interaction_error("execution.hotspot_owner_unavailable",
                                          "Interactable hotspot owner is not visible and enabled "
                                          "in the active Room"));
                const core::compiled::InteractableHotspotBehavior* behavior = nullptr;
                std::visit(
                    [&behavior, &reference](const auto& collection) {
                        using C = std::decay_t<decltype(collection)>;
                        if constexpr (std::is_same_v<C, core::compiled::SpriteAlphaHotspots>) {
                            if (collection.hotspot.id == reference.hotspot_id)
                                behavior = &collection.hotspot;
                        } else {
                            const auto found =
                                std::find_if(collection.hotspots.begin(), collection.hotspots.end(),
                                             [&reference](const auto& value) {
                                                 return value.id == reference.hotspot_id;
                                             });
                            if (found != collection.hotspots.end())
                                behavior = &*found;
                        }
                    },
                    owner->presentation.hotspots);
                if (behavior == nullptr)
                    return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
                        "execution.unknown_hotspot", "Interactable hotspot definition is missing"));
                auto condition = evaluate(behavior->condition);
                if (!condition || !*condition.value_if())
                    return core::Result<void, RuntimeExecutionError>::failure(
                        condition ? interaction_error("execution.hotspot_unavailable",
                                                      "Hotspot condition rejected activation")
                                  : condition.error());
                return interact_with_context(
                    behavior->activation.verb,
                    {core::compiled::InteractableInteractionSubject{reference.interactable}},
                    hotspot);
            }
        },
        hotspot);
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
    core::InteractionView view{
        frame->invocation.verb,    frame->invocation.room, frame->invocation.operands,
        frame->invocation.hotspot, frame->program,         std::nullopt};
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
    for (const auto& state : m_state.interactables()) {
        if (!std::holds_alternative<core::compiled::InventoryLocation>(state.location))
            continue;
        const auto* definition = m_world.resolved_configuration(state.interactable);
        if (definition == nullptr)
            return core::Result<core::InventoryView, RuntimeExecutionError>::failure(
                interaction_error("execution.invalid_inventory",
                                  "Inventory definition is missing"));
        view.items.push_back({state.interactable, definition->display_name,
                              definition->presentation, state.enabled, state.visible});
    }
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
