#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

// Deterministic composition order. Temporary postprocess scene targets are cleared before any game
// composition. World postprocess resolves before GameUi; full-game postprocess resolves after all
// runtime UI and before debug/editor chrome.
enum ViewId : bgfx::ViewId {
    ViewPresentationClear = 0,
    ViewPostprocessSceneClear = 1,
    ViewWorldSourceBackground = 2,
    ViewWorldSourceContent = 3,
    ViewWorldSourceSceneComposite = 4,
    ViewWorldSourceOverlayBegin = 5,
    ViewWorldSourceOverlayEnd = 28,
    ViewWorldTargetBackground = 29,
    ViewWorldTargetContent = 30,
    ViewWorldTargetSceneComposite = 31,
    ViewWorldOrdinaryComposite = ViewWorldTargetSceneComposite,
    ViewWorldNativeOverlay = 32,
    ViewWorldTargetOverlayBegin = 33,
    ViewWorldTargetOverlayEnd = 56,
    ViewWorldTransitionSourceComposite = 57,
    ViewWorldTransitionTargetComposite = 58,
    ViewGameTransition = 59,
    ViewWorldPostprocessBegin = 60,
    ViewWorldPostprocessEnd = 63,
    ViewWorldPostprocessComposite = ViewWorldPostprocessBegin,
    ViewGameUiUnderlay = 64,
    ViewGameUiBegin = 65,
    ViewGameUiEnd = 156,
    ViewActiveText = 157,
    ViewMenuOverlayBegin = 158,
    ViewMenuOverlayEnd = 189,
    ViewModalBegin = 190,
    ViewModalEnd = 221,
    ViewTransitionUiBegin = 222,
    ViewTransitionUiEnd = 237,
    ViewFullGamePostprocessBegin = 238,
    ViewFullGamePostprocessEnd = 241,
    ViewFullGamePostprocessComposite = ViewFullGamePostprocessBegin,
    ViewRmlDebugBegin = 242,
    ViewRmlDebugEnd = 254,

    // Screenshot capture suppresses the RmlUi debug plane, so the tail of that range can be reused
    // for the resize/readback passes on capture frames without consuming additional global views.
    ViewScreenshotResize = 253,
    ViewScreenshotReadback = 254,
    ViewScreenshotPresent = 255,
    ViewDebugUI = 255,

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
