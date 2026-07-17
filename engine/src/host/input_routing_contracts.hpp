#pragma once

#include <array>
#include <cstdint>

namespace noveltea::host {

enum class HostInputRouteStage : std::uint8_t {
    PlatformLifecycle,
    Devtools,
    RuntimeUi,
    MountedLayoutAdmission,
    Gameplay,
};

inline constexpr std::array kHostInputRouteOrder{
    HostInputRouteStage::PlatformLifecycle, HostInputRouteStage::Devtools,
    HostInputRouteStage::RuntimeUi,         HostInputRouteStage::MountedLayoutAdmission,
    HostInputRouteStage::Gameplay,
};

struct HostInputRoutingDecision {
    bool devtools = false;
    bool runtime_ui = true;
    bool gameplay = true;
};

[[nodiscard]] constexpr HostInputRoutingDecision
evaluate_host_input_routing(bool devtools_enabled, bool runtime_ui_consumed,
                            bool mounted_layout_blocks_gameplay) noexcept
{
    return {
        .devtools = devtools_enabled,
        .runtime_ui = true,
        .gameplay = !runtime_ui_consumed && !mounted_layout_blocks_gameplay,
    };
}

} // namespace noveltea::host
