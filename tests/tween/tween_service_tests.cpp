#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <noveltea/tween_service.hpp>

using namespace noveltea;

TEST_CASE("TweenService advances float tweens deterministically")
{
    TweenService tweens;
    float value = 0.0f;
    int completed = 0;

    tweens.tween_float("owner", "channel", value, 0.0f, 10.0f, 1.0, [&] { ++completed; });

    tweens.advance(0.25);
    CHECK(value == Catch::Approx(2.5f));
    CHECK(tweens.active_count() == 1);

    tweens.advance(0.25);
    CHECK(value == Catch::Approx(5.0f));
    CHECK(completed == 0);

    tweens.advance(0.5);
    CHECK(value == Catch::Approx(10.0f));
    CHECK(completed == 1);
    CHECK(tweens.active_count() == 0);
}

TEST_CASE("TweenService ignores negative delta")
{
    TweenService tweens;
    float value = 0.0f;

    tweens.tween_float("owner", "channel", value, 0.0f, 1.0f, 1.0);
    tweens.advance(-1.0);

    CHECK(value == Catch::Approx(0.0f));
    CHECK(tweens.active_count() == 1);
}

TEST_CASE("TweenService pauses and resumes owner tweens")
{
    TweenService tweens;
    float value = 0.0f;

    tweens.tween_float("owner", "channel", value, 0.0f, 1.0f, 1.0);
    tweens.pause_owner("owner");
    tweens.advance(0.5);

    CHECK(value == Catch::Approx(0.0f));
    auto paused = tweens.debug_snapshot();
    REQUIRE(paused.size() == 1);
    CHECK(paused.front().paused);

    tweens.resume_owner("owner");
    tweens.advance(0.5);

    CHECK(value == Catch::Approx(0.5f));
}

TEST_CASE("TweenService kills by owner and channel")
{
    TweenService tweens;
    float first = 0.0f;
    float second = 0.0f;

    tweens.tween_float("owner-a", "first", first, 0.0f, 1.0f, 1.0);
    tweens.tween_float("owner-b", "second", second, 0.0f, 1.0f, 1.0);
    CHECK(tweens.active_count() == 2);

    tweens.kill_owner("owner-a");
    CHECK(tweens.active_count() == 1);

    tweens.kill_channel("second");
    CHECK(tweens.active_count() == 0);
}

TEST_CASE("TweenService completion callback can kill related tweens")
{
    TweenService tweens;
    float first = 0.0f;
    float second = 0.0f;
    int completed = 0;

    tweens.tween_float("owner", "first", first, 0.0f, 1.0f, 0.25, [&] {
        ++completed;
        tweens.kill_channel("second");
    });
    tweens.tween_float("owner", "second", second, 0.0f, 1.0f, 1.0);

    tweens.advance(0.25);

    CHECK(completed == 1);
    CHECK(tweens.active_count() == 0);
}
