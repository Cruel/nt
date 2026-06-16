#pragma once

namespace noveltea {

struct WindowEvent {
    int width = 0;
    int height = 0;
    bool close_requested = false;
};

} // namespace noveltea
