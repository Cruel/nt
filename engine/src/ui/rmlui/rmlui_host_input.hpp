#pragma once

#include "noveltea/surface.hpp"

#include <SDL3/SDL_events.h>

namespace noveltea::ui::rmlui {

// Produces a fresh SDL event whose pointer fields encode the supplied reference point in one
// specific RmlUi context's logical coordinate system.
[[nodiscard]] SDL_Event
project_pointer_event_to_context(const SDL_Event& event, Vec2 reference_pointer,
                                 const PresentationTransform& transform,
                                 const ResolvedContextMetrics& context) noexcept;

} // namespace noveltea::ui::rmlui
