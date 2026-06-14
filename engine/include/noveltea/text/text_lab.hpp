#pragma once

#include "noveltea/math/geometry.hpp"

#include <string_view>

namespace noveltea {

struct TextRun {
    std::string_view text;
    Vec2 position{};
    Color color{};
    float size = 16.0f;
    float alpha = 1.0f;
    int effect_id = 0;
};

} // namespace noveltea
