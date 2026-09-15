#pragma once

#include "noveltea/core/editor_runtime_protocol.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/runtime/runtime_session.hpp"

#include <vector>

namespace noveltea::core::editor {

[[nodiscard]] TypedPlaybackExpectationReport evaluate_playback_expectation(
    const TypedPlaybackExpectation& expectation, const runtime::RuntimeSession& session,
    const runtime::RuntimePublication& publication,
    const std::vector<runtime::RuntimeEvent>& events, const Diagnostics& diagnostics);

} // namespace noveltea::core::editor
