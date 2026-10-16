#pragma once

#include <bgfx/bgfx.h>

#include <array>
#include <cstdint>

namespace noveltea::benchmark {

// View 0 clears, 2..63 belong to RmlUi preview, and view 1 is ImGui.
// The remap deliberately puts ImGui after *every* RmlUi pass, including its
// last offscreen compositing pass. This is only used outside strict sampling.
inline constexpr std::array<bgfx::ViewId, 64> kDashboardViewOrder = [] {
    std::array<bgfx::ViewId, 64> views{};
    views[0] = 0;
    for (bgfx::ViewId i = 2; i < 64; ++i)
        views[i - 1] = i;
    views.back() = 1;
    return views;
}();

inline void set_dashboard_view_order()
{
    bgfx::setViewOrder(0, static_cast<uint16_t>(kDashboardViewOrder.size()),
                       kDashboardViewOrder.data());
}

inline void reset_dashboard_view_order()
{
    bgfx::setViewOrder(0, static_cast<uint16_t>(kDashboardViewOrder.size()), nullptr);
}

} // namespace noveltea::benchmark
