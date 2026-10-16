#pragma once

#include "noveltea/platform.hpp"

#include <SDL3/SDL_events.h>

#include <vector>

struct SDL_Window;

namespace noveltea::sdl_platform {

#if defined(SDL_PLATFORM_ANDROID)
// Only the Android player Activity exposes this readiness API. Never invoke
// EGL initialization or frame submission while the Activity is unfocused/asleep.
[[nodiscard]] bool android_player_graphics_ready();
void wait_for_android_player_graphics();
#endif

[[nodiscard]] SDL_Window* native_window(const Platform& platform);
[[nodiscard]] const std::vector<SDL_Event>& events(const Platform& platform);

} // namespace noveltea::sdl_platform
