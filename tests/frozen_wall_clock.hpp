#pragma once

#include "noveltea/script/wall_clock.hpp"

#include <chrono>

namespace noveltea::test_support {

class FrozenWallClock final : public script::WallClock {
public:
    std::int64_t epoch = 1709164800; // 2024-02-29 00:00:00 UTC.
    int offset_seconds = 19800;

    std::int64_t now() const noexcept override { return epoch; }
    bool calendar(std::int64_t time, bool utc, std::tm& result) const noexcept override
    {
        return script::system_wall_clock().calendar(time + (utc ? 0 : offset_seconds), true,
                                                    result);
    }
    bool local_time(std::tm& value, std::int64_t& time) const noexcept override
    {
        using namespace std::chrono;
        const auto date = year(value.tm_year + 1900) / January / 1;
        const auto month_start = date + months(value.tm_mon);
        time = duration_cast<seconds>(sys_days(month_start).time_since_epoch()).count() +
               std::int64_t(value.tm_mday - 1) * 86400 + std::int64_t(value.tm_hour) * 3600 +
               std::int64_t(value.tm_min) * 60 + value.tm_sec - offset_seconds;
        return calendar(time, false, value);
    }
};

} // namespace noveltea::test_support
