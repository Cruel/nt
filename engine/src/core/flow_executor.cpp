#include "noveltea/core/flow_executor.hpp"

#include <algorithm>
#include <limits>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics execution_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

template<class Instruction> auto instruction_id(const Instruction& instruction)
{
    return instruction.id;
}

std::optional<SceneStepId> first_scene_step(const compiled::SceneDefinition& scene)
{
    if (scene.program.instructions.empty())
        return std::nullopt;
    return std::visit([](const auto& value) { return instruction_id(value); },
                      scene.program.instructions.front());
}

std::optional<InteractionInstructionId>
first_interaction_instruction(const compiled::InteractionProgram& program)
{
    if (program.instructions.empty())
        return std::nullopt;
    return std::visit([](const auto& value) { return instruction_id(value); },
                      program.instructions.front());
}

const compiled::InteractionProgram* find_interaction_program(const CompiledProject& project,
                                                             const InteractionProgramRef& reference)
{
    return std::visit(
        [&project](const auto& value) -> const compiled::InteractionProgram* {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, InteractionRuleProgramRef>) {
                const auto* interaction = project.find_interaction(value.interaction);
                if (interaction == nullptr)
                    return nullptr;
                const auto found =
                    std::find_if(interaction->rules.begin(), interaction->rules.end(),
                                 [&value](const compiled::InteractionRule& rule) {
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

bool has_scene_step(const compiled::SceneDefinition& scene, const SceneStepId& id)
{
    return std::any_of(scene.program.instructions.begin(), scene.program.instructions.end(),
                       [&id](const compiled::SceneInstruction& instruction) {
                           return std::visit([&id](const auto& value) { return value.id == id; },
                                             instruction);
                       });
}

const compiled::ChoiceSceneInstruction*
find_scene_choice_instruction(const compiled::SceneDefinition& scene, const SceneStepId& step)
{
    const auto found = std::find_if(
        scene.program.instructions.begin(), scene.program.instructions.end(),
        [&step](const compiled::SceneInstruction& instruction) {
            return std::visit([&step](const auto& value) { return value.id == step; }, instruction);
        });
    return found == scene.program.instructions.end()
               ? nullptr
               : std::get_if<compiled::ChoiceSceneInstruction>(&*found);
}

const compiled::DialogueBlock* find_dialogue_block(const compiled::DialogueDefinition& dialogue,
                                                   const DialogueBlockId& id)
{
    const auto found = std::find_if(
        dialogue.program.blocks.begin(), dialogue.program.blocks.end(),
        [&id](const compiled::DialogueBlock& block) {
            return std::visit([&id](const auto& value) { return value.id == id; }, block);
        });
    return found == dialogue.program.blocks.end() ? nullptr : &*found;
}

bool has_dialogue_block(const compiled::DialogueDefinition& dialogue, const DialogueBlockId& id)
{
    return std::any_of(dialogue.program.blocks.begin(), dialogue.program.blocks.end(),
                       [&id](const compiled::DialogueBlock& block) {
                           return std::visit([&id](const auto& value) { return value.id == id; },
                                             block);
                       });
}

const compiled::DialogueSegment* find_dialogue_segment(const compiled::DialogueBlock& block,
                                                       const DialogueSegmentId& id)
{
    const auto* sequence = std::get_if<compiled::DialogueSequenceBlock>(&block);
    if (sequence == nullptr)
        return nullptr;
    const auto found = std::find_if(
        sequence->segments.begin(), sequence->segments.end(),
        [&id](const compiled::DialogueSegment& segment) {
            return std::visit([&id](const auto& value) { return value.id == id; }, segment);
        });
    return found == sequence->segments.end() ? nullptr : &*found;
}

const compiled::DialogueEdge* find_dialogue_edge(const compiled::DialogueDefinition& dialogue,
                                                 const DialogueEdgeId& id)
{
    const auto found = std::find_if(
        dialogue.program.edges.begin(), dialogue.program.edges.end(),
        [&id](const compiled::DialogueEdge& edge) {
            return std::visit([&id](const auto& value) { return value.id == id; }, edge);
        });
    return found == dialogue.program.edges.end() ? nullptr : &*found;
}

bool dialogue_edge_starts_at(const compiled::DialogueEdge& edge, const DialogueBlockId& block)
{
    return std::visit([&block](const auto& value) { return value.from_block_id == block; }, edge);
}

bool has_interaction_instruction(const compiled::InteractionProgram& program,
                                 const InteractionInstructionId& id)
{
    return std::any_of(program.instructions.begin(), program.instructions.end(),
                       [&id](const compiled::InteractionInstruction& instruction) {
                           return std::visit([&id](const auto& value) { return value.id == id; },
                                             instruction);
                       });
}

std::size_t room_hook_effect_count(const CompiledProject& project,
                                   const RoomTransitionFrame& transition, RoomTransitionStage stage)
{
    const compiled::RoomDefinition* room = nullptr;
    std::optional<compiled::RoomHookKind> hook;
    switch (stage) {
    case RoomTransitionStage::BeforeLeave:
        room = transition.source_room ? project.find_room(*transition.source_room) : nullptr;
        hook = compiled::RoomHookKind::BeforeLeave;
        break;
    case RoomTransitionStage::BeforeEnter:
        room = project.find_room(transition.target_room);
        hook = compiled::RoomHookKind::BeforeEnter;
        break;
    case RoomTransitionStage::AfterLeave:
        room = transition.source_room ? project.find_room(*transition.source_room) : nullptr;
        hook = compiled::RoomHookKind::AfterLeave;
        break;
    case RoomTransitionStage::AfterEnter:
        room = project.find_room(transition.target_room);
        hook = compiled::RoomHookKind::AfterEnter;
        break;
    default:
        return 0;
    }
    if (room == nullptr || !hook)
        return 0;
    const auto found = std::find_if(
        room->lifecycle.hooks.begin(), room->lifecycle.hooks.end(),
        [&hook](const compiled::RoomHookProgram& program) { return program.hook == *hook; });
    return found == room->lifecycle.hooks.end() ? 0 : found->effects.size();
}

bool valid_room_transition_position(const CompiledProject& project,
                                    const RoomTransitionFrame& transition,
                                    const RoomTransitionPosition& position)
{
    if (position.stage > RoomTransitionStage::Complete)
        return false;
    switch (position.stage) {
    case RoomTransitionStage::BeforeLeave:
    case RoomTransitionStage::BeforeEnter:
    case RoomTransitionStage::AfterLeave:
    case RoomTransitionStage::AfterEnter:
        return position.next_effect <= room_hook_effect_count(project, transition, position.stage);
    default:
        return position.next_effect == 0;
    }
}

void assign_position(FlowFrame& frame, FlowFramePosition position)
{
    std::visit(
        [&position](auto& value) {
            using Frame = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<Frame, SceneFrame>)
                value.position = std::get<SceneFramePosition>(std::move(position));
            else if constexpr (std::is_same_v<Frame, DialogueFrame>)
                value.position = std::get<DialogueFramePosition>(std::move(position));
            else if constexpr (std::is_same_v<Frame, InteractionFrame>)
                value.position = std::get<InteractionFramePosition>(std::move(position));
            else
                value.position = std::get<RoomTransitionPosition>(std::move(position));
        },
        frame);
}

} // namespace

const FlowFrameId& flow_frame_id(const FlowFrame& frame) noexcept
{
    return std::visit([](const auto& value) -> const FlowFrameId& { return value.frame_id; },
                      frame);
}

const ReturnDestination& flow_return_destination(const FlowFrame& frame) noexcept
{
    return std::visit(
        [](const auto& value) -> const ReturnDestination& { return value.destination; }, frame);
}

FlowFramePosition flow_frame_position(const FlowFrame& frame)
{
    return std::visit([](const auto& value) -> FlowFramePosition { return value.position; }, frame);
}

const FlowFrameId& flow_blocker_owner(const FlowBlocker& blocker) noexcept
{
    return std::visit([](const auto& value) -> const FlowFrameId& { return value.owner; }, blocker);
}

AnyFlowBlockerHandle flow_blocker_handle(const FlowBlocker& blocker)
{
    return std::visit([](const auto& value) -> AnyFlowBlockerHandle { return value.handle; },
                      blocker);
}

FlowBlockerKind flow_blocker_kind(const FlowBlocker& blocker) noexcept
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, InputFlowBlocker>)
                return FlowBlockerKind::Input;
            else if constexpr (std::is_same_v<T, DurationFlowBlocker>)
                return FlowBlockerKind::Duration;
            else if constexpr (std::is_same_v<T, PresentationFlowBlocker>)
                return FlowBlockerKind::Presentation;
            else if constexpr (std::is_same_v<T, AudioFlowBlocker>)
                return FlowBlockerKind::Audio;
            else
                return FlowBlockerKind::Script;
        },
        blocker);
}

Result<void, Diagnostics> FlowExecutor::fail(Diagnostics diagnostics)
{
    if (!m_state.m_execution_fault)
        m_state.m_execution_fault = diagnostics;
    return Result<void, Diagnostics>::failure(std::move(diagnostics));
}

Result<void, Diagnostics> FlowExecutor::ensure_flow_ready() const
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(
            execution_error("execution.fail_stopped",
                            "Flow execution is faulted and must be discarded or reloaded"));
    if (!std::holds_alternative<FlowMode>(m_state.m_mode) || m_state.m_flow_stack.empty())
        return Result<void, Diagnostics>::failure(
            execution_error("execution.invalid_mode", "Operation requires an active flow frame"));
    if (m_state.m_blocker)
        return Result<void, Diagnostics>::failure(
            execution_error("execution.blocked", "Active flow frame is blocked"));
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::validate_position(const FlowFrame& frame,
                                                          const FlowFramePosition& position) const
{
    const bool valid = std::visit(
        [this, &position](const auto& value) {
            using Frame = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<Frame, SceneFrame>) {
                const auto* candidate = std::get_if<SceneFramePosition>(&position);
                const auto* scene = m_project.find_scene(value.scene);
                if (candidate == nullptr || scene == nullptr ||
                    (candidate->next_step && !has_scene_step(*scene, *candidate->next_step)))
                    return false;
                if (std::holds_alternative<SceneStepReady>(candidate->substate))
                    return true;
                if (const auto* completion =
                        std::get_if<SceneInstructionCompletionPosition>(&candidate->substate))
                    return candidate->next_step && (!completion->next_step ||
                                                    has_scene_step(*scene, *completion->next_step));
                if (const auto* pending =
                        std::get_if<SceneAutosavePendingPosition>(&candidate->substate))
                    return candidate->next_step == pending->completed_step &&
                           (!pending->next_step || has_scene_step(*scene, *pending->next_step));
                if (!candidate->next_step)
                    return false;
                const auto* instruction =
                    find_scene_choice_instruction(*scene, *candidate->next_step);
                if (instruction == nullptr)
                    return false;
                if (std::holds_alternative<SceneChoiceSelectionPosition>(candidate->substate))
                    return true;
                const auto* choice = std::get_if<SceneChoiceEffectPosition>(&candidate->substate);
                if (choice == nullptr)
                    return false;
                const auto found =
                    std::find_if(instruction->options.begin(), instruction->options.end(),
                                 [&choice](const compiled::SceneChoiceOption& option) {
                                     return option.id == choice->option;
                                 });
                const auto* option = found == instruction->options.end() ? nullptr : &*found;
                return option != nullptr && choice->next_effect <= option->effects.size() &&
                       (!choice->awaiting_completion ||
                        choice->next_effect < option->effects.size());
            } else if constexpr (std::is_same_v<Frame, DialogueFrame>) {
                const auto* candidate = std::get_if<DialogueFramePosition>(&position);
                const auto* dialogue = m_project.find_dialogue(value.dialogue);
                const auto* block = candidate == nullptr || dialogue == nullptr
                                        ? nullptr
                                        : find_dialogue_block(*dialogue, candidate->block);
                if (candidate == nullptr || dialogue == nullptr || block == nullptr ||
                    candidate->stage > DialogueFramePosition::Stage::Complete)
                    return false;
                const auto* segment = candidate->segment
                                          ? find_dialogue_segment(*block, *candidate->segment)
                                          : nullptr;
                const auto* edge =
                    candidate->edge ? find_dialogue_edge(*dialogue, *candidate->edge) : nullptr;
                if ((candidate->segment && segment == nullptr) ||
                    (candidate->edge &&
                     (edge == nullptr || !dialogue_edge_starts_at(*edge, candidate->block))))
                    return false;
                switch (candidate->stage) {
                case DialogueFramePosition::Stage::EnterBlock:
                case DialogueFramePosition::Stage::Complete:
                    return !candidate->segment && !candidate->edge && candidate->next_effect == 0;
                case DialogueFramePosition::Stage::PresentSegment:
                    return segment != nullptr && !candidate->edge && candidate->next_effect == 0;
                case DialogueFramePosition::Stage::ApplySegmentEffects: {
                    const auto* line = segment == nullptr
                                           ? nullptr
                                           : std::get_if<compiled::DialogueLineSegment>(segment);
                    return line != nullptr && !candidate->edge &&
                           candidate->next_effect <= line->effects.size();
                }
                case DialogueFramePosition::Stage::PresentChoices:
                    return std::holds_alternative<compiled::DialogueChoiceBlock>(*block) &&
                           !candidate->segment && !candidate->edge && candidate->next_effect == 0;
                case DialogueFramePosition::Stage::ApplyChoiceEffects: {
                    const auto* choice =
                        edge == nullptr ? nullptr : std::get_if<compiled::DialogueChoiceEdge>(edge);
                    return choice != nullptr && !candidate->segment &&
                           candidate->next_effect <= choice->effects.size();
                }
                case DialogueFramePosition::Stage::FollowEdge:
                    return edge != nullptr && !candidate->segment && candidate->next_effect == 0;
                }
                return false;
            } else if constexpr (std::is_same_v<Frame, InteractionFrame>) {
                const auto* candidate = std::get_if<InteractionFramePosition>(&position);
                const auto* program = find_interaction_program(m_project, value.program);
                return candidate != nullptr && program != nullptr &&
                       (!candidate->next_instruction ||
                        has_interaction_instruction(*program, *candidate->next_instruction)) &&
                       candidate->fallback_stage <= InteractionFallbackStage::Complete &&
                       candidate->outcome <= InteractionExecutionOutcome::Failed;
            } else {
                const auto* candidate = std::get_if<RoomTransitionPosition>(&position);
                return candidate != nullptr &&
                       valid_room_transition_position(m_project, value, *candidate);
            }
        },
        frame);
    return valid ? Result<void, Diagnostics>::success()
                 : Result<void, Diagnostics>::failure(
                       execution_error("execution.invalid_frame_position",
                                       "Frame position is invalid for its owner"));
}

Result<void, Diagnostics> FlowExecutor::start_transient(const SceneId& scene)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    const auto* definition = m_project.find_scene(scene);
    const auto* room = std::get_if<RoomMode>(&m_state.m_mode);
    if (definition == nullptr || room == nullptr || !m_state.m_flow_stack.empty())
        return Result<void, Diagnostics>::failure(
            execution_error("execution.invalid_transient_start",
                            "Scene transient start requires Room mode and a valid Scene"));
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));
    const FlowFrameId id{m_state.m_next_frame_id++};
    m_state.m_flow_stack.emplace_back(SceneFrame{
        id, scene, {first_scene_step(*definition), {}}, ResumeRoomDestination{room->room}});
    m_state.m_mode = FlowMode{};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::start_transient(const DialogueId& dialogue)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    const auto* definition = m_project.find_dialogue(dialogue);
    const auto* room = std::get_if<RoomMode>(&m_state.m_mode);
    if (definition == nullptr || room == nullptr || !m_state.m_flow_stack.empty())
        return Result<void, Diagnostics>::failure(
            execution_error("execution.invalid_transient_start",
                            "Dialogue transient start requires Room mode and a valid Dialogue"));
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));
    const FlowFrameId id{m_state.m_next_frame_id++};
    m_state.m_flow_stack.emplace_back(
        DialogueFrame{id,
                      dialogue,
                      {definition->program.entry_block_id, std::nullopt, std::nullopt,
                       DialogueFramePosition::Stage::EnterBlock, 0},
                      ResumeRoomDestination{room->room}});
    m_state.m_mode = FlowMode{};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::start_interaction(InteractionInvocationContext invocation,
                                                          InteractionProgramRef program_reference)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    const auto* program = find_interaction_program(m_project, program_reference);
    const auto* verb = m_project.find_verb(invocation.verb);
    const auto* room = std::get_if<RoomMode>(&m_state.m_mode);
    const bool program_matches_verb = std::visit(
        [this, &invocation](const auto& reference) {
            using T = std::decay_t<decltype(reference)>;
            if constexpr (std::is_same_v<T, VerbDefaultProgramRef>)
                return reference.verb == invocation.verb;
            else {
                const auto* interaction = m_project.find_interaction(reference.interaction);
                if (interaction == nullptr)
                    return false;
                const auto found =
                    std::find_if(interaction->rules.begin(), interaction->rules.end(),
                                 [&reference](const compiled::InteractionRule& rule) {
                                     return rule.id == reference.rule;
                                 });
                return found != interaction->rules.end() && found->verb == invocation.verb;
            }
        },
        program_reference);
    const bool operands_exist = std::all_of(
        invocation.operands.begin(), invocation.operands.end(),
        [this](const InteractableId& id) { return m_project.find_interactable(id) != nullptr; });
    if (program == nullptr || verb == nullptr || room == nullptr || !m_state.m_flow_stack.empty() ||
        !program_matches_verb || invocation.operands.size() != verb->arity || !operands_exist)
        return Result<void, Diagnostics>::failure(
            execution_error("execution.invalid_interaction_start",
                            "Interaction start requires Room mode and a matching typed program"));
    if (invocation.room && *invocation.room != room->room)
        return Result<void, Diagnostics>::failure(
            execution_error("execution.invalid_interaction_context",
                            "Interaction context does not match the active Room"));
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));
    const FlowFrameId id{m_state.m_next_frame_id++};
    m_state.m_flow_stack.emplace_back(InteractionFrame{id,
                                                       std::move(invocation),
                                                       std::move(program_reference),
                                                       {first_interaction_instruction(*program),
                                                        InteractionFallbackStage::SelectedProgram,
                                                        InteractionExecutionOutcome::Pending},
                                                       ResumeRoomDestination{room->room}});
    m_state.m_mode = FlowMode{};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::call_child(const SceneId& scene,
                                                   FlowFramePosition caller_next_position)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    const auto* definition = m_project.find_scene(scene);
    auto position = validate_position(m_state.m_flow_stack.back(), caller_next_position);
    if (definition == nullptr || !position)
        return fail(definition == nullptr ? execution_error("execution.invalid_target",
                                                            "Child Scene target is missing")
                                          : position.error());
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));

    const FlowFrameId id{m_state.m_next_frame_id};
    FlowFrame child =
        SceneFrame{id, scene, {first_scene_step(*definition), {}}, CallerDestination{}};
    assign_position(m_state.m_flow_stack.back(), std::move(caller_next_position));
    ++m_state.m_next_frame_id;
    m_state.m_flow_stack.push_back(std::move(child));
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::call_child(const DialogueId& dialogue,
                                                   std::optional<DialogueBlockId> start_block,
                                                   FlowFramePosition caller_next_position)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    const auto* definition = m_project.find_dialogue(dialogue);
    auto position = validate_position(m_state.m_flow_stack.back(), caller_next_position);
    if (definition == nullptr || !position)
        return fail(definition == nullptr ? execution_error("execution.invalid_target",
                                                            "Child Dialogue target is missing")
                                          : position.error());
    const DialogueBlockId block = start_block ? *start_block : definition->program.entry_block_id;
    if (!has_dialogue_block(*definition, block))
        return fail(execution_error("execution.invalid_dialogue_position",
                                    "Child Dialogue start block is missing"));
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));

    const FlowFrameId id{m_state.m_next_frame_id};
    FlowFrame child = DialogueFrame{
        id,
        dialogue,
        {block, std::nullopt, std::nullopt, DialogueFramePosition::Stage::EnterBlock, 0},
        CallerDestination{}};
    assign_position(m_state.m_flow_stack.back(), std::move(caller_next_position));
    ++m_state.m_next_frame_id;
    m_state.m_flow_stack.push_back(std::move(child));
    return Result<void, Diagnostics>::success();
}

void FlowExecutor::clear_blocker_for(const FlowFrameId& owner) noexcept
{
    if (m_state.m_blocker && flow_blocker_owner(*m_state.m_blocker) == owner)
        m_state.m_blocker.reset();
}

bool& FlowExecutor::running_flag() noexcept { return m_state.m_flow_running; }

Result<void, Diagnostics> FlowExecutor::return_from_flow()
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    if (!std::holds_alternative<FlowMode>(m_state.m_mode) || m_state.m_flow_stack.empty())
        return fail(
            execution_error("execution.invalid_mode", "Return requires an active flow frame"));
    const auto destination = flow_return_destination(m_state.m_flow_stack.back());
    if (std::holds_alternative<CallerDestination>(destination)) {
        if (m_state.m_flow_stack.size() < 2)
            return fail(execution_error("execution.invalid_return",
                                        "Caller destination requires a caller frame"));
        clear_blocker_for(flow_frame_id(m_state.m_flow_stack.back()));
        m_state.m_flow_stack.pop_back();
        return Result<void, Diagnostics>::success();
    }
    if (const auto* room = std::get_if<ResumeRoomDestination>(&destination)) {
        clear_blocker_for(flow_frame_id(m_state.m_flow_stack.back()));
        m_state.m_flow_stack.clear();
        m_state.m_mode = RoomMode{room->room};
        return Result<void, Diagnostics>::success();
    }
    return fail(execution_error("execution.invalid_root_return",
                                "Return is invalid for a NoReturn root frame"));
}

Result<void, Diagnostics> FlowExecutor::replace_with_scene(const SceneId& scene)
{
    const auto* definition = m_project.find_scene(scene);
    if (definition == nullptr)
        return fail(execution_error("execution.invalid_target", "Scene target is missing"));
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));
    const auto destination = flow_return_destination(m_state.m_flow_stack.back());
    const auto old_id = flow_frame_id(m_state.m_flow_stack.back());
    const FlowFrameId id{m_state.m_next_frame_id++};
    m_state.m_flow_stack.back() =
        SceneFrame{id, scene, {first_scene_step(*definition), {}}, destination};
    clear_blocker_for(old_id);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::replace_with_dialogue(const DialogueId& dialogue)
{
    const auto* definition = m_project.find_dialogue(dialogue);
    if (definition == nullptr)
        return fail(execution_error("execution.invalid_target", "Dialogue target is missing"));
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));
    const auto destination = flow_return_destination(m_state.m_flow_stack.back());
    const auto old_id = flow_frame_id(m_state.m_flow_stack.back());
    const FlowFrameId id{m_state.m_next_frame_id++};
    m_state.m_flow_stack.back() =
        DialogueFrame{id,
                      dialogue,
                      {definition->program.entry_block_id, std::nullopt, std::nullopt,
                       DialogueFramePosition::Stage::EnterBlock, 0},
                      destination};
    clear_blocker_for(old_id);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::replace_with_room(const RoomId& room)
{
    if (m_project.find_room(room) == nullptr)
        return fail(execution_error("execution.invalid_target", "Room target is missing"));
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));
    std::optional<RoomId> source;
    if (!m_state.m_flow_stack.empty()) {
        const auto& root_destination = flow_return_destination(m_state.m_flow_stack.front());
        if (const auto* resume = std::get_if<ResumeRoomDestination>(&root_destination))
            source = resume->room;
    }
    const auto first_stage =
        source ? RoomTransitionStage::SourceCanLeave : RoomTransitionStage::TargetCanEnter;
    const FlowFrameId id{m_state.m_next_frame_id++};
    m_state.m_flow_stack.clear();
    m_state.m_blocker.reset();
    m_state.m_flow_stack.emplace_back(RoomTransitionFrame{
        id, source, room, std::nullopt, {first_stage, 0}, NoReturnDestination{}});
    m_state.m_mode = FlowMode{};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::apply_target(const FlowTarget& target)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    if (!std::holds_alternative<FlowMode>(m_state.m_mode) || m_state.m_flow_stack.empty())
        return fail(execution_error("execution.invalid_mode",
                                    "Terminal target requires an active flow frame"));
    return std::visit(
        [this](const auto& value) -> Result<void, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneId>)
                return replace_with_scene(value);
            else if constexpr (std::is_same_v<T, DialogueId>)
                return replace_with_dialogue(value);
            else if constexpr (std::is_same_v<T, RoomId>)
                return replace_with_room(value);
            else if constexpr (std::is_same_v<T, ReturnFlow>)
                return return_from_flow();
            else {
                m_state.m_flow_stack.clear();
                m_state.m_blocker.reset();
                m_state.m_mode = EndedMode{};
                return Result<void, Diagnostics>::success();
            }
        },
        target);
}

Result<void, Diagnostics> FlowExecutor::start_navigation(const RoomId& target,
                                                         const compiled::RoomExitRef& selected_exit)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    const auto* source_mode = std::get_if<RoomMode>(&m_state.m_mode);
    const auto* source = source_mode == nullptr ? nullptr : m_project.find_room(source_mode->room);
    const auto* target_room = m_project.find_room(target);
    if (source == nullptr || target_room == nullptr || !m_state.m_flow_stack.empty() ||
        selected_exit.room != source_mode->room)
        return Result<void, Diagnostics>::failure(
            execution_error("execution.invalid_navigation",
                            "Navigation requires a valid exit from the active Room"));
    const auto found =
        std::find_if(source->exits.begin(), source->exits.end(),
                     [&selected_exit, &target](const compiled::RoomExit& exit) {
                         return exit.id == selected_exit.exit_id && exit.target == target;
                     });
    if (found == source->exits.end())
        return Result<void, Diagnostics>::failure(execution_error(
            "execution.invalid_navigation", "Selected Room exit does not lead to the target Room"));
    if (m_state.m_next_frame_id == std::numeric_limits<std::uint64_t>::max())
        return fail(
            execution_error("execution.frame_id_exhausted", "Flow frame IDs are exhausted"));
    const FlowFrameId id{m_state.m_next_frame_id++};
    m_state.m_flow_stack.emplace_back(RoomTransitionFrame{id,
                                                          source_mode->room,
                                                          target,
                                                          selected_exit,
                                                          {RoomTransitionStage::SourceCanLeave, 0},
                                                          NoReturnDestination{}});
    m_state.m_mode = FlowMode{};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::advance_room_transition(RoomTransitionStage stage,
                                                                std::size_t next_effect)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back());
    if (transition == nullptr || stage > RoomTransitionStage::Complete)
        return fail(execution_error("execution.invalid_room_transition_position",
                                    "Room transition position is invalid for the active frame"));
    const auto current = transition->position.stage;
    RoomTransitionStage expected = current;
    switch (current) {
    case RoomTransitionStage::SourceCanLeave:
        expected = transition->selected_exit ? RoomTransitionStage::ExitCondition
                                             : RoomTransitionStage::TargetCanEnter;
        break;
    case RoomTransitionStage::ExitCondition:
        expected = RoomTransitionStage::TargetCanEnter;
        break;
    case RoomTransitionStage::TargetCanEnter:
        expected = transition->source_room ? RoomTransitionStage::BeforeLeave
                                           : RoomTransitionStage::BeforeEnter;
        break;
    case RoomTransitionStage::BeforeLeave:
        expected = RoomTransitionStage::BeforeEnter;
        break;
    case RoomTransitionStage::BeforeEnter:
        expected = RoomTransitionStage::CommitRoomSwitch;
        break;
    case RoomTransitionStage::CommitRoomSwitch:
        expected = transition->source_room ? RoomTransitionStage::AfterLeave
                                           : RoomTransitionStage::AfterEnter;
        break;
    case RoomTransitionStage::AfterLeave:
        expected = RoomTransitionStage::AfterEnter;
        break;
    case RoomTransitionStage::AfterEnter:
        expected = RoomTransitionStage::Complete;
        break;
    case RoomTransitionStage::Complete:
        expected = RoomTransitionStage::Complete;
        break;
    }
    const auto current_effect_count = room_hook_effect_count(m_project, *transition, current);
    const bool current_is_effect_stage = current == RoomTransitionStage::BeforeLeave ||
                                         current == RoomTransitionStage::BeforeEnter ||
                                         current == RoomTransitionStage::AfterLeave ||
                                         current == RoomTransitionStage::AfterEnter;
    const bool same_effect_stage = stage == current && current_is_effect_stage &&
                                   next_effect == transition->position.next_effect + 1 &&
                                   next_effect <= current_effect_count;
    const bool can_leave_stage =
        !current_is_effect_stage || transition->position.next_effect == current_effect_count;
    if (!same_effect_stage && (!can_leave_stage || stage != expected || next_effect != 0))
        return fail(execution_error("execution.invalid_room_transition_position",
                                    "Room transition stages must advance in lifecycle order"));
    transition->position = {stage, next_effect};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::reject_room_transition()
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    const auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back());
    if (transition == nullptr || transition->position.stage > RoomTransitionStage::TargetCanEnter)
        return fail(execution_error("execution.invalid_room_rejection",
                                    "Room transition can be rejected only before hooks or commit"));
    if (!transition->source_room)
        return fail(execution_error("execution.room_rejection_without_source",
                                    "Rejected Room transition has no Room to resume"));
    const RoomId source = *transition->source_room;
    m_state.m_flow_stack.clear();
    m_state.m_blocker.reset();
    m_state.m_mode = RoomMode{source};
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::complete_room_transition()
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    const auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back());
    if (transition == nullptr || transition->position.stage != RoomTransitionStage::Complete)
        return fail(execution_error("execution.incomplete_room_transition",
                                    "Room mode begins only after all transition stages complete"));
    const RoomId target = transition->target_room;
    m_state.m_flow_stack.clear();
    m_state.m_blocker.reset();
    m_state.m_mode = RoomMode{target};
    return Result<void, Diagnostics>::success();
}

Result<FlowBlocker, Diagnostics> FlowExecutor::block_top(FlowBlockerKind kind)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return Result<FlowBlocker, Diagnostics>::failure(ready.error());
    if (kind > FlowBlockerKind::Script ||
        m_state.m_next_blocker_handle == std::numeric_limits<std::uint64_t>::max())
        return Result<FlowBlocker, Diagnostics>::failure(
            execution_error("execution.invalid_blocker", "Flow blocker cannot be allocated"));
    const auto owner = flow_frame_id(m_state.m_flow_stack.back());
    const auto handle = m_state.m_next_blocker_handle++;
    FlowBlocker blocker = [&]() -> FlowBlocker {
        switch (kind) {
        case FlowBlockerKind::Input:
            return InputFlowBlocker{owner, InputFlowBlockerHandle{handle}};
        case FlowBlockerKind::Duration:
            return DurationFlowBlocker{owner, DurationFlowBlockerHandle{handle}};
        case FlowBlockerKind::Presentation:
            return PresentationFlowBlocker{owner, PresentationFlowBlockerHandle{handle}};
        case FlowBlockerKind::Audio:
            return AudioFlowBlocker{owner, AudioFlowBlockerHandle{handle}};
        case FlowBlockerKind::Script:
            return ScriptFlowBlocker{owner, ScriptInvocationHandle{handle}};
        }
        return InputFlowBlocker{owner, InputFlowBlockerHandle{handle}};
    }();
    m_state.m_blocker = blocker;
    return Result<FlowBlocker, Diagnostics>::success(std::move(blocker));
}

Result<FlowBlocker, Diagnostics> FlowExecutor::block_duration(DurationWait duration)
{
    auto blocker = block_top(FlowBlockerKind::Duration);
    auto* value = blocker.value_if();
    if (value == nullptr)
        return blocker;
    auto* typed = std::get_if<DurationFlowBlocker>(value);
    if (typed == nullptr) {
        m_state.m_blocker.reset();
        return Result<FlowBlocker, Diagnostics>::failure(execution_error(
            "execution.invalid_blocker", "Duration wait did not allocate a Duration blocker"));
    }
    typed->remaining = duration.duration();
    m_state.m_blocker = *typed;
    return blocker;
}

Result<bool, Diagnostics>
FlowExecutor::advance_duration_blocker(const FlowFrameId& owner,
                                       const DurationFlowBlockerHandle& handle,
                                       std::chrono::milliseconds elapsed)
{
    if (m_state.m_execution_fault)
        return Result<bool, Diagnostics>::failure(*m_state.m_execution_fault);
    if (elapsed.count() < 0)
        return Result<bool, Diagnostics>::failure(execution_error(
            "execution.invalid_wait_elapsed", "Duration wait elapsed time cannot be negative"));
    auto* blocker =
        m_state.m_blocker ? std::get_if<DurationFlowBlocker>(&*m_state.m_blocker) : nullptr;
    if (blocker == nullptr || blocker->owner != owner || blocker->handle != handle)
        return Result<bool, Diagnostics>::failure(execution_error(
            "execution.stale_blocker", "Duration wait update does not match the active blocker"));
    if (elapsed >= blocker->remaining) {
        m_state.m_blocker.reset();
        return Result<bool, Diagnostics>::success(true);
    }
    blocker->remaining -= elapsed;
    return Result<bool, Diagnostics>::success(false);
}

Result<void, Diagnostics> FlowExecutor::validate_blocker(const FlowFrameId& owner,
                                                         const AnyFlowBlockerHandle& handle) const
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    if (!m_state.m_blocker || flow_blocker_owner(*m_state.m_blocker) != owner ||
        flow_blocker_handle(*m_state.m_blocker) != handle)
        return Result<void, Diagnostics>::failure(execution_error(
            "execution.stale_blocker", "Blocker does not match the active frame and operation"));
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::resume_blocker(const FlowFrameId& owner,
                                                       const AnyFlowBlockerHandle& handle)
{
    auto valid = validate_blocker(owner, handle);
    if (!valid)
        return valid;
    m_state.m_blocker.reset();
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::cancel_blocker(const FlowFrameId& owner,
                                                       const AnyFlowBlockerHandle& handle)
{
    return resume_blocker(owner, handle);
}

Result<void, Diagnostics> FlowExecutor::advance_scene(const SceneId& scene,
                                                      const SceneStepId& expected_step,
                                                      SceneFramePosition next_position)
{
    auto ready = ensure_flow_ready();
    if (!ready)
        return fail(ready.error());
    auto* frame = std::get_if<SceneFrame>(&m_state.m_flow_stack.back());
    if (frame == nullptr || frame->scene != scene || frame->position.next_step != expected_step)
        return fail(execution_error("execution.stale_scene_position",
                                    "Scene advancement does not match the active step"));
    auto valid = validate_position(*frame, FlowFramePosition{next_position});
    if (!valid)
        return fail(valid.error());
    frame->position = std::move(next_position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::mark_scene_wait(const SceneId& scene,
                                                        const SceneStepId& expected_step,
                                                        SceneStepSubstate substate)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    auto* frame = !m_state.m_flow_stack.empty()
                      ? std::get_if<SceneFrame>(&m_state.m_flow_stack.back())
                      : nullptr;
    if (frame == nullptr || frame->scene != scene || frame->position.next_step != expected_step ||
        !m_state.m_blocker || flow_blocker_owner(*m_state.m_blocker) != frame->frame_id)
        return fail(execution_error("execution.invalid_scene_wait",
                                    "Scene wait does not match the active step and blocker"));
    SceneFramePosition position{expected_step, std::move(substate)};
    auto valid = validate_position(*frame, FlowFramePosition{position});
    if (!valid)
        return fail(valid.error());
    frame->position = std::move(position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::choose_scene_option(const FlowFrameId& owner,
                                                            const InputFlowBlockerHandle& handle,
                                                            const SceneChoiceOptionId& option)
{
    if (m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(*m_state.m_execution_fault);
    auto* blocker =
        m_state.m_blocker ? std::get_if<InputFlowBlocker>(&*m_state.m_blocker) : nullptr;
    auto* frame = !m_state.m_flow_stack.empty()
                      ? std::get_if<SceneFrame>(&m_state.m_flow_stack.back())
                      : nullptr;
    const auto* choice_state = m_state.m_active_choice
                                   ? std::get_if<SceneChoiceState>(&*m_state.m_active_choice)
                                   : nullptr;
    if (blocker == nullptr || blocker->owner != owner || blocker->handle != handle ||
        frame == nullptr || frame->frame_id != owner || !frame->position.next_step ||
        !std::holds_alternative<SceneChoiceSelectionPosition>(frame->position.substate) ||
        choice_state == nullptr || choice_state->scene != frame->scene ||
        choice_state->step != *frame->position.next_step)
        return Result<void, Diagnostics>::failure(execution_error(
            "execution.stale_scene_choice", "Scene choice does not match the active selection"));
    const auto selected = std::find_if(choice_state->options.begin(), choice_state->options.end(),
                                       [&option](const SceneChoiceOptionState& candidate) {
                                           return candidate.option == option && candidate.enabled;
                                       });
    if (selected == choice_state->options.end())
        return Result<void, Diagnostics>::failure(execution_error(
            "execution.invalid_scene_choice", "Scene choice option is missing or disabled"));
    SceneFramePosition position{frame->position.next_step,
                                SceneChoiceEffectPosition{option, 0, false}};
    auto valid = validate_position(*frame, FlowFramePosition{position});
    if (!valid)
        return fail(valid.error());
    m_state.m_blocker.reset();
    m_state.m_active_choice.reset();
    frame->position = std::move(position);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> FlowExecutor::fault(Diagnostics diagnostics)
{
    return fail(std::move(diagnostics));
}

Result<void, Diagnostics> FlowExecutor::begin_run()
{
    auto& running = running_flag();
    if (running)
        return fail(execution_error("execution.non_reentrant",
                                    "Flow execution cannot be entered recursively"));
    running = true;
    return Result<void, Diagnostics>::success();
}

void FlowExecutor::end_run() noexcept { running_flag() = false; }

FlowRunOutcome FlowExecutor::run_until_blocked(std::size_t instruction_budget)
{
    auto& running = running_flag();
    if (running) {
        auto diagnostics = execution_error("execution.non_reentrant",
                                           "Flow execution cannot be entered recursively");
        m_state.m_execution_fault = diagnostics;
        return FlowFaultOutcome{std::move(diagnostics)};
    }
    struct RunningGuard {
        bool& running;
        ~RunningGuard() { running = false; }
    } guard{running};
    running = true;

    if (m_state.m_execution_fault)
        return FlowFaultOutcome{*m_state.m_execution_fault};
    if (m_state.m_blocker)
        return FlowBlockedOutcome{*m_state.m_blocker};
    if (!std::holds_alternative<FlowMode>(m_state.m_mode))
        return FlowModeChangedOutcome{m_state.m_mode};
    if (instruction_budget == 0)
        return FlowBudgetYieldOutcome{0};
    if (m_state.m_flow_stack.empty()) {
        auto diagnostics =
            execution_error("execution.invalid_stack", "Flow mode requires a non-empty flow stack");
        m_state.m_execution_fault = diagnostics;
        return FlowFaultOutcome{std::move(diagnostics)};
    }

    auto diagnostics = execution_error(
        "execution.feature_not_migrated",
        "The active typed frame is not executable until its owning Phase 7 feature migration");
    m_state.m_execution_fault = diagnostics;
    return FlowFaultOutcome{std::move(diagnostics)};
}

Result<void, Diagnostics> FlowExecutor::discard_fault()
{
    if (!m_state.m_execution_fault)
        return Result<void, Diagnostics>::failure(
            execution_error("execution.not_faulted", "Flow execution is not faulted"));
    if (m_state.m_flow_stack.empty()) {
        m_state.m_execution_fault.reset();
        m_state.m_blocker.reset();
        if (std::holds_alternative<FlowMode>(m_state.m_mode))
            m_state.m_mode = EndedMode{};
        return Result<void, Diagnostics>::success();
    }

    if (const auto* transition = std::get_if<RoomTransitionFrame>(&m_state.m_flow_stack.back())) {
        const bool committed = transition->position.stage > RoomTransitionStage::CommitRoomSwitch;
        const std::optional<RoomId> destination =
            committed ? std::optional<RoomId>{transition->target_room} : transition->source_room;
        m_state.m_flow_stack.clear();
        m_state.m_blocker.reset();
        m_state.m_execution_fault.reset();
        m_state.m_mode =
            destination ? RuntimeMode{RoomMode{*destination}} : RuntimeMode{EndedMode{}};
        return Result<void, Diagnostics>::success();
    }

    const auto root_destination = flow_return_destination(m_state.m_flow_stack.front());
    const auto* resume = std::get_if<ResumeRoomDestination>(&root_destination);
    m_state.m_flow_stack.clear();
    m_state.m_blocker.reset();
    m_state.m_execution_fault.reset();
    m_state.m_mode = resume ? RuntimeMode{RoomMode{resume->room}} : RuntimeMode{EndedMode{}};
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
