#pragma once

#include "noveltea/math/geometry.hpp"
#include "noveltea/text/font.hpp"
#include "noveltea/text/text.hpp"
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

[[nodiscard]] inline Text to_text(const TextRun& run)
{
    Text text;
    text.value = run.text;
    text.font = run.font;
    text.bounds = {run.position.x, run.position.y, 0.0f, 0.0f};
    text.style = run.style;
    text.wrap = TextWrap::NoWrap;
    text.transform = run.transform;
    return text;
}

} // namespace noveltea
