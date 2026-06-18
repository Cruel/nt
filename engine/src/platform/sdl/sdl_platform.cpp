#include "noveltea/platform.hpp"

#include <SDL3/SDL.h>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace noveltea {

struct PlatformState {
  SDL_Window *window = nullptr;
  std::vector<SDL_Event> events;
  std::string canvas_selector;
};

Platform::Platform() : m_state(std::make_unique<PlatformState>()) {}
Platform::~Platform() { shutdown(); }

bool Platform::initialize(const PlatformConfig &config) {
  if (m_state->window) {
    std::fprintf(stderr, "[platform] already initialized\n");
    return false;
  }

#if defined(SDL_PLATFORM_LINUX)
  if (!std::getenv("SDL_VIDEODRIVER")) {
    SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "x11");
    std::printf("[platform] SDL_VIDEODRIVER not set; defaulting SDL video "
                "driver hint to x11\n");
  }
#endif

  Uint32 flags = SDL_INIT_VIDEO | SDL_INIT_EVENTS;
  if (!SDL_Init(flags)) {
    std::fprintf(stderr, "[platform] SDL_Init failed: %s\n", SDL_GetError());
    return false;
  }

  m_surface = make_surface_metrics(config.width, config.height, config.width, config.height);

  SDL_WindowFlags win_flags = config.resizable ? SDL_WINDOW_RESIZABLE : 0;
  m_state->window = SDL_CreateWindow(config.title, m_surface.logical_width, m_surface.logical_height, win_flags);
  if (!m_state->window) {
    std::fprintf(stderr, "[platform] SDL_CreateWindow failed: %s\n",
                 SDL_GetError());
    SDL_Quit();
    return false;
  }

  m_last_tick = SDL_GetTicks();
  m_quit = false;

#if defined(__EMSCRIPTEN__)
  SDL_PropertiesID props = SDL_GetWindowProperties(m_state->window);
  const char *canvas_id = SDL_GetStringProperty(
      props, SDL_PROP_WINDOW_EMSCRIPTEN_CANVAS_ID_STRING, "#canvas");
  if (canvas_id[0] != '#') {
    m_state->canvas_selector = "#";
    m_state->canvas_selector += canvas_id;
  } else {
    m_state->canvas_selector = canvas_id;
  }
#endif

  refresh_surface_metrics();

  std::printf("[platform] initialized: %s logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
              config.title,
              m_surface.logical_width,
              m_surface.logical_height,
              m_surface.framebuffer_width,
              m_surface.framebuffer_height,
              m_surface.scale_x,
              m_surface.scale_y);
  return true;
}

void Platform::poll_events() {
  m_state->events.clear();
  if (!m_state->window)
    return;

  uint64_t now = SDL_GetTicks();
  m_delta_time = (now - m_last_tick) / 1000.0f;
  m_last_tick = now;

  SDL_Event event;
  while (SDL_PollEvent(&event)) {
    m_state->events.push_back(event);
  }
}

void Platform::request_quit() { m_quit = true; }

void Platform::set_surface_metrics(SurfaceMetrics surface) {
  m_surface = sanitize_surface_metrics(surface);
  std::printf("[surface] logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
              m_surface.logical_width,
              m_surface.logical_height,
              m_surface.framebuffer_width,
              m_surface.framebuffer_height,
              m_surface.scale_x,
              m_surface.scale_y);
}

void Platform::refresh_surface_metrics() {
  if (!m_state->window)
    return;

  int logical_width = m_surface.logical_width;
  int logical_height = m_surface.logical_height;
  int framebuffer_width = m_surface.framebuffer_width;
  int framebuffer_height = m_surface.framebuffer_height;
  SDL_GetWindowSize(m_state->window, &logical_width, &logical_height);
  SDL_GetWindowSizeInPixels(m_state->window, &framebuffer_width, &framebuffer_height);

#if defined(SDL_PLATFORM_ANDROID)
  const float display_scale = SDL_GetWindowDisplayScale(m_state->window);
  if (std::isfinite(display_scale) && display_scale > 0.0f && framebuffer_width > 0 && framebuffer_height > 0) {
    logical_width = static_cast<int>(std::lround(static_cast<float>(framebuffer_width) / display_scale));
    logical_height = static_cast<int>(std::lround(static_cast<float>(framebuffer_height) / display_scale));
  }
#elif defined(__EMSCRIPTEN__)
  // The browser shell sends authoritative CSS logical size, backing-store size,
  // and DPR through noveltea_preview_resize once the runtime is ready.
  return;
#endif

  SurfaceMetrics refreshed = make_surface_metrics(logical_width, logical_height, framebuffer_width, framebuffer_height);
  set_surface_metrics(refreshed);
}

void *Platform::native_window() const { return m_state->window; }

const void *Platform::native_events() const { return &m_state->events; }

NativeWindowHandles Platform::native_window_handles() const {
  NativeWindowHandles handles;
  if (!m_state->window)
    return handles;

#if defined(__EMSCRIPTEN__)
  handles.window = const_cast<char *>(m_state->canvas_selector.c_str());
#elif defined(SDL_PLATFORM_ANDROID)
  SDL_PropertiesID props = SDL_GetWindowProperties(m_state->window);
  handles.window = SDL_GetPointerProperty(
      props, SDL_PROP_WINDOW_ANDROID_WINDOW_POINTER, nullptr);
  if (!handles.window) {
    std::fprintf(stderr, "[platform] Android native window unavailable\n");
  }
#elif defined(SDL_PLATFORM_LINUX)
  SDL_PropertiesID props = SDL_GetWindowProperties(m_state->window);
  handles.display = SDL_GetPointerProperty(
      props, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr);

  const uint64_t x11_window =
      SDL_GetNumberProperty(props, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0);
  if (handles.display && x11_window != 0) {
    handles.window =
        reinterpret_cast<void *>(static_cast<uintptr_t>(x11_window));
    return handles;
  }

  std::fprintf(stderr, "[platform] X11 native handles unavailable. Try running "
                       "with SDL_VIDEODRIVER=x11.\n");
#else
  handles.window = m_state->window;
#endif

  return handles;
}

void Platform::shutdown() {
  if (!m_state->window)
    return;

  SDL_DestroyWindow(m_state->window);
  m_state->window = nullptr;
  SDL_Quit();
  std::printf("[platform] shutdown\n");
}

namespace sdl_platform {

SDL_Window *native_window(const Platform &platform)
{
  return static_cast<SDL_Window *>(platform.native_window());
}

const std::vector<SDL_Event> &events(const Platform &platform)
{
  return *static_cast<const std::vector<SDL_Event> *>(platform.native_events());
}

} // namespace sdl_platform

} // namespace noveltea
