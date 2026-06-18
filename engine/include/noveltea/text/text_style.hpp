#pragma once

#include "noveltea/math/geometry.hpp"

namespace noveltea {

struct TextStyle {
    float size = 24.0f;
    Color color{1.0f, 1.0f, 1.0f, 1.0f};
    float alpha = 1.0f;
};

} // namespace noveltea
