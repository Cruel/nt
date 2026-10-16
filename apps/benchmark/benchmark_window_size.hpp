#pragma once

#include "benchmark_options.hpp"

#include <SDL3/SDL.h>

#include <cstdlib>
#include <string>

namespace noveltea::benchmark {

// Resolve the actual display mode before constructing either graphics host.
// Engine-owned hosts have no SDL window yet; a temporary SDL video reference
// permits the same query without relying on a previously initialized dashboard.
inline bool requested_benchmark_window_size(const Options& options, SDL_Window* existing,
                                            int& width, int& height, std::string& reason)
{
    width = options.width;
    height = options.height;
    if (!options.native_resolution)
        return true;

#if defined(__ANDROID__)
    // Android uses a native fullscreen Activity surface regardless of the
    // requested logical window size. Engine startup owns the foreground wait;
    // do not attempt to initialize SDL video before the Activity is ready.
    return true;
#else
#if defined(__linux__) && !defined(__EMSCRIPTEN__)
    // Match the Engine SDL host's default video-driver preference.
    if (!std::getenv("SDL_VIDEODRIVER"))
        SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "x11");
#endif
    const bool temporary_video = (SDL_WasInit(SDL_INIT_VIDEO) & SDL_INIT_VIDEO) == 0;
    if (temporary_video && !SDL_InitSubSystem(SDL_INIT_VIDEO)) {
        reason = std::string("SDL video initialization for native resolution: ") + SDL_GetError();
        return false;
    }
    const SDL_DisplayID display =
        existing ? SDL_GetDisplayForWindow(existing) : SDL_GetPrimaryDisplay();
    const SDL_DisplayMode* mode = display ? SDL_GetCurrentDisplayMode(display) : nullptr;
    if (mode) {
        width = mode->w;
        height = mode->h;
    }
    if (temporary_video)
        SDL_QuitSubSystem(SDL_INIT_VIDEO);
    if (!mode || width < 1 || height < 1 || width > 8192 || height > 8192) {
        reason = "native display mode is unavailable or outside the 8192-pixel limit";
        return false;
    }
    return true;
#endif
}

} // namespace noveltea::benchmark
