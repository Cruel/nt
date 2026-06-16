#pragma once

#include <cstdint>

namespace noveltea {

struct TextMetrics {
    float width = 0.0f;
    float height = 0.0f;
    float line_height = 0.0f;
    uint32_t line_count = 0;
};

} // namespace noveltea
