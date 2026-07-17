#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "noveltea/animation/tween_service.hpp"

#include <limits>

using namespace noveltea::animation;

TEST_CASE("TweenService advances retained scalar samples through Twink")
{
    TweenService tweens;
    const auto started =
        tweens.start_scalar({.from = 2.0f, .to = 10.0f, .duration = std::chrono::seconds{1}});
    REQUIRE(started);
    const auto handle = *started.value_if();

    tweens.advance(std::chrono::milliseconds{250});
    const auto quarter = tweens.sample(handle);
    REQUIRE(quarter);
    CHECK(quarter->value == Catch::Approx(4.0f));
    CHECK(quarter->normalized_time == Catch::Approx(0.25f));
    CHECK_FALSE(quarter->completed);

    tweens.advance(std::chrono::milliseconds{750});
    const auto complete = tweens.sample(handle);
    REQUIRE(complete);
    CHECK(complete->value == Catch::Approx(10.0f));
    CHECK(complete->normalized_time == Catch::Approx(1.0f));
    CHECK(complete->completed);
    CHECK(tweens.active_count() == 0);
    CHECK(tweens.release(handle));

    tweens.advance(std::chrono::microseconds{0});
    CHECK_FALSE(tweens.sample(handle));
}

TEST_CASE("TweenService supports independent backend-local tracks")
{
    TweenService tweens;
    const auto first =
        tweens.start_scalar({.from = 0.0f, .to = 1.0f, .duration = std::chrono::seconds{1}});
    const auto second =
        tweens.start_scalar({.from = 10.0f, .to = 20.0f, .duration = std::chrono::seconds{2}});
    REQUIRE(first);
    REQUIRE(second);

    tweens.advance(std::chrono::milliseconds{500});
    REQUIRE(tweens.sample(*first.value_if()));
    REQUIRE(tweens.sample(*second.value_if()));
    CHECK(tweens.sample(*first.value_if())->value == Catch::Approx(0.5f));
    CHECK(tweens.sample(*second.value_if())->value == Catch::Approx(12.5f));
    CHECK(tweens.active_count() == 2);

    CHECK(tweens.cancel(*first.value_if()));
    CHECK_FALSE(tweens.sample(*first.value_if()));
    CHECK(tweens.active_count() == 1);
}

TEST_CASE("TweenService rejects invalid endpoints and negative duration")
{
    TweenService tweens;
    const auto invalid_value = tweens.start_scalar({.from = std::numeric_limits<float>::infinity(),
                                                    .to = 1.0f,
                                                    .duration = std::chrono::seconds{1}});
    REQUIRE_FALSE(invalid_value);
    CHECK(invalid_value.error().code == "animation.tween_spec_invalid");

    const auto invalid_duration =
        tweens.start_scalar({.from = 0.0f, .to = 1.0f, .duration = std::chrono::microseconds{-1}});
    REQUIRE_FALSE(invalid_duration);
    CHECK(invalid_duration.error().code == "animation.tween_spec_invalid");
}

TEST_CASE("TweenService resolves zero-duration tracks without a backend tick")
{
    TweenService tweens;
    const auto started = tweens.start_scalar({.from = 3.0f, .to = 7.0f});
    REQUIRE(started);

    const auto sample = tweens.sample(*started.value_if());
    REQUIRE(sample);
    CHECK(sample->value == Catch::Approx(7.0f));
    CHECK(sample->normalized_time == Catch::Approx(1.0f));
    CHECK(sample->completed);
}

TEST_CASE("TweenService exposes Twink easing without exposing Twink types")
{
    TweenService tweens;
    const auto started = tweens.start_scalar({.from = 0.0f,
                                              .to = 1.0f,
                                              .duration = std::chrono::seconds{1},
                                              .easing = TweenEasing::QuadraticIn});
    REQUIRE(started);

    tweens.advance(std::chrono::milliseconds{500});
    const auto sample = tweens.sample(*started.value_if());
    REQUIRE(sample);
    CHECK(sample->value == Catch::Approx(0.25f));
    CHECK(sample->normalized_time == Catch::Approx(0.5f));
}
