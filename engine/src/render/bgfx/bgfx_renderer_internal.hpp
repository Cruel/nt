#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

// Deterministic composition order. Ordinary world upscale precedes native WorldOverlay; source and
// target scene composition remains below the transition composite and every GameUi surface.
enum ViewId : bgfx::ViewId {
    ViewPresentationClear = 0,
    ViewWorldSourceBackground = 1,
    ViewWorldSourceContent = 2,
    ViewWorldSourceOverlayBegin = 3,
    ViewWorldSourceOverlayEnd = 26,
    ViewWorldTargetBackground = 27,
    ViewWorldTargetContent = 28,
    ViewWorldOrdinaryComposite = 29,
    ViewWorldNativeOverlay = 30,
    ViewWorldTargetOverlayBegin = 31,
    ViewWorldTargetOverlayEnd = 54,
    ViewWorldTransitionSourceComposite = 55,
    ViewWorldTransitionTargetComposite = 56,
    ViewGameTransition = 57,
    ViewGameUiUnderlay = 58,
    ViewGameUiBegin = 59,
    ViewGameUiEnd = 153,
    ViewActiveText = 154,
    ViewMenuOverlayBegin = 155,
    ViewMenuOverlayEnd = 186,
    ViewModalBegin = 187,
    ViewModalEnd = 218,
    ViewTransitionUiBegin = 219,
    ViewTransitionUiEnd = 234,
    ViewRmlDebugBegin = 235,
    ViewRmlDebugEnd = 250,
    ViewDebugUI = 252,

    // Legacy/demo aliases remain outside the world compositor contract.
    ViewGameLayerBackground = ViewWorldTargetBackground,
    ViewGameLayerMain = ViewWorldTargetContent,
    ViewTextLab = ViewGameUiUnderlay,
    ViewGameLayerForeground = ViewWorldNativeOverlay,
    ViewGameLayerUIOverlay = ViewGameUiUnderlay,
    ViewRuntimeUIBegin = ViewGameUiBegin,
    ViewRuntimeUIEnd = ViewModalEnd,
};

} // namespace noveltea::bgfx_backend
