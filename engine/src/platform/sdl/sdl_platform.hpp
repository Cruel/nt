#pragma once

#include "noveltea/platform.hpp"

#include <SDL3/SDL_events.h>

#include <vector>

struct SDL_Window;

namespace noveltea::sdl_platform {

[[nodiscard]] SDL_Window* native_window(const Platform& platform);
[[nodiscard]] const std::vector<SDL_Event>& events(const Platform& platform);

} // namespace noveltea::sdl_platform
