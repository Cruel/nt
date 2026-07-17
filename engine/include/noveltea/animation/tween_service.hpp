#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>

namespace noveltea::animation {

enum class TweenEasing : std::uint8_t {
    Linear,
    QuadraticIn,
    QuadraticOut,
    QuadraticInOut,
    CubicIn,
    CubicOut,
    CubicInOut,
    QuarticIn,
    QuarticOut,
    QuarticInOut,
    QuinticIn,
    QuinticOut,
    QuinticInOut,
    SineIn,
    SineOut,
    SineInOut,
    ExponentialIn,
    ExponentialOut,
    ExponentialInOut,
    CircularIn,
    CircularOut,
    CircularInOut,
    BackIn,
    BackOut,
    BackInOut,
    BounceIn,
    BounceOut,
    BounceInOut,
    ElasticIn,
    ElasticOut,
    ElasticInOut,
};

struct TweenHandle {
    std::uint64_t value = 0;

    [[nodiscard]] explicit operator bool() const noexcept { return value != 0; }
    bool operator==(const TweenHandle&) const = default;
};

struct ScalarTweenSpec {
    float from = 0.0f;
    float to = 1.0f;
    std::chrono::microseconds duration{0};
    TweenEasing easing = TweenEasing::Linear;
};

struct ScalarTweenSample {
    float value = 0.0f;
    float normalized_time = 0.0f;
    bool completed = false;
    bool operator==(const ScalarTweenSample&) const = default;
};

// A backend-local interpolation primitive. It owns transient scalar values and Twink realization,
// but no gameplay state, presentation-operation identity, target pointer, or completion callback.
class TweenService {
public:
    TweenService();
    ~TweenService();

    TweenService(const TweenService&) = delete;
    TweenService& operator=(const TweenService&) = delete;
    TweenService(TweenService&&) = delete;
    TweenService& operator=(TweenService&&) = delete;

    [[nodiscard]] core::Result<TweenHandle, core::Diagnostic>
    start_scalar(const ScalarTweenSpec& spec);
    void advance(std::chrono::microseconds delta);

    [[nodiscard]] std::optional<ScalarTweenSample> sample(TweenHandle handle) const noexcept;
    [[nodiscard]] bool cancel(TweenHandle handle) noexcept;
    [[nodiscard]] bool release(TweenHandle handle) noexcept;
    void reset() noexcept;

    [[nodiscard]] std::size_t active_count() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::animation
