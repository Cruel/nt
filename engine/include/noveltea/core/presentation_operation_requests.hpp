#pragma once

#include "noveltea/core/presentation_operation_contracts.hpp"
#include "noveltea/core/result.hpp"

namespace noveltea::core {

[[nodiscard]] FinitePresentationOperationTarget
operation_target(const FinitePresentationOperation& operation);
[[nodiscard]] bool operation_skippable(const FinitePresentationOperation& operation) noexcept;

[[nodiscard]] Result<PresentationTargetDraft, Diagnostics>
build_transition_group_target(const PresentationTargetDraft& source,
                              const std::vector<TransitionGroupTargetMutation>& mutations);

} // namespace noveltea::core
