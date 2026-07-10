#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

// Game layer views — each GameLayer enum value maps to one of these.
// Runtime UI and ActiveText render after the ordinary game layers. The
// transition view is the last game-viewport view before the host-sized debug UI.
enum ViewId : bgfx::ViewId {
    ViewPresentationClear = 0,
    ViewGameLayerBackground = 1,
    ViewGameLayerMain = 2,
    ViewTextLab = 3,
    ViewGameLayerForeground = 4,
    ViewGameLayerUIOverlay = 5,
    // Runtime UI owns a large contiguous range because RmlUi filters, layer
    // copies, resolves, and final composition all require ordered bgfx views.
    ViewRuntimeUIBegin = 32,
    ViewRuntimeUIEnd = 223,
    ViewActiveText = 224,
    ViewGameTransition = 225,
    ViewDebugUI = 250,
};

} // namespace noveltea::bgfx_backend
