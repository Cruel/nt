#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

enum ViewId : bgfx::ViewId {
    ViewGame2D = 0,
    ViewTextLab = 2,
    ViewRuntimeUIBegin = 32,
    ViewRuntimeUIEnd = 63,
    ViewDebugUI = 250,
};

} // namespace noveltea::bgfx_backend
