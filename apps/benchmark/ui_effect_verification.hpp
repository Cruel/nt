#pragma once

#include "reference_scene.hpp"
#include "noveltea/ui_render_configuration.hpp"

#include <string>

namespace noveltea::benchmark {

// A benchmark is not successful if a requested effect was optimized out,
// ignored by CSS parsing, or never reached a renderer callback. These
// counters are evidence of backend submission, not GPU-side execution.
[[nodiscard]] inline bool verify_ui_effect_activity(const UiEffectCounts& requested,
                                                    const UiEffectActivity& observed,
                                                    std::string& reason)
{
    if (observed.backend_errors > 0)
        reason = "RmlUi backend reported errors while rendering requested effects";
    else if (requested.clipping && observed.clipping_calls == 0)
        reason = "unsupported RmlUi feature: clipping generated no backend calls";
    else if (requested.transforms && observed.transforms == 0)
        reason = "unsupported RmlUi feature: transforms generated no backend calls";
    else if (requested.gradients && observed.gradient_draws == 0)
        reason = "unsupported RmlUi feature: gradients generated no backend draws";
    else if (requested.filters && observed.filtered_composites == 0)
        reason = "unsupported RmlUi feature: filters generated no filtered composites";
    else if (requested.masks && observed.mask_saves == 0)
        reason = "unsupported RmlUi feature: masks generated no saved masks";
    else if (requested.nested_layers && observed.max_layer_depth < 2)
        reason = "unsupported RmlUi feature: nested layers were not observed";
    else
        return true;
    return false;
}

} // namespace noveltea::benchmark
