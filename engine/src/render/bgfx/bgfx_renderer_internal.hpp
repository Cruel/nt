#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

#ifdef __EMSCRIPTEN__
inline constexpr bgfx::ViewId presentation_view_base = 0;
#else
// Native media conversions run before consumers. This is a per-frame GPU work budget,
// not an occurrence count: held videos use no conversion view.
inline constexpr bgfx::ViewId presentation_view_base = 256;
#endif

// World postprocess resolves before GameUi; full-game postprocess precedes debug chrome.
enum ViewId : bgfx::ViewId {
    ViewPresentationClear = presentation_view_base,
    ViewPostprocessSceneClear = presentation_view_base + 1,
    ViewWorldSourceBackground = presentation_view_base + 2,
    ViewWorldSourceContent = presentation_view_base + 3,
    ViewWorldSourceSceneComposite = presentation_view_base + 4,
    ViewWorldSourceOverlayBegin = presentation_view_base + 5,
    ViewWorldSourceOverlayEnd = presentation_view_base + 28,
    ViewWorldTargetBackground = presentation_view_base + 29,
    ViewWorldTargetContent = presentation_view_base + 30,
    ViewWorldTargetSceneComposite = presentation_view_base + 31,
    ViewWorldOrdinaryComposite = ViewWorldTargetSceneComposite,
    ViewWorldNativeOverlay = presentation_view_base + 32,
    ViewWorldTargetOverlayBegin = presentation_view_base + 33,
    ViewWorldTargetOverlayEnd = presentation_view_base + 56,
    ViewWorldTransitionSourceComposite = presentation_view_base + 57,
    ViewWorldTransitionTargetComposite = presentation_view_base + 58,
    ViewGameTransition = presentation_view_base + 59,
    ViewWorldPostprocessBegin = presentation_view_base + 60,
    ViewWorldPostprocessEnd = presentation_view_base + 63,
    ViewWorldPostprocessComposite = ViewWorldPostprocessBegin,
    ViewGameUiUnderlay = presentation_view_base + 64,
    ViewGameUiBegin = presentation_view_base + 65,
    ViewGameUiEnd = presentation_view_base + 156,
    ViewActiveText = presentation_view_base + 157,
    ViewMenuOverlayBegin = presentation_view_base + 158,
    ViewMenuOverlayEnd = presentation_view_base + 189,
    ViewModalBegin = presentation_view_base + 190,
    ViewModalEnd = presentation_view_base + 221,
    ViewTransitionUiBegin = presentation_view_base + 222,
    ViewTransitionUiEnd = presentation_view_base + 237,
    ViewFullGamePostprocessBegin = presentation_view_base + 238,
    ViewFullGamePostprocessEnd = presentation_view_base + 241,
    ViewFullGamePostprocessComposite = ViewFullGamePostprocessBegin,
    ViewRmlDebugBegin = presentation_view_base + 242,
    ViewRmlDebugEnd = presentation_view_base + 247,
    ViewRmlDebuggerHostBegin = presentation_view_base + 248,
    ViewRmlDebuggerHostEnd = presentation_view_base + 254,
    // Capture suppresses the debug plane, freeing these views for resize/readback.
    ViewScreenshotResize = presentation_view_base + 253,
    ViewScreenshotReadback = presentation_view_base + 254,
    ViewScreenshotPresent = presentation_view_base + 255,
    ViewDebugUI = presentation_view_base + 255,
    ViewGameLayerBackground = ViewWorldTargetBackground,
    ViewGameLayerMain = ViewWorldTargetContent,
    ViewTextLab = ViewGameUiUnderlay,
    ViewGameLayerForeground = ViewWorldNativeOverlay,
    ViewGameLayerUIOverlay = ViewGameUiUnderlay,
    ViewRuntimeUIBegin = ViewGameUiBegin,
    ViewRuntimeUIEnd = ViewModalEnd,
};

} // namespace noveltea::bgfx_backend
