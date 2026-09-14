#pragma once

#include <cstdint>
#include <ctime>

namespace noveltea::script {

// Calendar conversion owns timezone/DST policy; it must not change process-global TZ or locale.
class WallClock {
public:
    virtual ~WallClock() = default;
    [[nodiscard]] virtual std::int64_t now() const noexcept = 0;
    [[nodiscard]] virtual bool calendar(std::int64_t epoch, bool utc,
                                        std::tm& result) const noexcept = 0;
    // Normalize local calendar fields in place, including weekday, year day, and DST.
    [[nodiscard]] virtual bool local_time(std::tm& calendar,
                                          std::int64_t& epoch) const noexcept = 0;
};

[[nodiscard]] const WallClock& system_wall_clock() noexcept;

} // namespace noveltea::script
