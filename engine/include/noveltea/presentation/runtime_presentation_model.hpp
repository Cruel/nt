#pragma once

#include "noveltea/runtime/runtime_ports.hpp"

namespace noveltea::presentation {

class RuntimePresentationModel final : public runtime::PresentationModelPort {
public:
    [[nodiscard]] core::Result<core::PresentationTargetDraft, core::Diagnostics>
    build_transition_target(
        const core::PresentationTargetDraft& source,
        const std::vector<core::TransitionGroupTargetMutation>& mutations) const override;
    [[nodiscard]] core::Result<core::PreparedRoomNavigationTarget, core::Diagnostics>
    prepare_room_navigation(
        const core::CompiledProject& project, const core::SessionState& settled_state,
        const core::RoomNavigationPreparationInput& input,
        core::RoomPresentationConditionEvaluator evaluate,
        core::RoomPresentationTextResolver resolve_text,
        core::RoomCompositionCallback* composition = nullptr) const override;
    [[nodiscard]] core::Result<core::RoomPresentationResolution, core::Diagnostics>
    resolve_room(const core::CompiledProject& project, const core::SessionState& state,
                 const core::RoomVisitContext& visit,
                 core::RoomPresentationConditionEvaluator evaluate,
                 core::RoomPresentationTextResolver resolve_text,
                 core::RoomCompositionCallback* composition = nullptr) const override;
    [[nodiscard]] core::Result<core::RuntimePresentationSnapshot, core::Diagnostics>
    project(const core::CompiledProject& project, const core::SessionState& state,
            const core::ResolvedRoomPresentation* room_presentation = nullptr) const override;
};

} // namespace noveltea::presentation
