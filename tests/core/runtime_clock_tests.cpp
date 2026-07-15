#include "noveltea/core/runtime_clock.hpp"

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <limits>

using namespace std::chrono_literals;

TEST_CASE("runtime clock sanitizes and clamps host delta")
{
    noveltea::core::RuntimeClock clock;

    const auto negative = clock.advance(-1.0, false, false);
    REQUIRE(negative);
    CHECK(negative.value().sanitized_host_delta == 0us);
    CHECK_FALSE(negative.value().host_delta_clamped);

    const auto infinite = clock.advance(std::numeric_limits<double>::infinity(), false, false);
    REQUIRE(infinite);
    CHECK(infinite.value().sanitized_host_delta == 0us);

    const auto nan = clock.advance(std::nan(""), false, false);
    REQUIRE(nan);
    CHECK(nan.value().sanitized_host_delta == 0us);

    const auto clamped = clock.advance(2.0, false, false);
    REQUIRE(clamped);
    CHECK(clamped.value().sanitized_host_delta == 250ms);
    CHECK(clamped.value().host_delta_clamped);
}

TEST_CASE("runtime clock advances gameplay and unscaled domains independently")
{
    noveltea::core::RuntimeClock clock;
    REQUIRE(clock.advance(0.1, false, false));

    const auto paused = clock.advance(0.05, true, false);
    REQUIRE(paused);
    CHECK(paused.value().unscaled_presentation_delta == 50ms);
    CHECK(paused.value().unscaled_presentation_time == 150ms);
    CHECK(paused.value().gameplay_delta == 0us);
    CHECK(paused.value().gameplay_time == 100ms);
    CHECK(paused.value().gameplay_paused);

    const auto resumed = clock.advance(0.025, false, false);
    REQUIRE(resumed);
    CHECK(resumed.value().gameplay_time == 125ms);
    CHECK(resumed.value().unscaled_presentation_time == 175ms);
}

TEST_CASE("runtime clock freezes both domains during host suspension")
{
    noveltea::core::RuntimeClock clock;
    REQUIRE(clock.advance(0.1, false, false));
    const auto suspended = clock.advance(0.2, false, true);
    REQUIRE(suspended);
    CHECK(suspended.value().sanitized_host_delta == 200ms);
    CHECK(suspended.value().unscaled_presentation_delta == 0us);
    CHECK(suspended.value().gameplay_delta == 0us);
    CHECK(suspended.value().unscaled_presentation_time == 100ms);
    CHECK(suspended.value().gameplay_time == 100ms);
    CHECK(suspended.value().gameplay_paused);
}

TEST_CASE("runtime clock duration advancement is frame-rate independent")
{
    noveltea::core::RuntimeClock hundred_hz;
    noveltea::core::RuntimeClock ten_hz;
    for (int frame = 0; frame < 100; ++frame)
        REQUIRE(hundred_hz.advance(0.01, false, false));
    for (int frame = 0; frame < 10; ++frame)
        REQUIRE(ten_hz.advance(0.1, false, false));

    CHECK(hundred_hz.current().gameplay_time == 1s);
    CHECK(ten_hz.current().gameplay_time == 1s);
}

TEST_CASE("runtime clock reports overflow without wrapping")
{
    noveltea::core::RuntimeClockUpdate previous{
        .unscaled_presentation_time =
            std::chrono::microseconds{std::numeric_limits<std::int64_t>::max() - 10},
        .gameplay_time = std::chrono::microseconds{100},
    };
    const auto result = noveltea::core::advance_runtime_clock(previous, 0.001, false, false);
    REQUIRE_FALSE(result);
    CHECK(result.error().code == "runtime.clock_time_overflow");
}
