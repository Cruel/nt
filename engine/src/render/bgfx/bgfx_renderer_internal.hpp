#pragma once

#include <bgfx/bgfx.h>

namespace noveltea::bgfx_backend {

// Deterministic composition order. Source/target world and their RmlUi WorldOverlay ranges are
// below the transition composite, which is itself below every GameUi surface.
enum ViewId : bgfx::ViewId {
    ViewPresentationClear = 0,
    ViewWorldSourceBackground = 1,
    ViewWorldSourceContent = 2,
    ViewWorldSourceOverlayBegin = 3,
    ViewWorldSourceOverlayEnd = 26,
    ViewWorldTargetBackground = 27,
    ViewWorldTargetContent = 28,
    ViewWorldTargetOverlayBegin = 29,
    ViewWorldTargetOverlayEnd = 52,
    ViewWorldTransitionSourceComposite = 53,
    ViewWorldTransitionTargetComposite = 54,
    ViewGameTransition = 55,
    ViewGameUiUnderlay = 56,
    ViewGameUiBegin = 57,
    ViewGameUiEnd = 151,
    ViewActiveText = 152,
    ViewMenuOverlayBegin = 153,
    ViewMenuOverlayEnd = 184,
    ViewModalBegin = 185,
    ViewModalEnd = 216,
    ViewTransitionUiBegin = 217,
    ViewTransitionUiEnd = 232,
    ViewRmlDebugBegin = 233,
    ViewRmlDebugEnd = 248,
    ViewDebugUI = 252,

    // Legacy/demo aliases remain outside the world compositor contract.
    ViewGameLayerBackground = ViewWorldTargetBackground,
    ViewGameLayerMain = ViewWorldTargetContent,
    ViewTextLab = ViewGameUiUnderlay,
    ViewGameLayerForeground = ViewWorldTargetContent,
    ViewGameLayerUIOverlay = ViewGameUiUnderlay,
    ViewRuntimeUIBegin = ViewGameUiBegin,
    ViewRuntimeUIEnd = ViewModalEnd,
};

} // namespace noveltea::bgfx_backend
