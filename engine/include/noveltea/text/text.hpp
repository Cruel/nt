#pragma once

#include "noveltea/math/geometry.hpp"
#include "noveltea/text/font.hpp"
#include "noveltea/text/text_layout.hpp"
#include "noveltea/text/text_style.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace noveltea {

struct Text {
    std::string value;
    FontHandle font{};
    Rect bounds{};
    TextStyle style{};
    TextAlign align = TextAlign::Start;
    TextDirection direction = TextDirection::Auto;
    TextWrap wrap = TextWrap::Word;
    std::string language = "und";
    Transform2D transform{};
};

struct TextSpan {
    uint32_t source_byte_begin = 0;
    uint32_t source_byte_end = 0;
    std::string font_alias;
    uint32_t font_style = TextFontRegular;
    float size = 24.0f;
    Color color{1.0f, 1.0f, 1.0f, 1.0f};
    float alpha = 1.0f;
};

struct StyledText {
    std::string value;
    std::vector<TextSpan> spans;
    Rect bounds{};
    TextAlign align = TextAlign::Start;
    TextDirection direction = TextDirection::Auto;
    TextWrap wrap = TextWrap::Word;
    std::string language = "und";
    Transform2D transform{};
};

} // namespace noveltea
