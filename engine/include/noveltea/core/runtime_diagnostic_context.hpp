#pragma once

#include "noveltea/core/domain_ids.hpp"
#include "noveltea/core/flow.hpp"

#include <compare>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <variant>

namespace noveltea::core {

enum class RoomHookKind : std::uint8_t {
    CanLeave,
    CanEnter,
    BeforeLeave,
    BeforeEnter,
    AfterLeave,
    AfterEnter
};

struct SceneRuntimeContext {
    SceneId scene;
    std::optional<SceneStepId> step;
    auto operator<=>(const SceneRuntimeContext&) const = default;
};
struct DialogueRuntimeContext {
    DialogueId dialogue;
    DialogueBlockId block;
    std::optional<DialogueSegmentId> segment;
    std::optional<DialogueEdgeId> edge;
    auto operator<=>(const DialogueRuntimeContext&) const = default;
};
struct RoomRuntimeContext {
    RoomId room;
    std::optional<RoomHookKind> hook;
    std::optional<RoomExitId> exit;
    auto operator<=>(const RoomRuntimeContext&) const = default;
};
struct InteractionRuntimeContext {
    InteractionId interaction;
    InteractionRuleId rule;
    std::optional<InteractionInstructionId> instruction;
    auto operator<=>(const InteractionRuntimeContext&) const = default;
};
struct FlowFrameRuntimeContext {
    FlowFrameId frame;
    auto operator<=>(const FlowFrameRuntimeContext&) const = default;
};
struct ScriptRuntimeContext {
    ScriptId script;
    auto operator<=>(const ScriptRuntimeContext&) const = default;
};
struct PlaybackRuntimeContext {
    std::size_t step_index = 0;
    auto operator<=>(const PlaybackRuntimeContext&) const = default;
};
enum class RuntimeHostOperationKind : std::uint8_t {
    Presentation,
    Audio
};
struct HostOperationRuntimeContext {
    RuntimeHostOperationKind kind;
    std::uint64_t operation = 0;
    auto operator<=>(const HostOperationRuntimeContext&) const = default;
};

using RuntimeDiagnosticContextValue =
    std::variant<SceneRuntimeContext, DialogueRuntimeContext, RoomRuntimeContext,
                 InteractionRuntimeContext, FlowFrameRuntimeContext, ScriptRuntimeContext,
                 PlaybackRuntimeContext, HostOperationRuntimeContext>;

struct RuntimeDiagnosticContext {
    RuntimeDiagnosticContextValue value;
    bool operator==(const RuntimeDiagnosticContext&) const = default;
};

} // namespace noveltea::core
