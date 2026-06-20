#include <noveltea/active_text.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace noveltea {
namespace {

std::size_t utf8_codepoint_count(std::string_view text)
{
    std::size_t count = 0;
    for (const unsigned char ch : text) {
        if ((ch & 0xc0u) != 0x80u)
            ++count;
    }
    return count;
}

std::vector<std::string> split_utf8_codepoints(std::string_view text)
{
    std::vector<std::string> out;
    std::size_t begin = 0;
    for (std::size_t i = 0; i < text.size(); ++i) {
        const unsigned char ch = static_cast<unsigned char>(text[i]);
        if (i > begin && (ch & 0xc0u) != 0x80u) {
            out.emplace_back(text.substr(begin, i - begin));
            begin = i;
        }
    }
    if (begin < text.size())
        out.emplace_back(text.substr(begin));
    return out;
}

void log_material_use(const core::RichTextRun& run, std::size_t run_index)
{
    if (!run.style.material_id.empty()) {
        std::fprintf(stderr, "[active_text] material requested for run %zu: material='%s'\n",
                     run_index, run.style.material_id.c_str());
    }
    if (!run.style.vertex_shader_id.empty() || !run.style.fragment_shader_id.empty()) {
        std::fprintf(
            stderr, "[active_text] shader requested for run %zu: vertex='%s' fragment='%s'\n",
            run_index, run.style.vertex_shader_id.c_str(), run.style.fragment_shader_id.c_str());
    }
}

float animation_progress(const core::RichTextAnimation& animation, double time_seconds)
{
    if (animation.duration_ms <= 0)
        return 1.0f;
    const double local_ms = time_seconds * 1000.0 - static_cast<double>(animation.delay_ms);
    if (local_ms <= 0.0)
        return 0.0f;
    const double cycle_ms =
        static_cast<double>(animation.duration_ms + std::max(animation.loop_delay_ms, 0));
    if (animation.loop_count != 0 && cycle_ms > 0.0) {
        const double cycle = std::floor(local_ms / cycle_ms);
        if (animation.loop_count > 0 && cycle >= static_cast<double>(animation.loop_count))
            return animation.loop_yoyo ? 0.0f : 1.0f;
    }
    double in_cycle = local_ms;
    if (cycle_ms > 0.0)
        in_cycle = std::fmod(local_ms, cycle_ms);
    if (in_cycle > static_cast<double>(animation.duration_ms))
        return animation.loop_yoyo ? 0.0f : 1.0f;
    float progress = static_cast<float>(in_cycle / static_cast<double>(animation.duration_ms));
    if (animation.loop_yoyo && cycle_ms > 0.0) {
        const auto cycle = static_cast<long long>(std::floor(local_ms / cycle_ms));
        if ((cycle % 2) != 0)
            progress = 1.0f - progress;
    }
    return std::clamp(progress, 0.0f, 1.0f);
}

void apply_effect(ActiveTextGlyph& glyph, double time_seconds)
{
    const auto effect = glyph.animation.type;
    if (effect == core::TextEffect::None)
        return;

    const float progress = animation_progress(glyph.animation, time_seconds);
    const float phase =
        static_cast<float>(time_seconds * std::max(glyph.animation.speed, 0.1f) * 6.28318530718 +
                           static_cast<double>(glyph.glyph_index) * 0.65);

    switch (effect) {
    case core::TextEffect::Fade:
    case core::TextEffect::FadeAcross:
        glyph.alpha *= progress;
        break;
    case core::TextEffect::Glow:
        glyph.glow = 0.5f + 0.5f * std::sin(phase);
        break;
    case core::TextEffect::Nod:
        glyph.offset.y += std::sin(phase) * 2.0f;
        break;
    case core::TextEffect::Shake:
        glyph.offset.x += std::sin(phase * 2.7f) * 2.0f;
        glyph.offset.y += std::cos(phase * 3.1f) * 2.0f;
        break;
    case core::TextEffect::Tremble:
        glyph.offset.x += std::sin(phase * 7.0f) * 0.75f;
        glyph.offset.y += std::cos(phase * 8.0f) * 0.75f;
        break;
    case core::TextEffect::Pop:
        glyph.scale *= 1.0f + (1.0f - progress) * 0.35f;
        break;
    case core::TextEffect::Test:
        glyph.offset.y += std::sin(phase) * 1.0f;
        glyph.glow = progress;
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
    frame.total_glyphs = utf8_codepoint_count(document.plain_text);
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
        for (const auto& glyph_text : split_utf8_codepoints(run.text)) {
            if (emitted >= frame.visible_glyphs)
                break;
            ActiveTextGlyph glyph;
            glyph.text = glyph_text;
            glyph.run_index = run_index;
            glyph.glyph_index = emitted;
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
            log_material_use(run, run_index);
            frame.runs.push_back(std::move(run_frame));
        }
    }

    return frame;
}

} // namespace noveltea
