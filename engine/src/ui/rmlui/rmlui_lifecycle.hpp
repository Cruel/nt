#pragma once

#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/runtime_clock.hpp"

#include <chrono>
#include <cstdint>

namespace noveltea::ui::rmlui {

struct LifecycleCompatibilityKey {
    core::PresentationPlane plane = core::PresentationPlane::GameUi;
    core::LayoutClockDomain clock = core::LayoutClockDomain::Gameplay;
    core::LayoutInputMode input = core::LayoutInputMode::Normal;
    auto operator<=>(const LifecycleCompatibilityKey&) const = default;
};

struct LifecycleContextKey {
    core::PresentationPlane plane = core::PresentationPlane::GameUi;
    std::uint32_t composition_group = 0;
    core::LayoutClockDomain clock = core::LayoutClockDomain::Gameplay;
    core::LayoutInputMode input = core::LayoutInputMode::Normal;
    core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay;
    auto operator<=>(const LifecycleContextKey&) const = default;
};

[[nodiscard]] inline LifecycleCompatibilityKey
lifecycle_compatibility(const core::MountedLayoutPolicy& policy) noexcept
{
    return {policy.plane, policy.clock, policy.input};
}

[[nodiscard]] inline bool stops_lower_presentation_input(core::LayoutInputMode mode,
                                                         bool consumed) noexcept
{
    return consumed || mode == core::LayoutInputMode::Modal;
}

[[nodiscard]] inline std::chrono::microseconds domain_time(const core::RuntimeClockUpdate& clocks,
                                                           core::LayoutClockDomain domain) noexcept
{
    return domain == core::LayoutClockDomain::Gameplay ? clocks.gameplay_time
                                                       : clocks.unscaled_presentation_time;
}

} // namespace noveltea::ui::rmlui
