#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/flow.hpp"

#include <algorithm>
#include <cstddef>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::runtime {

enum class FlowPredictionConfidence : std::uint8_t {
    Expected,
    Alternative,
};

enum class FlowPredictionRootKind : std::uint8_t {
    FlowExecution,
    DetachedFlowExecution,
    ProspectiveRoomEntry,
    ResidentRoomContext,
};

struct FlowPredictionProvenance {
    // Semantic execution points traversed to reach the dependency. Keep this projection in domain
    // terms rather than leaking generated slice indexes to runtime/tooling consumers.
    std::vector<core::compiled::FlowPredictionPoint> points;
    FlowPredictionRootKind root_kind = FlowPredictionRootKind::FlowExecution;
    std::optional<core::RoomId> room;
    std::optional<core::RoomExitId> exit;
    // Present only when this path was introduced by authored supplemental intent. Automatic and
    // authored paths may coexist for the same effective dependency and are deduplicated later by
    // the speculative planner while retaining both provenance records.
    std::optional<std::string> supplemental_hint_id;

    bool operator==(const FlowPredictionProvenance&) const = default;
};

struct FlowPredictionProjectionEntry {
    core::compiled::FlowPredictionDependency dependency;
    std::size_t execution_distance = 0;
    FlowPredictionConfidence confidence = FlowPredictionConfidence::Expected;
    // Dependencies emitted by one execution slice share an order. This preserves semantic slice
    // order while still allowing the planner to sub-rank dependencies within that slice.
    std::size_t execution_order = 0;
    std::size_t dependency_priority = 0;
    FlowPredictionProvenance provenance;
};

struct FlowPredictionOpaqueFrontier {
    core::compiled::FlowPredictionPoint attachment_point;
    FlowPredictionProvenance provenance;

    bool operator==(const FlowPredictionOpaqueFrontier&) const = default;
};

struct FlowPredictionContextRequirements {
    // Global comparisons need the current typed value so deterministic projection can continue
    // through later writes. Other admitted pure typed leaves only need their authoritative
    // boolean result. Lua predicates are intentionally never requested here.
    std::vector<core::PropertyId> global_properties;
    std::vector<core::Condition> condition_facts;
};

// Read-only tooling/runtime view over one prediction root. It intentionally exposes semantic
// dependencies and distance, not the generated index's serialized storage representation.
struct FlowPredictionProjection {
    std::vector<FlowPredictionProjectionEntry> entries;
    std::vector<FlowPredictionOpaqueFrontier> opaque_frontiers;
    FlowPredictionContextRequirements context_requirements;
    core::Diagnostics diagnostics;
};

struct FlowPredictionGlobalProperty {
    core::PropertyId property;
    core::RuntimeValue value;
    bool operator==(const FlowPredictionGlobalProperty&) const = default;
};

struct FlowPredictionConditionFact {
    core::Condition condition;
    bool value = false;
    bool operator==(const FlowPredictionConditionFact&) const = default;
};

struct ProspectiveRoomEntryPredictionRoot {
    std::optional<core::RoomId> source_room;
    core::RoomId target_room;
    std::optional<core::RoomExitId> source_exit = std::nullopt;
    std::optional<core::Condition> source_can_leave = std::nullopt;
    std::optional<core::Condition> exit_condition = std::nullopt;
    std::optional<core::Condition> target_can_enter = std::nullopt;
    bool source_can_leave_hook_opaque = false;
    bool target_can_enter_hook_opaque = false;
    bool operator==(const ProspectiveRoomEntryPredictionRoot&) const = default;
};

struct ActiveScenePredictionRoot {
    core::SceneId scene;
    core::SceneFramePosition position;
};

struct ActiveDialoguePredictionRoot {
    core::DialogueId dialogue;
    core::DialogueFramePosition position;
};

struct ActiveInteractionPredictionRoot {
    core::InteractionProgramRef program;
    core::InteractionFramePosition position;
    std::vector<core::InteractionSubjectBinding> interaction_bindings;
    std::vector<core::CommandResultBinding> command_results;
    // Authoritative facts evaluated in this invocation's concrete slot/result binding context.
    // They are deliberately scoped to this root so they cannot leak into unrelated prediction.
    std::vector<FlowPredictionConditionFact> condition_facts;
    bool operator==(const ActiveInteractionPredictionRoot&) const = default;
};

struct ActiveRoomTransitionPredictionRoot {
    std::optional<core::RoomId> source_room;
    core::RoomId target_room;
    std::optional<core::RoomExitId> source_exit;
    core::RoomTransitionStage stage = core::RoomTransitionStage::SourceCanLeave;
    std::optional<core::InteractionInstructionId> command_id;
    bool awaiting_completion = false;
    std::vector<core::CommandResultBinding> command_results;
    std::vector<FlowPredictionConditionFact> condition_facts;
    bool operator==(const ActiveRoomTransitionPredictionRoot&) const = default;
};

// Deliberately narrow authoritative state supplied to speculative prediction. This is not a
// Runtime Session clone and grows only when prediction-relevant typed facts or navigation context
// need admission.
struct FlowPredictionContext {
    std::optional<core::RoomId> current_room;
    std::vector<FlowPredictionGlobalProperty> global_properties;
    std::vector<FlowPredictionConditionFact> condition_facts;
    std::vector<ProspectiveRoomEntryPredictionRoot> prospective_room_entries;
    std::optional<ActiveInteractionPredictionRoot> active_interaction;
    std::optional<ActiveRoomTransitionPredictionRoot> active_room_transition;
    // Awaited foreground callers below the active top frame. Their stored positions already point
    // at the continuation after the active child returns. Prediction intentionally evaluates them
    // without current authoritative facts because the child may mutate shared gameplay state.
    std::vector<ActiveScenePredictionRoot> suspended_scenes;
    std::vector<ActiveDialoguePredictionRoot> suspended_dialogues;
    std::vector<ActiveInteractionPredictionRoot> suspended_interactions;
    std::vector<ActiveRoomTransitionPredictionRoot> suspended_room_transitions;
    std::vector<ActiveScenePredictionRoot> detached_scenes;
    std::vector<ActiveDialoguePredictionRoot> detached_dialogues;
    // Awaited callers below the active top frame of a detached Flow execution. These remain
    // detached work, but resume only after that detached child returns and therefore receive an
    // additional suspension demotion in the planner.
    std::vector<ActiveScenePredictionRoot> detached_suspended_scenes;
    std::vector<ActiveDialoguePredictionRoot> detached_suspended_dialogues;
};

struct ResidentRoomPredictionRoot {
    core::RoomId room;
    std::vector<core::InteractionProgramRef> programs;
    std::vector<core::LayoutId> layouts;
    bool operator==(const ResidentRoomPredictionRoot&) const = default;
};

class FlowPredictor {
public:
    static constexpr std::size_t structural_ceiling = 4096;

    explicit FlowPredictor(const core::CompiledProject& project,
                           std::size_t traversal_limit = structural_ceiling) noexcept
        : m_project(&project), m_traversal_limit(std::min(traversal_limit, structural_ceiling))
    {
    }

    [[nodiscard]] FlowPredictionProjection predict(const core::compiled::Entrypoint& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const core::compiled::Entrypoint& root,
                                                   const FlowPredictionContext& context) const;
    [[nodiscard]] FlowPredictionProjection
    predict(const ProspectiveRoomEntryPredictionRoot& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const ProspectiveRoomEntryPredictionRoot& root,
                                                   const FlowPredictionContext& context) const;
    [[nodiscard]] FlowPredictionProjection predict(const ResidentRoomPredictionRoot& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const ResidentRoomPredictionRoot& root,
                                                   const FlowPredictionContext& context) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveScenePredictionRoot& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveScenePredictionRoot& root,
                                                   const FlowPredictionContext& context) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveDialoguePredictionRoot& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveDialoguePredictionRoot& root,
                                                   const FlowPredictionContext& context) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveRoomTransitionPredictionRoot& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveRoomTransitionPredictionRoot& root,
                                                   const FlowPredictionContext& context) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveInteractionPredictionRoot& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveInteractionPredictionRoot& root,
                                                   const FlowPredictionContext& context) const;

private:
    const core::CompiledProject* m_project;
    std::size_t m_traversal_limit = structural_ceiling;
};

} // namespace noveltea::runtime
