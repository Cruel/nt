#pragma once

#include "noveltea/core/save_state_codec_port.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime/runtime_world.hpp"

#include <cstddef>
#include <optional>
#include <variant>

namespace noveltea::core {

struct FlowBlockedOutcome {
    FlowBlocker blocker;
};
struct FlowModeChangedOutcome {
    RuntimeMode mode;
};
struct FlowBudgetYieldOutcome {
    std::size_t executed_units;
};
struct FlowPresentationBoundaryOutcome {};
struct FlowFaultOutcome {
    Diagnostics diagnostics;
};
using FlowRunOutcome =
    std::variant<FlowBlockedOutcome, FlowModeChangedOutcome, FlowBudgetYieldOutcome,
                 FlowPresentationBoundaryOutcome, FlowFaultOutcome>;

class FlowExecutor {
public:
    struct ExecutionContext {
        RuntimeMode mode;
        FlowStack flow_stack;
        std::optional<FlowBlocker> blocker;
        std::optional<Diagnostics> execution_fault;
        bool running = false;
        bool detached = false;
    };

    FlowExecutor(const CompiledProject& project, SessionState& state) noexcept
        : m_project(project), m_state(state), m_standalone_world(std::in_place, project, state),
          m_world(&*m_standalone_world)
    {
    }
    FlowExecutor(const CompiledProject& project, SessionState& state,
                 runtime::RuntimeWorld& world) noexcept
        : m_project(project), m_state(state), m_world(&world)
    {
    }
    FlowExecutor(const FlowExecutor&) = delete;
    FlowExecutor& operator=(const FlowExecutor&) = delete;
    FlowExecutor(FlowExecutor&&) = delete;
    FlowExecutor& operator=(FlowExecutor&&) = delete;

    [[nodiscard]] static Result<SessionState, Diagnostics>
    restore_session(const CompiledProject& project, const SaveState& save,
                    const SaveStateCodecPort& save_codec);

    [[nodiscard]] Result<void, Diagnostics> start_transient(const SceneId& scene);
    [[nodiscard]] Result<void, Diagnostics> start_transient(const DialogueId& dialogue);
    [[nodiscard]] Result<void, Diagnostics>
    start_detached(const SceneId& scene, std::vector<compiled::SceneInputBinding> inputs);
    [[nodiscard]] Result<void, Diagnostics>
    start_interaction(InteractionInvocationContext invocation, InteractionProgramRef program);

    [[nodiscard]] Result<void, Diagnostics> call_child(const SceneId& scene,
                                                       FlowFramePosition caller_next_position);
    [[nodiscard]] Result<void, Diagnostics>
    call_child(const SceneId& scene, std::vector<compiled::SceneInputBinding> inputs,
               FlowFramePosition caller_next_position);
    [[nodiscard]] Result<void, Diagnostics> call_child(const DialogueId& dialogue,
                                                       std::optional<DialogueBlockId> start_block,
                                                       FlowFramePosition caller_next_position);
    [[nodiscard]] Result<void, Diagnostics> return_from_flow();
    [[nodiscard]] Result<void, Diagnostics>
    return_from_scene(std::optional<SceneOutcomeId> outcome);
    [[nodiscard]] Result<void, Diagnostics>
    apply_scene_terminal(const compiled::SceneTerminal& terminal);
    [[nodiscard]] Result<void, Diagnostics> apply_target(const FlowTarget& target);

    [[nodiscard]] Result<void, Diagnostics>
    start_navigation(const RoomId& target, const compiled::RoomExitRef& selected_exit);
    [[nodiscard]] Result<void, Diagnostics> advance_room_transition(RoomTransitionStage stage,
                                                                    std::size_t next_effect = 0);
    [[nodiscard]] Result<void, Diagnostics>
    advance_room_transition(const RoomTransitionPosition& expected_position,
                            RoomTransitionPosition next_position);
    [[nodiscard]] Result<void, Diagnostics>
    mark_room_transition_wait(const RoomTransitionPosition& expected_position,
                              RoomTransitionPosition next_position);
    [[nodiscard]] Result<void, Diagnostics> reject_room_transition();
    [[nodiscard]] Result<void, Diagnostics> complete_room_transition();

    [[nodiscard]] Result<FlowBlocker, Diagnostics> block_top(FlowBlockerKind kind);
    [[nodiscard]] Result<FlowBlocker, Diagnostics> block_duration(DurationWait duration);
    [[nodiscard]] Result<bool, Diagnostics>
    advance_duration_blocker(const FlowFrameId& owner, const DurationFlowBlockerHandle& handle,
                             std::chrono::milliseconds elapsed);
    [[nodiscard]] Result<void, Diagnostics>
    validate_blocker(const FlowFrameId& owner, const AnyFlowBlockerHandle& handle) const;
    [[nodiscard]] Result<void, Diagnostics> resume_blocker(const FlowFrameId& owner,
                                                           const AnyFlowBlockerHandle& handle);
    [[nodiscard]] Result<void, Diagnostics> cancel_blocker(const FlowFrameId& owner,
                                                           const AnyFlowBlockerHandle& handle);

    [[nodiscard]] Result<void, Diagnostics> advance_scene(const SceneId& scene,
                                                          const SceneStepId& expected_step,
                                                          SceneFramePosition next_position);
    [[nodiscard]] Result<void, Diagnostics> mark_scene_wait(const SceneId& scene,
                                                            const SceneStepId& expected_step,
                                                            SceneStepSubstate substate);
    [[nodiscard]] Result<void, Diagnostics> mark_scene_stage_initialized(const SceneId& scene);
    [[nodiscard]] Result<void, Diagnostics>
    choose_scene_option(const FlowFrameId& owner, const InputFlowBlockerHandle& handle,
                        const SceneChoiceOptionId& option);
    [[nodiscard]] Result<void, Diagnostics>
    advance_dialogue(const DialogueId& dialogue, const DialogueFramePosition& expected_position,
                     DialogueFramePosition next_position);
    [[nodiscard]] Result<void, Diagnostics>
    mark_dialogue_wait(const DialogueId& dialogue, const DialogueFramePosition& expected_position,
                       DialogueFramePosition next_position);
    [[nodiscard]] Result<void, Diagnostics>
    apply_dialogue_cues(const DialogueId& dialogue, const DialogueFramePosition& expected_position,
                        const std::optional<CharacterId>& speaker,
                        const std::vector<compiled::DialogueSemanticCue>& cues);
    [[nodiscard]] Result<void, Diagnostics>
    advance_dialogue_reveal(const DialogueId& dialogue,
                            const DialogueFramePosition& expected_position, std::size_t next_cue,
                            std::uint64_t reveal_offset);
    [[nodiscard]] Result<AudioFlowBlockerHandle, Diagnostics> allocate_audio_completion_handle();
    [[nodiscard]] Result<PresentationFlowBlockerHandle, Diagnostics>
    allocate_presentation_completion_handle();
    [[nodiscard]] Result<void, Diagnostics>
    choose_dialogue_option(const FlowFrameId& owner, const InputFlowBlockerHandle& handle,
                           const DialogueEdgeId& edge);
    [[nodiscard]] Result<void, Diagnostics>
    advance_interaction(const InteractionFramePosition& expected_position,
                        InteractionProgramRef next_program, InteractionFramePosition next_position);
    [[nodiscard]] Result<void, Diagnostics>
    mark_interaction_wait(const InteractionFramePosition& expected_position,
                          InteractionFramePosition next_position);
    [[nodiscard]] Result<void, Diagnostics> fault(Diagnostics diagnostics);
    [[nodiscard]] Result<void, Diagnostics> begin_run();
    void end_run() noexcept;

    [[nodiscard]] FlowRunOutcome run_until_blocked(std::size_t instruction_budget);
    [[nodiscard]] Result<void, Diagnostics> discard_fault();
    [[nodiscard]] Result<void, Diagnostics> discard_detached();
    [[nodiscard]] ExecutionContext take_execution_context() noexcept;
    void install_execution_context(ExecutionContext context) noexcept;

private:
    friend struct FlowExecutorTestAccess;

    [[nodiscard]] Result<void, Diagnostics> fail(Diagnostics diagnostics);
    [[nodiscard]] Result<void, Diagnostics> ensure_flow_ready() const;
    [[nodiscard]] Result<void, Diagnostics>
    validate_position(const FlowFrame& frame, const FlowFramePosition& position) const;
    [[nodiscard]] Result<void, Diagnostics>
    replace_with_scene(const SceneId& scene, std::vector<compiled::SceneInputBinding> inputs = {});
    [[nodiscard]] Result<void, Diagnostics> replace_with_dialogue(const DialogueId& dialogue);
    [[nodiscard]] Result<void, Diagnostics> replace_with_room(const RoomId& room);
    [[nodiscard]] const compiled::RoomDefinition*
    room_definition(const RoomId& room) const noexcept;
    [[nodiscard]] const compiled::CharacterDefinition*
    character_definition(const CharacterId& character) const noexcept;
    [[nodiscard]] const compiled::InteractableDefinition*
    interactable_definition(const InteractableId& interactable) const noexcept;
    [[nodiscard]] const compiled::FeatureDefinition*
    feature_definition(const FeatureRef& feature) const noexcept;
    void clear_blocker_for(const FlowFrameId& owner) noexcept;
    [[nodiscard]] bool& running_flag() noexcept;

    const CompiledProject& m_project;
    SessionState& m_state;
    std::optional<runtime::RuntimeWorld> m_standalone_world;
    runtime::RuntimeWorld* m_world;
};

} // namespace noveltea::core
