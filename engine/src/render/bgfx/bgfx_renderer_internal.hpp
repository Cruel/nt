#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

enum ViewId : bgfx::ViewId {
    ViewGame2D = 0,
    ViewRuntimeUI = 1,
    ViewTextLab = 2,
    ViewDebugUI = 3,
};

} // namespace noveltea::bgfx_backend
