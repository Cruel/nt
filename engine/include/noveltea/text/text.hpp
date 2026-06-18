#pragma once

#include "noveltea/math/geometry.hpp"
#include "noveltea/text/font.hpp"
#include "noveltea/text/text_layout.hpp"
#include "noveltea/text/text_style.hpp"

#include <string>

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

} // namespace noveltea
