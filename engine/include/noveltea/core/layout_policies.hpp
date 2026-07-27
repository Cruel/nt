#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/presentation_contracts.hpp"

namespace noveltea::core {

[[nodiscard]] inline MountedLayoutPolicy reserved_layout_policy(compiled::LayoutSlot slot,
                                                                bool visible = true) noexcept
{
    const PresentationPlane plane = slot == compiled::LayoutSlot::Overlay
                                        ? PresentationPlane::WorldOverlay
                                        : PresentationPlane::GameUi;
    return MountedLayoutPolicy{.plane = plane,
                               .local_order = 0,
                               .clock = LayoutClockDomain::Gameplay,
                               .input = LayoutInputMode::Normal,
                               .gameplay_pause = GameplayPausePolicy::Continue,
                               .visibility =
                                   visible ? LayoutVisibility::Visible : LayoutVisibility::Hidden,
                               .escape_dismissal = EscapeDismissalPolicy::Ignore,
                               .entrance_operation = std::nullopt,
                               .exit_operation = std::nullopt};
}

[[nodiscard]] inline MountedLayoutPolicy room_overlay_policy(std::int32_t order,
                                                             bool visible) noexcept
{
    return MountedLayoutPolicy{.plane = PresentationPlane::WorldOverlay,
                               .local_order = order,
                               .clock = LayoutClockDomain::Gameplay,
                               .input = LayoutInputMode::None,
                               .gameplay_pause = GameplayPausePolicy::Continue,
                               .visibility =
                                   visible ? LayoutVisibility::Visible : LayoutVisibility::Hidden,
                               .escape_dismissal = EscapeDismissalPolicy::Ignore,
                               .entrance_operation = std::nullopt,
                               .exit_operation = std::nullopt};
}

} // namespace noveltea::core
