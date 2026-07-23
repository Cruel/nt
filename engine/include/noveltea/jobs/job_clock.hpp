#pragma once

#include <chrono>

namespace noveltea::jobs {

class JobClock {
public:
    using Clock = std::chrono::steady_clock;
    using TimePoint = Clock::time_point;

    virtual ~JobClock() = default;

    [[nodiscard]] virtual TimePoint now() const noexcept = 0;
};

} // namespace noveltea::jobs
