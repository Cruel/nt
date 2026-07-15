#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"

#include <chrono>

namespace noveltea::core {

struct RuntimeClockUpdate {
    std::chrono::microseconds sanitized_host_delta{0};
    std::chrono::microseconds unscaled_presentation_delta{0};
    std::chrono::microseconds unscaled_presentation_time{0};
    std::chrono::microseconds gameplay_delta{0};
    std::chrono::microseconds gameplay_time{0};
    bool gameplay_paused = false;
    bool host_delta_clamped = false;

    auto operator<=>(const RuntimeClockUpdate&) const = default;
};

[[nodiscard]] Result<RuntimeClockUpdate, Diagnostic>
advance_runtime_clock(RuntimeClockUpdate previous, double host_delta_seconds, bool gameplay_paused,
                      bool host_suspended);

class RuntimeClock {
public:
    [[nodiscard]] Result<RuntimeClockUpdate, Diagnostic>
    advance(double host_delta_seconds, bool gameplay_paused, bool host_suspended);

    void reset() noexcept;
    [[nodiscard]] const RuntimeClockUpdate& current() const noexcept { return m_current; }

private:
    RuntimeClockUpdate m_current{};
};

} // namespace noveltea::core
