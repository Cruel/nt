#include "noveltea/script/wall_clock.hpp"

#include <cerrno>
#include <utility>

namespace noveltea::script {
namespace {

class SystemWallClock final : public WallClock {
public:
    std::int64_t now() const noexcept override
    {
        return static_cast<std::int64_t>(std::time(nullptr));
    }

    bool calendar(std::int64_t epoch, bool utc, std::tm& result) const noexcept override
    {
        if (!std::in_range<std::time_t>(epoch))
            return false;
        const auto time = static_cast<std::time_t>(epoch);
#ifdef _WIN32
        return (utc ? gmtime_s(&result, &time) : localtime_s(&result, &time)) == 0;
#else
        return (utc ? gmtime_r(&time, &result) : localtime_r(&time, &result)) != nullptr;
#endif
    }

    bool local_time(std::tm& calendar, std::int64_t& epoch) const noexcept override
    {
        errno = 0;
        const auto time = std::mktime(&calendar);
        if (time == static_cast<std::time_t>(-1) && errno != 0)
            return false;
        epoch = static_cast<std::int64_t>(time);
        return true;
    }
};

} // namespace

const WallClock& system_wall_clock() noexcept
{
    static const SystemWallClock clock;
    return clock;
}

} // namespace noveltea::script
