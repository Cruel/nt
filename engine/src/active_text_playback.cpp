#include <noveltea/active_text_playback.hpp>

#include <algorithm>
#include <cmath>

namespace noveltea {
namespace {

[[nodiscard]] bool has_body(const ActiveTextPlaybackInput& input)
{
    return !input.body_key.empty() && input.glyph_count > 0;
}

[[nodiscard]] float reveal_delta(const ActiveTextPlaybackInput& input,
                                 const ActiveTextPlaybackConfig& config)
{
    if (input.glyph_count == 0 || config.reveal_glyphs_per_second <= 0.0f) {
        return 1.0f;
    }
    return input.delta_seconds * config.reveal_glyphs_per_second /
           static_cast<float>(std::max<std::size_t>(input.glyph_count, 1u));
}

[[nodiscard]] float alpha_delta(float delta_seconds, float duration_seconds)
{
    if (duration_seconds <= 0.0f) {
        return 1.0f;
    }
    return delta_seconds / duration_seconds;
}

[[nodiscard]] float prompt_alpha(float elapsed_seconds, float period_seconds)
{
    if (period_seconds <= 0.0f) {
        return 1.0f;
    }
    constexpr float pi = 3.14159265358979323846f;
    const float phase = elapsed_seconds / period_seconds * 2.0f * pi;
    return std::clamp(0.35f + 0.65f * (0.5f + 0.5f * std::sin(phase)), 0.0f, 1.0f);
}

} // namespace

ActiveTextPlaybackState update_active_text_playback(const ActiveTextPlaybackState& previous,
                                                    const ActiveTextPlaybackInput& input,
                                                    const ActiveTextPlaybackConfig& config)
{
    ActiveTextPlaybackState next = previous;
    next.page_break = input.page_break;
    next.wait_for_click = input.awaiting_continue;

    if (!has_body(input)) {
        if (!previous.body_key.empty() && previous.alpha > 0.0f) {
            next.phase = ActiveTextPlaybackPhase::Disappearing;
            next.reveal_progress = 1.0f;
            next.alpha =
                std::clamp(previous.alpha - alpha_delta(std::max(input.delta_seconds, 0.0f),
                                                        config.hide_seconds),
                           0.0f, 1.0f);
            next.elapsed_seconds += std::max(input.delta_seconds, 0.0f);
            next.prompt_alpha = 0.0f;
            next.prompt_visible = false;
            next.can_skip_reveal = false;
            next.can_continue = false;
            next.page_break = false;
            next.wait_for_click = false;
            if (next.alpha > 0.0f) {
                return next;
            }
        }
        next.body_key.clear();
        next.phase = ActiveTextPlaybackPhase::Empty;
        next.reveal_progress = 1.0f;
        next.alpha = 0.0f;
        next.elapsed_seconds = 0.0f;
        next.prompt_alpha = 0.0f;
        next.prompt_visible = false;
        next.can_skip_reveal = false;
        next.can_continue = false;
        next.page_break = false;
        next.wait_for_click = false;
        return next;
    }

    const bool new_body = input.body_key != previous.body_key;
    if (new_body) {
        next.instance_id = previous.instance_id + 1u;
        next.body_key = input.body_key;
        next.phase = ActiveTextPlaybackPhase::Appearing;
        next.reveal_progress = 0.0f;
        next.alpha = 0.0f;
        next.elapsed_seconds = 0.0f;
        next.prompt_alpha = 0.0f;
        next.prompt_visible = false;
        next.can_skip_reveal = false;
        next.can_continue = false;
    }

    const float delta = std::max(input.delta_seconds, 0.0f);
    next.elapsed_seconds += delta;
    next.alpha = std::clamp(next.alpha + alpha_delta(delta, config.show_seconds), 0.0f, 1.0f);
    next.reveal_progress =
        std::clamp(next.reveal_progress + reveal_delta(input, config), 0.0f, 1.0f);

    const bool reveal_complete = next.reveal_progress >= 1.0f;
    const bool waiting = input.awaiting_continue || input.page_break;
    next.can_skip_reveal = !reveal_complete;
    next.can_continue = reveal_complete && waiting;
    next.prompt_visible = next.can_continue;
    next.prompt_alpha = next.prompt_visible
                            ? prompt_alpha(next.elapsed_seconds, config.prompt_blink_period_seconds)
                            : 0.0f;

    if (next.alpha < 1.0f) {
        next.phase = ActiveTextPlaybackPhase::Appearing;
    } else if (!reveal_complete) {
        next.phase = ActiveTextPlaybackPhase::Revealing;
    } else if (waiting) {
        next.phase = ActiveTextPlaybackPhase::AwaitingContinue;
    } else {
        next.phase = ActiveTextPlaybackPhase::Complete;
    }

    return next;
}

ActiveTextPlaybackState skip_active_text_reveal(const ActiveTextPlaybackState& state)
{
    ActiveTextPlaybackState next = state;
    next.reveal_progress = 1.0f;
    next.can_skip_reveal = false;
    const bool waiting = next.wait_for_click || next.page_break;
    next.can_continue = waiting;
    next.prompt_visible = waiting;
    next.prompt_alpha = waiting ? std::max(next.prompt_alpha, 1.0f) : 0.0f;
    if (next.alpha < 1.0f) {
        next.phase = ActiveTextPlaybackPhase::Appearing;
    } else if (waiting) {
        next.phase = ActiveTextPlaybackPhase::AwaitingContinue;
    } else {
        next.phase = ActiveTextPlaybackPhase::Complete;
    }
    return next;
}

} // namespace noveltea
