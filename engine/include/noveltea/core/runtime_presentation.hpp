#pragma once

#include "noveltea/core/result.hpp"
#include "noveltea/core/room_presentation_contracts.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"

#include <optional>

namespace noveltea::core {

class SessionState;

class PresentationProjector {
public:
    [[nodiscard]] static Result<RuntimePresentationSnapshot, Diagnostics>
    project(const CompiledProject& project, const SessionState& state,
            const ResolvedRoomPresentation* room_presentation = nullptr);
};

class RuntimePresentationSnapshotPublisher {
public:
    [[nodiscard]] Result<bool, Diagnostics>
    reproject(const CompiledProject& project, const SessionState& state,
              const ResolvedRoomPresentation* room_presentation = nullptr);
    [[nodiscard]] const RuntimePresentationSnapshot* published() const noexcept;

private:
    std::optional<RuntimePresentationSnapshot> m_published;
};

} // namespace noveltea::core
