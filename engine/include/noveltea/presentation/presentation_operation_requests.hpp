#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/presentation_operation_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"

namespace noveltea::core {

[[nodiscard]] FinitePresentationOperationTarget
operation_target(const FinitePresentationOperation& operation);
[[nodiscard]] bool operation_skippable(const FinitePresentationOperation& operation) noexcept;

[[nodiscard]] Result<CameraFocusCapture, Diagnostics>
capture_camera_focus(const CompiledProject& project, const RuntimePresentationSnapshot& snapshot,
                     const CameraFocusSource& source);

[[nodiscard]] Result<CharacterGestureOperation, Diagnostics> make_character_gesture_operation(
    const CompiledProject& project, const RuntimePresentationSnapshot& snapshot,
    const ActorPresentationKey& actor, const CharacterGestureId& gesture,
    PresentationOperationId operation,
    std::optional<PresentationFlowCompletion> completion = std::nullopt, bool skippable = true);

[[nodiscard]] Result<PresentationTargetDraft, Diagnostics>
build_transition_group_target(const PresentationTargetDraft& source,
                              const std::vector<TransitionGroupTargetMutation>& mutations);

} // namespace noveltea::core
