#pragma once

#include "noveltea/core/feature_state.hpp"

#include <cstdint>
#include <limits>

namespace noveltea::host {

using LayoutCompositionGroup = std::uint32_t;
using LayoutContextCompatibilityGroup = std::uint32_t;

inline constexpr LayoutCompositionGroup kWorldTransitionSourceCompositionGroup =
    std::numeric_limits<LayoutCompositionGroup>::max();

[[nodiscard]] constexpr LayoutCompositionGroup
layout_composition_group(core::PresentationCompositionGroup group) noexcept
{
    return static_cast<LayoutCompositionGroup>(group);
}

static_assert(layout_composition_group(core::PresentationCompositionGroup::Debug) <
              kWorldTransitionSourceCompositionGroup);

} // namespace noveltea::host
