#pragma once

#include <noveltea/core/rich_text.hpp>
#include <noveltea/math/geometry.hpp>

#include <cstddef>
#include <string>
#include <vector>

namespace noveltea {

struct ActiveTextOptions {
    float reveal_progress = 1.0f;
    double time_seconds = 0.0;
};

struct ActiveTextGlyph {
    std::string text;
    std::size_t run_index = 0;
    std::size_t glyph_index = 0;
    core::RichTextStyle style{};
    core::RichTextAnimation animation{};
    Vec2 offset{};
    float alpha = 1.0f;
    float scale = 1.0f;
    float glow = 0.0f;
};

struct ActiveTextRunFrame {
    std::size_t run_index = 0;
    std::vector<ActiveTextGlyph> glyphs;
};

struct ActiveTextFrame {
    std::size_t total_glyphs = 0;
    std::size_t visible_glyphs = 0;
    std::vector<ActiveTextRunFrame> runs;
};

[[nodiscard]] ActiveTextFrame build_active_text_frame(const core::RichTextDocument& document,
                                                      const ActiveTextOptions& options = {});

} // namespace noveltea
