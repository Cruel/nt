#pragma once

#include <cstdint>

namespace noveltea {

struct InputEvent {
    enum class Type : uint8_t {
        Unknown,
    };

    Type type = Type::Unknown;
};

} // namespace noveltea
