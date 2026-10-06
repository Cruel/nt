#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/presentation_operation_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"

namespace noveltea::core {

[[nodiscard]] FinitePresentationOperationTarget
operation_target(const FinitePresentationOperation& operation);
[[nodiscard]] bool operation_skippable(const FinitePresentationOperation& operation) noexcept;
[[nodiscard]] bool motion_target_occurrence_matches(
    const std::optional<ResolvedRoomInteractableOccurrenceId>& occurrence,
    const std::optional<InteractableMotionOperationOccurrence>& target) noexcept;
[[nodiscard]] const compiled::Visual*
motion_target_visual(const RuntimePresentationSnapshot& snapshot,
                     const MotionOperationTarget& target) noexcept;
[[nodiscard]] compiled::Visual* motion_target_visual(RuntimePresentationSnapshot& snapshot,
                                                     const MotionOperationTarget& target) noexcept;

[[nodiscard]] Result<CameraFocusCapture, Diagnostics>
capture_camera_focus(const CompiledProject& project, const RuntimePresentationSnapshot& snapshot,
                     const CameraFocusSource& source);

[[nodiscard]] Result<PresentationTargetDraft, Diagnostics>
build_transition_group_target(const PresentationTargetDraft& source,
                              const std::vector<TransitionGroupTargetMutation>& mutations);

} // namespace noveltea::core
