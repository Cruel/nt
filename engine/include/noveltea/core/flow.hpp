#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <chrono>
#include <compare>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <variant>
#include <vector>

namespace noveltea::core {

class FlowExecutor;

class FlowFrameId {
public:
    FlowFrameId() = delete;
    [[nodiscard]] std::uint64_t number() const noexcept { return m_value; }
    auto operator<=>(const FlowFrameId&) const = default;

private:
    friend class FlowExecutor;
    friend class SessionState;
    explicit FlowFrameId(std::uint64_t value) noexcept : m_value(value) {}
    std::uint64_t m_value;
};

struct CallerDestination {};
struct ResumeRoomDestination {
    RoomId room;
};
struct NoReturnDestination {};
using ReturnDestination =
    std::variant<CallerDestination, ResumeRoomDestination, NoReturnDestination>;

struct SceneStepReady {};
struct SceneInstructionCompletionPosition {
    std::optional<SceneStepId> next_step;
    bool autosave_safe_point = false;
};
struct SceneAutosavePendingPosition {
    SceneStepId completed_step;
    std::optional<SceneStepId> next_step;
};
struct SceneChoiceSelectionPosition {};
struct SceneChoiceEffectPosition {
    SceneChoiceOptionId option;
    std::size_t next_effect = 0;
    bool awaiting_completion = false;
};
using SceneStepSubstate =
    std::variant<SceneStepReady, SceneInstructionCompletionPosition, SceneAutosavePendingPosition,
                 SceneChoiceSelectionPosition, SceneChoiceEffectPosition>;
struct SceneFramePosition {
    std::optional<SceneStepId> next_step;
    SceneStepSubstate substate = SceneStepReady{};
};

struct DialogueFramePosition {
    DialogueBlockId block;
    std::optional<DialogueSegmentId> segment;
    std::optional<DialogueEdgeId> edge;
    enum class Stage : std::uint8_t {
        EnterBlock,
        PresentSegment,
        ApplySegmentEffects,
        PresentChoices,
        ApplyChoiceEffects,
        FollowEdge,
        Complete
    } stage = Stage::EnterBlock;
    std::size_t next_effect = 0;
};

struct InteractionInvocationContext {
    VerbId verb;
    std::optional<RoomId> room;
    std::vector<InteractableId> operands;
};
struct InteractionRuleProgramRef {
    InteractionId interaction;
    InteractionRuleId rule;
};
struct VerbDefaultProgramRef {
    VerbId verb;
};
using InteractionProgramRef = std::variant<InteractionRuleProgramRef, VerbDefaultProgramRef>;
enum class InteractionFallbackStage : std::uint8_t {
    SelectedProgram,
    ParentVerb,
    UndefinedInteraction,
    Complete
};
enum class InteractionExecutionOutcome : std::uint8_t {
    Pending,
    Handled,
    Unhandled,
    Failed
};
struct InteractionFramePosition {
    std::optional<InteractionInstructionId> next_instruction;
    InteractionFallbackStage fallback_stage = InteractionFallbackStage::SelectedProgram;
    InteractionExecutionOutcome outcome = InteractionExecutionOutcome::Pending;
};

enum class RoomTransitionStage : std::uint8_t {
    SourceCanLeave,
    ExitCondition,
    TargetCanEnter,
    BeforeLeave,
    BeforeEnter,
    CommitRoomSwitch,
    AfterLeave,
    AfterEnter,
    Complete
};
struct RoomTransitionPosition {
    RoomTransitionStage stage = RoomTransitionStage::SourceCanLeave;
    std::size_t next_effect = 0;
};

using FlowFramePosition = std::variant<SceneFramePosition, DialogueFramePosition,
                                       InteractionFramePosition, RoomTransitionPosition>;

struct SceneFrame {
    FlowFrameId frame_id;
    SceneId scene;
    SceneFramePosition position;
    ReturnDestination destination;
};
struct DialogueFrame {
    FlowFrameId frame_id;
    DialogueId dialogue;
    DialogueFramePosition position;
    ReturnDestination destination;
};
struct InteractionFrame {
    FlowFrameId frame_id;
    InteractionInvocationContext invocation;
    InteractionProgramRef program;
    InteractionFramePosition position;
    ReturnDestination destination;
};
struct RoomTransitionFrame {
    FlowFrameId frame_id;
    std::optional<RoomId> source_room;
    RoomId target_room;
    std::optional<compiled::RoomExitRef> selected_exit;
    RoomTransitionPosition position;
    ReturnDestination destination = NoReturnDestination{};
};
using FlowFrame = std::variant<SceneFrame, DialogueFrame, InteractionFrame, RoomTransitionFrame>;
using FlowStack = std::vector<FlowFrame>;

[[nodiscard]] const FlowFrameId& flow_frame_id(const FlowFrame& frame) noexcept;
[[nodiscard]] const ReturnDestination& flow_return_destination(const FlowFrame& frame) noexcept;
[[nodiscard]] FlowFramePosition flow_frame_position(const FlowFrame& frame);

template<class Tag> class FlowBlockerHandle {
public:
    FlowBlockerHandle() = delete;
    [[nodiscard]] std::uint64_t number() const noexcept { return m_value; }
    auto operator<=>(const FlowBlockerHandle&) const = default;

private:
    friend class FlowExecutor;
    explicit FlowBlockerHandle(std::uint64_t value) noexcept : m_value(value) {}
    std::uint64_t m_value;
};

struct InputFlowBlockerTag;
struct DurationFlowBlockerTag;
struct PresentationFlowBlockerTag;
struct AudioFlowBlockerTag;
using InputFlowBlockerHandle = FlowBlockerHandle<InputFlowBlockerTag>;
using DurationFlowBlockerHandle = FlowBlockerHandle<DurationFlowBlockerTag>;
using PresentationFlowBlockerHandle = FlowBlockerHandle<PresentationFlowBlockerTag>;
using AudioFlowBlockerHandle = FlowBlockerHandle<AudioFlowBlockerTag>;
using AnyFlowBlockerHandle =
    std::variant<InputFlowBlockerHandle, DurationFlowBlockerHandle, PresentationFlowBlockerHandle,
                 AudioFlowBlockerHandle, ScriptInvocationHandle>;

enum class FlowBlockerKind : std::uint8_t {
    Input,
    Duration,
    Presentation,
    Audio,
    Script
};
struct InputFlowBlocker {
    FlowFrameId owner;
    InputFlowBlockerHandle handle;
};
struct DurationFlowBlocker {
    FlowFrameId owner;
    DurationFlowBlockerHandle handle;
    std::chrono::milliseconds remaining{0};
};
struct PresentationFlowBlocker {
    FlowFrameId owner;
    PresentationFlowBlockerHandle handle;
};
struct AudioFlowBlocker {
    FlowFrameId owner;
    AudioFlowBlockerHandle handle;
};
struct ScriptFlowBlocker {
    FlowFrameId owner;
    ScriptInvocationHandle handle;
};
using FlowBlocker = std::variant<InputFlowBlocker, DurationFlowBlocker, PresentationFlowBlocker,
                                 AudioFlowBlocker, ScriptFlowBlocker>;

[[nodiscard]] const FlowFrameId& flow_blocker_owner(const FlowBlocker& blocker) noexcept;
[[nodiscard]] AnyFlowBlockerHandle flow_blocker_handle(const FlowBlocker& blocker);
[[nodiscard]] FlowBlockerKind flow_blocker_kind(const FlowBlocker& blocker) noexcept;

} // namespace noveltea::core
