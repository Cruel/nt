#include <noveltea/active_text_playback.hpp>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

using namespace noveltea;

TEST_CASE("ActiveTextPlayback starts empty for empty text")
{
    const auto state = update_active_text_playback({}, ActiveTextPlaybackInput{});

    CHECK(state.phase == ActiveTextPlaybackPhase::Empty);
    CHECK(state.reveal_progress == Catch::Approx(1.0f));
    CHECK(state.alpha == Catch::Approx(0.0f));
    CHECK_FALSE(state.prompt_visible);
    CHECK_FALSE(state.can_continue);
}

TEST_CASE("ActiveTextPlayback resets reveal and alpha for a new body")
{
    ActiveTextPlaybackConfig config;
    config.reveal_glyphs_per_second = 10.0f;
    config.show_seconds = 1.0f;

    auto state = update_active_text_playback({},
                                             ActiveTextPlaybackInput{.body_key = "dialogue:one",
                                                                     .glyph_count = 20,
                                                                     .delta_seconds = 0.25f},
                                             config);

    CHECK(state.instance_id == 1u);
    CHECK(state.body_key == "dialogue:one");
    CHECK(state.phase == ActiveTextPlaybackPhase::Appearing);
    CHECK(state.reveal_progress == Catch::Approx(0.125f));
    CHECK(state.alpha == Catch::Approx(0.25f));
    CHECK(state.can_skip_reveal);
    CHECK_FALSE(state.can_continue);
}

TEST_CASE("ActiveTextPlayback does not reset for the same body key")
{
    ActiveTextPlaybackConfig config;
    config.reveal_glyphs_per_second = 10.0f;
    config.show_seconds = 0.1f;

    auto state = update_active_text_playback(
        {}, ActiveTextPlaybackInput{.body_key = "same", .glyph_count = 10, .delta_seconds = 0.5f},
        config);
    const auto instance = state.instance_id;
    state = update_active_text_playback(
        state,
        ActiveTextPlaybackInput{.body_key = "same", .glyph_count = 10, .delta_seconds = 0.25f},
        config);

    CHECK(state.instance_id == instance);
    CHECK(state.reveal_progress == Catch::Approx(0.75f));
    CHECK(state.alpha == Catch::Approx(1.0f));
}

TEST_CASE("ActiveTextPlayback exposes prompt only after completed waiting text")
{
    ActiveTextPlaybackConfig config;
    config.reveal_glyphs_per_second = 10.0f;
    config.show_seconds = 0.0f;

    auto state = update_active_text_playback({},
                                             ActiveTextPlaybackInput{.body_key = "wait",
                                                                     .glyph_count = 10,
                                                                     .delta_seconds = 0.5f,
                                                                     .awaiting_continue = true},
                                             config);

    CHECK_FALSE(state.prompt_visible);
    CHECK_FALSE(state.can_continue);
    CHECK(state.can_skip_reveal);

    state = update_active_text_playback(state,
                                        ActiveTextPlaybackInput{.body_key = "wait",
                                                                .glyph_count = 10,
                                                                .delta_seconds = 0.5f,
                                                                .awaiting_continue = true},
                                        config);

    CHECK(state.phase == ActiveTextPlaybackPhase::AwaitingContinue);
    CHECK(state.reveal_progress == Catch::Approx(1.0f));
    CHECK(state.prompt_visible);
    CHECK(state.can_continue);
    CHECK_FALSE(state.can_skip_reveal);
    CHECK(state.prompt_alpha > 0.0f);
}

TEST_CASE("ActiveTextPlayback skip completes reveal without inventing continue")
{
    ActiveTextPlaybackConfig config;
    config.reveal_glyphs_per_second = 10.0f;
    config.show_seconds = 0.0f;

    auto state = update_active_text_playback(
        {}, ActiveTextPlaybackInput{.body_key = "skip", .glyph_count = 20, .delta_seconds = 0.25f},
        config);
    state = skip_active_text_reveal(state);

    CHECK(state.reveal_progress == Catch::Approx(1.0f));
    CHECK_FALSE(state.can_skip_reveal);
    CHECK_FALSE(state.can_continue);
    CHECK_FALSE(state.prompt_visible);
    CHECK(state.phase == ActiveTextPlaybackPhase::Complete);
}

TEST_CASE("ActiveTextPlayback fades out when text clears")
{
    ActiveTextPlaybackConfig config;
    config.show_seconds = 0.0f;
    config.hide_seconds = 0.5f;

    auto state = update_active_text_playback(
        {}, ActiveTextPlaybackInput{.body_key = "gone", .glyph_count = 4, .delta_seconds = 0.0f},
        config);
    CHECK(state.alpha == Catch::Approx(1.0f));

    state =
        update_active_text_playback(state, ActiveTextPlaybackInput{.delta_seconds = 0.25f}, config);
    CHECK(state.phase == ActiveTextPlaybackPhase::Disappearing);
    CHECK(state.alpha == Catch::Approx(0.5f));

    state =
        update_active_text_playback(state, ActiveTextPlaybackInput{.delta_seconds = 0.25f}, config);
    CHECK(state.phase == ActiveTextPlaybackPhase::Empty);
    CHECK(state.alpha == Catch::Approx(0.0f));
}

TEST_CASE("ActiveTextPlayback skip enables continue for waiting text")
{
    ActiveTextPlaybackConfig config;
    config.reveal_glyphs_per_second = 10.0f;
    config.show_seconds = 0.0f;

    auto state = update_active_text_playback(
        {},
        ActiveTextPlaybackInput{
            .body_key = "skip-wait", .glyph_count = 20, .delta_seconds = 0.25f, .page_break = true},
        config);
    state = skip_active_text_reveal(state);

    CHECK(state.reveal_progress == Catch::Approx(1.0f));
    CHECK(state.can_continue);
    CHECK(state.prompt_visible);
    CHECK(state.phase == ActiveTextPlaybackPhase::AwaitingContinue);
}
