#include "noveltea/presentation/runtime_presentation_model.hpp"

#include "noveltea/presentation/presentation_operation_requests.hpp"
#include "noveltea/presentation/room_presentation.hpp"
#include "noveltea/presentation/runtime_presentation.hpp"

#include <utility>

namespace noveltea::presentation {

core::Result<core::PresentationTargetDraft, core::Diagnostics>
RuntimePresentationModel::build_transition_target(
    const core::PresentationTargetDraft& source,
    const std::vector<core::TransitionGroupTargetMutation>& mutations) const
{
    return core::build_transition_group_target(source, mutations);
}

core::Result<core::PreparedRoomNavigationTarget, core::Diagnostics>
RuntimePresentationModel::prepare_room_navigation(const core::CompiledProject& project,
                                                  const core::SessionState& settled_state,
                                                  const core::RoomNavigationPreparationInput& input,
                                                  core::RoomPresentationConditionEvaluator evaluate,
                                                  core::RoomPresentationTextResolver resolve_text,
                                                  core::RoomCompositionCallback* composition) const
{
    return core::prepare_room_navigation_target(project, settled_state, input, std::move(evaluate),
                                                std::move(resolve_text), composition);
}

core::Result<core::RoomPresentationResolution, core::Diagnostics>
RuntimePresentationModel::resolve_room(const core::CompiledProject& project,
                                       const core::SessionState& state,
                                       const core::RoomVisitContext& visit,
                                       core::RoomPresentationConditionEvaluator evaluate,
                                       core::RoomPresentationTextResolver resolve_text,
                                       core::RoomCompositionCallback* composition) const
{
    core::RoomPresentationResolver resolver;
    return resolver.resolve(project, state, visit, std::move(evaluate), std::move(resolve_text),
                            composition);
}

core::Result<core::RuntimePresentationSnapshot, core::Diagnostics>
RuntimePresentationModel::project(const core::CompiledProject& project,
                                  const core::SessionState& state,
                                  const core::ResolvedRoomPresentation* room_presentation) const
{
    return core::PresentationProjector::project(project, state, room_presentation);
}

} // namespace noveltea::presentation
