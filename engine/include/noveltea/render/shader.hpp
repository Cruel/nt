#pragma once

#include <cstdint>

namespace noveltea {

struct ShaderId {
    uint16_t index = UINT16_MAX;

    [[nodiscard]] bool valid() const { return index != UINT16_MAX; }
};

} // namespace noveltea
