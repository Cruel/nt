#pragma once

#include "noveltea/audio/audio_backend.hpp"

namespace noveltea {

class AudioSystem {
public:
    [[nodiscard]] AudioBackendInfo backend_info() const { return {}; }
};

} // namespace noveltea
