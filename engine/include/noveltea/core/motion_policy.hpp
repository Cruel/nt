#pragma once

#include <cmath>
#include <cstdint>
#include <optional>
#include <string>

namespace noveltea::core {

enum class LayoutClockDomain : std::uint8_t {
    Gameplay,
    UnscaledPresentation
};
enum class MotionRepeat : std::uint8_t {
    Once,
    Loop
};
struct MotionLoopRange {
    std::string start;
    std::string end;
    bool operator==(const MotionLoopRange&) const = default;
};
struct MotionPlaybackPolicy {
    MotionRepeat repeat = MotionRepeat::Loop;
    double rate = 1.0;
    LayoutClockDomain clock = LayoutClockDomain::Gameplay;
    std::optional<std::string> initial_marker;
    std::optional<MotionLoopRange> loop_range = std::nullopt;
    bool operator==(const MotionPlaybackPolicy&) const = default;
};
[[nodiscard]] inline bool valid_motion_policy(const MotionPlaybackPolicy& policy) noexcept
{
    return (policy.repeat == MotionRepeat::Once || policy.repeat == MotionRepeat::Loop) &&
           std::isfinite(policy.rate) && policy.rate > 0.0 &&
           (policy.clock == LayoutClockDomain::Gameplay ||
            policy.clock == LayoutClockDomain::UnscaledPresentation) &&
           (!policy.initial_marker || !policy.initial_marker->empty()) &&
           (!policy.loop_range ||
            (policy.repeat == MotionRepeat::Loop && !policy.loop_range->start.empty() &&
             !policy.loop_range->end.empty()));
}

} // namespace noveltea::core
