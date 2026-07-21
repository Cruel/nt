#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

// Deterministic composition order. Ordinary world upscale precedes native WorldOverlay; source and
// target scene composition remains below the transition composite and every GameUi surface.
enum ViewId : bgfx::ViewId {
    ViewPresentationClear = 0,
    ViewWorldSourceBackground = 1,
    ViewWorldSourceContent = 2,
    ViewWorldSourceSceneComposite = 3,
    ViewWorldSourceOverlayBegin = 4,
    ViewWorldSourceOverlayEnd = 27,
    ViewWorldTargetBackground = 28,
    ViewWorldTargetContent = 29,
    ViewWorldTargetSceneComposite = 30,
    ViewWorldOrdinaryComposite = ViewWorldTargetSceneComposite,
    ViewWorldNativeOverlay = 31,
    ViewWorldTargetOverlayBegin = 32,
    ViewWorldTargetOverlayEnd = 55,
    ViewWorldTransitionSourceComposite = 56,
    ViewWorldTransitionTargetComposite = 57,
    ViewGameTransition = 58,
    ViewGameUiUnderlay = 59,
    ViewGameUiBegin = 60,
    ViewGameUiEnd = 154,
    ViewActiveText = 155,
    ViewMenuOverlayBegin = 156,
    ViewMenuOverlayEnd = 187,
    ViewModalBegin = 188,
    ViewModalEnd = 219,
    ViewTransitionUiBegin = 220,
    ViewTransitionUiEnd = 235,
    ViewRmlDebugBegin = 236,
    ViewRmlDebugEnd = 251,
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
