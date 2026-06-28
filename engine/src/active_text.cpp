#include <noveltea/active_text.hpp>

#include "text/text_breaks.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <string>

namespace noveltea {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTau = kPi * 2.0;

[[nodiscard]] std::string lowercase_ascii(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

[[nodiscard]] float numeric_value_or(const core::RichTextAnimation& animation, float fallback)
{
    if (animation.value.empty()) {
        return fallback;
    }

    char* end = nullptr;
    const float parsed = std::strtof(animation.value.c_str(), &end);
    if (end == animation.value.c_str() || !std::isfinite(parsed)) {
        return fallback;
    }
    return parsed;
}

[[nodiscard]] float eased_progress(const core::RichTextAnimation& animation, float progress)
{
    progress = std::clamp(progress, 0.0f, 1.0f);
    const auto equation = lowercase_ascii(animation.equation);
    if (equation == "linear" || equation == "lin") {
        return progress;
    }
    if (equation == "ease-in" || equation == "easein" || equation == "in") {
        return progress * progress;
    }
    if (equation == "ease-out" || equation == "easeout" || equation == "out") {
        const float inv = 1.0f - progress;
        return 1.0f - inv * inv;
    }

    // The historic/default equation string is "quad". Treat it as a symmetric quadratic
    // ease-in-out so authored default animations still pass through 0.5 at their midpoint.
    if (progress < 0.5f) {
        return 2.0f * progress * progress;
    }
    const float inv = -2.0f * progress + 2.0f;
    return 1.0f - (inv * inv) * 0.5f;
}

[[nodiscard]] float animation_progress(const core::RichTextAnimation& animation,
                                       double time_seconds, double extra_delay_ms = 0.0)
{
    if (animation.duration_ms <= 0) {
        return 1.0f;
    }

    const double local_ms = time_seconds * 1000.0 - static_cast<double>(animation.delay_ms) -
                            std::max(extra_delay_ms, 0.0);
    if (local_ms <= 0.0) {
        return 0.0f;
    }

    const double duration_ms = static_cast<double>(std::max(animation.duration_ms, 1));
    const double loop_delay_ms = static_cast<double>(std::max(animation.loop_delay_ms, 0));
    const double cycle_ms = duration_ms + loop_delay_ms;
    const double cycle = cycle_ms > 0.0 ? std::floor(local_ms / cycle_ms) : 0.0;
    const bool finite_loops = animation.loop_count > 0;
    if (finite_loops && cycle >= static_cast<double>(animation.loop_count)) {
        return animation.loop_yoyo && (animation.loop_count % 2 == 0) ? 0.0f : 1.0f;
    }

    const double in_cycle = cycle_ms > 0.0 ? std::fmod(local_ms, cycle_ms) : local_ms;
    if (in_cycle >= duration_ms) {
        return animation.loop_yoyo && (static_cast<long long>(cycle) % 2 != 0) ? 0.0f : 1.0f;
    }

    float progress = static_cast<float>(in_cycle / duration_ms);
    if (animation.loop_yoyo && (static_cast<long long>(cycle) % 2 != 0)) {
        progress = 1.0f - progress;
    }
    return eased_progress(animation, progress);
}

[[nodiscard]] float effect_speed(const core::RichTextAnimation& animation)
{
    return std::max(animation.speed, 0.01f);
}

[[nodiscard]] bool effect_has_started(const core::RichTextAnimation& animation, double time_seconds)
{
    return time_seconds * 1000.0 >= static_cast<double>(animation.delay_ms);
}

[[nodiscard]] double effect_elapsed_seconds(const core::RichTextAnimation& animation,
                                            double time_seconds)
{
    return std::max(0.0,
                    time_seconds - static_cast<double>(std::max(animation.delay_ms, 0)) / 1000.0);
}

[[nodiscard]] float phase_for(const ActiveTextGlyph& glyph, double time_seconds,
                              float glyph_phase_step = 0.65f)
{
    return static_cast<float>(effect_elapsed_seconds(glyph.animation, time_seconds) *
                                  effect_speed(glyph.animation) * kTau +
                              static_cast<double>(glyph.run_glyph_index) * glyph_phase_step);
}

void apply_effect(ActiveTextGlyph& glyph, double time_seconds)
{
    const auto effect = glyph.animation.type;
    if (effect == core::TextEffect::None) {
        return;
    }

    const float progress = animation_progress(glyph.animation, time_seconds);
    const bool started = effect_has_started(glyph.animation, time_seconds);
    const float phase = phase_for(glyph, time_seconds);

    switch (effect) {
    case core::TextEffect::Fade:
        glyph.alpha *= progress;
        break;
    case core::TextEffect::FadeAcross: {
        const float stagger_ms = std::max(numeric_value_or(glyph.animation, 20.0f), 0.0f);
        glyph.alpha *= animation_progress(glyph.animation, time_seconds,
                                          static_cast<double>(glyph.run_glyph_index) * stagger_ms);
        break;
    }
    case core::TextEffect::Glow:
        if (started) {
            glyph.glow = std::clamp(0.5f + 0.5f * std::sin(phase), 0.0f, 1.0f);
        }
        break;
    case core::TextEffect::Nod: {
        if (started) {
            const float amplitude = numeric_value_or(glyph.animation, 2.0f);
            glyph.offset.y += std::sin(phase) * amplitude;
        }
        break;
    }
    case core::TextEffect::Shake: {
        if (started) {
            const float amplitude = numeric_value_or(glyph.animation, 2.0f);
            glyph.offset.x += std::sin(phase * 2.7f) * amplitude;
            glyph.offset.y += std::cos(phase * 3.1f) * amplitude;
        }
        break;
    }
    case core::TextEffect::Tremble: {
        if (started) {
            const float amplitude = numeric_value_or(glyph.animation, 0.75f);
            glyph.offset.x += std::sin(phase * 7.0f) * amplitude;
            glyph.offset.y += std::cos(phase * 8.0f) * amplitude;
        }
        break;
    }
    case core::TextEffect::Pop: {
        const float amplitude = std::max(numeric_value_or(glyph.animation, 0.35f), 0.0f);
        glyph.scale *= 1.0f + (1.0f - progress) * amplitude;
        break;
    }
    case core::TextEffect::Test:
        glyph.offset.y += std::sin(phase) * 1.0f;
        glyph.glow = std::clamp(0.35f + 0.65f * progress, 0.0f, 1.0f);
        break;
    case core::TextEffect::None:
        break;
    }
}

} // namespace

ActiveTextFrame build_active_text_frame(const core::RichTextDocument& document,
                                        const ActiveTextOptions& options)
{
    ActiveTextFrame frame;
    frame.total_glyphs = text::utf8_grapheme_count(document.plain_text);
    const auto reveal = std::clamp(options.reveal_progress, 0.0f, 1.0f);
    frame.visible_glyphs =
        reveal >= 1.0f
            ? frame.total_glyphs
            : static_cast<std::size_t>(std::floor(static_cast<float>(frame.total_glyphs) * reveal));

    std::size_t emitted = 0;
    for (std::size_t run_index = 0; run_index < document.runs.size(); ++run_index) {
        if (emitted >= frame.visible_glyphs)
            break;

        const auto& run = document.runs[run_index];
        ActiveTextRunFrame run_frame;
        run_frame.run_index = run_index;
        for (const auto& glyph_text : text::split_utf8_graphemes(run.text)) {
            if (emitted >= frame.visible_glyphs)
                break;
            ActiveTextGlyph glyph;
            glyph.text = glyph_text;
            glyph.run_index = run_index;
            glyph.glyph_index = emitted;
            glyph.run_glyph_index = run_frame.glyphs.size();
            glyph.style = run.style;
            glyph.animation = run.animation;
            glyph.offset = {static_cast<float>(run.style.x_offset),
                            static_cast<float>(run.style.y_offset)};
            glyph.alpha = static_cast<float>(run.style.color.a) / 255.0f;
            apply_effect(glyph, options.time_seconds);
            run_frame.glyphs.push_back(std::move(glyph));
            ++emitted;
        }
        if (!run_frame.glyphs.empty()) {
            frame.runs.push_back(std::move(run_frame));
        }
    }

    return frame;
}

} // namespace noveltea
