#pragma once

#include "noveltea/math/geometry.hpp"
#include "noveltea/text/font.hpp"
#include "noveltea/text/text_style.hpp"

#include <string>

namespace noveltea {

struct TextRun {
    std::string text;
    FontHandle font{};
    Vec2 position{};
    TextStyle style{};
    Transform2D transform{};
    int effect_id = 0;
};

} // namespace noveltea
