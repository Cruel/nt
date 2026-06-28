#pragma once

#include <cstdint>
#include <string>

namespace noveltea {

enum class ActiveTextPlaybackPhase {
    Empty,
    Appearing,
    Revealing,
    Complete,
    AwaitingContinue,
    Disappearing,
};

struct ActiveTextPlaybackConfig {
    float reveal_glyphs_per_second = 32.0f;
    float show_seconds = 0.12f;
    float hide_seconds = 0.10f;
    float prompt_blink_period_seconds = 0.85f;
};

struct ActiveTextPlaybackInput {
    std::string body_key;
    std::size_t glyph_count = 0;
    float delta_seconds = 0.0f;
    bool awaiting_continue = false;
    bool page_break = false;
};

struct ActiveTextPlaybackState {
    std::uint64_t instance_id = 0;
    std::string body_key;
    ActiveTextPlaybackPhase phase = ActiveTextPlaybackPhase::Empty;
    float reveal_progress = 1.0f;
    float alpha = 1.0f;
    float elapsed_seconds = 0.0f;
    float prompt_alpha = 0.0f;
    bool prompt_visible = false;
    bool can_skip_reveal = false;
    bool can_continue = false;
    bool page_break = false;
    bool wait_for_click = false;
};

[[nodiscard]] ActiveTextPlaybackState
update_active_text_playback(const ActiveTextPlaybackState& previous,
                            const ActiveTextPlaybackInput& input,
                            const ActiveTextPlaybackConfig& config = {});

[[nodiscard]] ActiveTextPlaybackState skip_active_text_reveal(const ActiveTextPlaybackState& state);

} // namespace noveltea
