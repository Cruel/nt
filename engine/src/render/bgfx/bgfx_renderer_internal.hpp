#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

// Game layer views — each GameLayer enum value maps to one of these.
// ViewTextLab=2 sits between game layers and is reserved for text rendering.
enum ViewId : bgfx::ViewId {
    ViewGameLayerBackground = 0,
    ViewGameLayerMain = 1,
    ViewTextLab = 2,
    ViewGameLayerForeground = 3,
    ViewGameLayerUIOverlay = 4,
    // Runtime UI owns a large contiguous range because RmlUi filters, layer
    // copies, resolves, and final composition all require ordered bgfx views.
    ViewRuntimeUIBegin = 32,
    ViewRuntimeUIEnd = 223,
    ViewDebugUI = 250,
};

} // namespace noveltea::bgfx_backend
