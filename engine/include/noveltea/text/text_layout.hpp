#pragma once

#include "noveltea/math/geometry.hpp"
#include "noveltea/text/font.hpp"
#include "noveltea/text/text_style.hpp"

#include <cstdint>
#include <vector>

namespace noveltea {

enum class TextAlign {
    Start,
    Center,
    End,
    Justify,
};

enum class TextDirection {
    Auto,
    LeftToRight,
    RightToLeft,
};

enum class TextWrap {
    NoWrap,
    Word,
};

struct TextMetrics {
    float width = 0.0f;
    float height = 0.0f;
    float line_height = 0.0f;
    uint32_t line_count = 0;
};

struct PositionedGlyph {
    uint32_t glyph_id = 0;
    uint32_t source_byte_begin = 0;
    uint32_t source_byte_end = 0;
    Vec2 position{};
    Vec2 advance{};
    Vec2 offset{};
    FontHandle font{};
    float pixel_size = 0.0f;
};

struct ShapedRun {
    uint32_t source_byte_begin = 0;
    uint32_t source_byte_end = 0;
    TextDirection direction = TextDirection::LeftToRight;
    uint8_t bidi_level = 0;
    std::vector<PositionedGlyph> glyphs;
};

struct TextLine {
    uint32_t source_byte_begin = 0;
    uint32_t source_byte_end = 0;
    float width = 0.0f;
    float baseline = 0.0f;
    std::vector<ShapedRun> visual_runs;
};

struct TextLayout {
    TextMetrics metrics{};
    Rect bounds{};
    TextStyle style{};
    TextDirection direction = TextDirection::LeftToRight;
    TextAlign align = TextAlign::Start;
    Transform2D transform{};
    std::vector<TextLine> lines;
    bool overflowed = false;
};

} // namespace noveltea
