#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

enum ViewId : bgfx::ViewId {
    ViewGame2D = 0,
    ViewTextLab = 2,
    // Runtime UI owns a large contiguous range because RmlUi filters, layer
    // copies, resolves, and final composition all require ordered bgfx views.
    ViewRuntimeUIBegin = 32,
    ViewRuntimeUIEnd = 223,
    ViewDebugUI = 250,
};

} // namespace noveltea::bgfx_backend
