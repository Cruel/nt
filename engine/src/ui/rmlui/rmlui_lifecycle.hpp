#pragma once

#include "noveltea/core/presentation_contracts.hpp"
#include "noveltea/core/runtime_clock.hpp"

#include <chrono>
#include <cstdint>
#include <tuple>

namespace noveltea::ui::rmlui {

enum class LayoutScaleDomain : std::uint8_t {
    UiInheritTextInherit,
    UiInheritTextIgnore,
    UiIgnoreTextInherit,
    UiIgnoreTextIgnore,
};

[[nodiscard]] constexpr LayoutScaleDomain
layout_scale_domain(core::LayoutScalePolicy policy) noexcept
{
    if (policy.ui == core::LayoutScaleInheritance::Inherit) {
        return policy.text == core::LayoutScaleInheritance::Inherit
                   ? LayoutScaleDomain::UiInheritTextInherit
                   : LayoutScaleDomain::UiInheritTextIgnore;
    }
    return policy.text == core::LayoutScaleInheritance::Inherit
               ? LayoutScaleDomain::UiIgnoreTextInherit
               : LayoutScaleDomain::UiIgnoreTextIgnore;
}

[[nodiscard]] constexpr LayoutScaleDomain
resolve_layout_scale_domain(core::LayoutScalePolicy policy,
                            const core::LayoutScaleOverrides& overrides) noexcept
{
    return layout_scale_domain(core::apply_layout_scale_overrides(policy, overrides));
}

[[nodiscard]] constexpr bool inherits_ui_scale(LayoutScaleDomain domain) noexcept
{
    return domain == LayoutScaleDomain::UiInheritTextInherit ||
           domain == LayoutScaleDomain::UiInheritTextIgnore;
}

[[nodiscard]] constexpr bool inherits_text_scale(LayoutScaleDomain domain) noexcept
{
    return domain == LayoutScaleDomain::UiInheritTextInherit ||
           domain == LayoutScaleDomain::UiIgnoreTextInherit;
}

struct LifecycleCompatibilityKey {
    core::PresentationPlane plane = core::PresentationPlane::GameUi;
    core::LayoutClockDomain clock = core::LayoutClockDomain::Gameplay;
    core::LayoutInputMode input = core::LayoutInputMode::Normal;
    LayoutScaleDomain scale_domain = LayoutScaleDomain::UiInheritTextInherit;
    bool operator==(const LifecycleCompatibilityKey&) const = default;
};

struct LifecycleContextKey {
    core::PresentationPlane plane = core::PresentationPlane::GameUi;
    std::uint32_t composition_group = 0;
    core::LayoutClockDomain clock = core::LayoutClockDomain::Gameplay;
    core::LayoutInputMode input = core::LayoutInputMode::Normal;
    core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay;
    LayoutScaleDomain scale_domain = LayoutScaleDomain::UiInheritTextInherit;
    std::uint32_t compatibility_group = 0;
    bool operator==(const LifecycleContextKey&) const = default;
};

[[nodiscard]] constexpr LifecycleContextKey
make_lifecycle_context_key(const core::MountedLayoutPolicy& policy, std::uint32_t composition_group,
                           core::MountedLayoutOwner owner, core::LayoutScalePolicy scale_policy,
                           std::uint32_t compatibility_group) noexcept
{
    return {.plane = policy.plane,
            .composition_group = composition_group,
            .clock = policy.clock,
            .input = policy.input,
            .owner = owner,
            .scale_domain = layout_scale_domain(scale_policy),
            .compatibility_group = compatibility_group};
}

[[nodiscard]] inline LifecycleCompatibilityKey lifecycle_compatibility(
    const core::MountedLayoutPolicy& policy,
    LayoutScaleDomain scale_domain = LayoutScaleDomain::UiInheritTextInherit) noexcept
{
    return {policy.plane, policy.clock, policy.input, scale_domain};
}

[[nodiscard]] inline bool
lifecycle_context_presentation_less(const LifecycleContextKey& lhs,
                                    const LifecycleContextKey& rhs) noexcept
{
    return std::tie(lhs.plane, lhs.compatibility_group, lhs.composition_group, lhs.clock, lhs.input,
                    lhs.owner) < std::tie(rhs.plane, rhs.compatibility_group, rhs.composition_group,
                                          rhs.clock, rhs.input, rhs.owner);
}

[[nodiscard]] constexpr bool
is_world_transition_source_context(const LifecycleContextKey& key,
                                   std::uint32_t source_composition_group) noexcept
{
    return key.plane == core::PresentationPlane::WorldOverlay &&
           key.composition_group == source_composition_group;
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
