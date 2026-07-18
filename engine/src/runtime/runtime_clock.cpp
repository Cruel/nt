#include "noveltea/core/runtime_clock.hpp"

#include <cmath>
#include <cstdint>
#include <limits>

namespace noveltea::core {
namespace {

constexpr auto max_host_delta = std::chrono::milliseconds{250};

[[nodiscard]] bool would_overflow(std::chrono::microseconds time,
                                  std::chrono::microseconds delta) noexcept
{
    return delta.count() > std::numeric_limits<std::int64_t>::max() - time.count();
}

} // namespace

Result<RuntimeClockUpdate, Diagnostic> advance_runtime_clock(RuntimeClockUpdate previous,
                                                             double host_delta_seconds,
                                                             bool gameplay_paused,
                                                             bool host_suspended)
{
    bool clamped = false;
    std::chrono::microseconds host_delta{0};
    if (std::isfinite(host_delta_seconds) && host_delta_seconds > 0.0) {
        constexpr double microseconds_per_second = 1'000'000.0;
        const double requested_microseconds = host_delta_seconds * microseconds_per_second;
        const auto maximum = std::chrono::duration_cast<std::chrono::microseconds>(max_host_delta);
        if (!std::isfinite(requested_microseconds) ||
            requested_microseconds >= static_cast<double>(maximum.count())) {
            host_delta = maximum;
            clamped = requested_microseconds > static_cast<double>(maximum.count());
        } else {
            host_delta =
                std::chrono::microseconds{static_cast<std::int64_t>(requested_microseconds)};
        }
    }

    const auto unscaled_delta = host_suspended ? std::chrono::microseconds{0} : host_delta;
    const bool gameplay_time_paused = gameplay_paused || host_suspended;
    const auto gameplay_delta = gameplay_time_paused ? std::chrono::microseconds{0} : host_delta;
    if (would_overflow(previous.unscaled_presentation_time, unscaled_delta) ||
        would_overflow(previous.gameplay_time, gameplay_delta)) {
        return Result<RuntimeClockUpdate, Diagnostic>::failure(Diagnostic{
            "runtime.clock_time_overflow", "Runtime clock absolute time would overflow."});
    }

    RuntimeClockUpdate next{
        .sanitized_host_delta = host_delta,
        .unscaled_presentation_delta = unscaled_delta,
        .unscaled_presentation_time = previous.unscaled_presentation_time + unscaled_delta,
        .gameplay_delta = gameplay_delta,
        .gameplay_time = previous.gameplay_time + gameplay_delta,
        .gameplay_paused = gameplay_time_paused,
        .host_delta_clamped = clamped,
    };
    return Result<RuntimeClockUpdate, Diagnostic>::success(next);
}

Result<RuntimeClockUpdate, Diagnostic>
RuntimeClock::advance(double host_delta_seconds, bool gameplay_paused, bool host_suspended)
{
    auto next =
        advance_runtime_clock(m_current, host_delta_seconds, gameplay_paused, host_suspended);
    if (const auto* value = next.value_if())
        m_current = *value;
    return next;
}

void RuntimeClock::reset() noexcept { m_current = {}; }

} // namespace noveltea::core
