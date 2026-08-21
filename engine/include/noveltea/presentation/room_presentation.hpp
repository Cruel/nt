#pragma once

#include "noveltea/core/room_presentation_contracts.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime/runtime_world.hpp"

#include <functional>
#include <string>
#include <string_view>

namespace noveltea::core {

class RoomPresentationResolverCore final {
public:
    [[nodiscard]] Result<RoomPresentationResolution, Diagnostics>
    resolve(const RoomPresentationDefinitionView& definition,
            const RoomPresentationStateView& state, const RoomVisitContext& visit,
            RoomPresentationConditionTokenEvaluator evaluate,
            RoomPresentationTextTokenResolver resolve_text,
            RoomCompositionCallback* composition = nullptr,
            const compiled::RoomCompositionHook* composition_hook = nullptr) const;
};

class RoomPresentationResolver final {
public:
    [[nodiscard]] Result<RoomPresentationResolution, Diagnostics>
    resolve(const CompiledProject& project, const runtime::RuntimeWorld& world,
            const SessionState& state, const RoomVisitContext& visit,
            RoomPresentationConditionEvaluator evaluate, RoomPresentationTextResolver resolve_text,
            RoomCompositionCallback* composition = nullptr) const;
};

[[nodiscard]] Result<PreparedRoomNavigationTarget, Diagnostics> prepare_room_navigation_target(
    const CompiledProject& project, const runtime::RuntimeWorld& world,
    const SessionState& settled_state, const RoomNavigationPreparationInput& input,
    RoomPresentationConditionEvaluator evaluate, RoomPresentationTextResolver resolve_text,
    RoomCompositionCallback* composition = nullptr);

} // namespace noveltea::core
