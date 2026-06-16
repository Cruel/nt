#pragma once

#include "noveltea/math/geometry.hpp"

namespace noveltea {

struct TextStyle {
    float size = 24.0f;
    Color color{1.0f, 1.0f, 1.0f, 1.0f};
    float alpha = 1.0f;
    Color outline_color{0.0f, 0.0f, 0.0f, 1.0f};
    float outline_width = 0.0f;
    Color drop_shadow_color{0.0f, 0.0f, 0.0f, 0.5f};
    Vec2 drop_shadow_offset{0.0f, 0.0f};
    float drop_shadow_softener = 0.0f;
};

} // namespace noveltea
