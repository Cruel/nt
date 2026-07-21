#pragma once

#include <compare>
#include <cstdint>
#include <optional>

namespace noveltea::core {

enum class LayoutScaleInheritance : std::uint8_t {
    Inherit,
    Ignore,
};

struct LayoutScalePolicy {
    LayoutScaleInheritance ui = LayoutScaleInheritance::Inherit;
    LayoutScaleInheritance text = LayoutScaleInheritance::Inherit;
    auto operator<=>(const LayoutScalePolicy&) const = default;
};

struct LayoutScaleOverrides {
    std::optional<LayoutScaleInheritance> ui;
    std::optional<LayoutScaleInheritance> text;
    auto operator<=>(const LayoutScaleOverrides&) const = default;
};

[[nodiscard]] constexpr LayoutScalePolicy
apply_layout_scale_overrides(LayoutScalePolicy policy,
                             const LayoutScaleOverrides& overrides) noexcept
{
    if (overrides.ui)
        policy.ui = *overrides.ui;
    if (overrides.text)
        policy.text = *overrides.text;
    return policy;
}

} // namespace noveltea::core
