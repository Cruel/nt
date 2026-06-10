#include "noveltea/platform.hpp"

#include <SDL3/SDL.h>
#include <cstdio>
#include <cstdlib>
#include <cstdint>

namespace noveltea {

Platform::Platform() = default;
Platform::~Platform() { shutdown(); }

bool Platform::initialize(const PlatformConfig& config)
{
    if (m_window) {
        std::fprintf(stderr, "[platform] already initialized\n");
        return false;
    }

#if defined(SDL_PLATFORM_LINUX)
    if (!std::getenv("SDL_VIDEODRIVER")) {
        SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "x11");
        std::printf("[platform] SDL_VIDEODRIVER not set; defaulting SDL video driver hint to x11\n");
    }
#endif

    Uint32 flags = SDL_INIT_VIDEO | SDL_INIT_EVENTS;
    if (!SDL_Init(flags)) {
        std::fprintf(stderr, "[platform] SDL_Init failed: %s\n", SDL_GetError());
        return false;
    }

    m_width = config.width;
    m_height = config.height;

    SDL_WindowFlags win_flags = config.resizable ? SDL_WINDOW_RESIZABLE : 0;
    m_window = SDL_CreateWindow(config.title, m_width, m_height, win_flags);
    if (!m_window) {
        std::fprintf(stderr, "[platform] SDL_CreateWindow failed: %s\n", SDL_GetError());
        SDL_Quit();
        return false;
    }

    m_last_tick = SDL_GetTicks();
    m_quit = false;

#if defined(__EMSCRIPTEN__)
    SDL_PropertiesID props = SDL_GetWindowProperties(m_window);
    const char* canvas_id = SDL_GetStringProperty(props,
        SDL_PROP_WINDOW_EMSCRIPTEN_CANVAS_ID_STRING, "#canvas");
    if (canvas_id[0] != '#') {
        m_canvas_selector = "#";
        m_canvas_selector += canvas_id;
    } else {
        m_canvas_selector = canvas_id;
    }
#endif

    std::printf("[platform] initialized: %s (%dx%d)\n", config.title, m_width, m_height);
    return true;
}

void Platform::poll_events()
{
    m_events.clear();
    if (!m_window) return;

    uint64_t now = SDL_GetTicks();
    m_delta_time = (now - m_last_tick) / 1000.0f;
    m_last_tick = now;

    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        m_events.push_back(event);
    }
}

void Platform::request_quit()
{
    m_quit = true;
}

void Platform::set_size(int width, int height)
{
    m_width = width;
    m_height = height;
}

NativeWindowHandles Platform::native_window_handles() const
{
    NativeWindowHandles handles;
    if (!m_window) return handles;

#if defined(__EMSCRIPTEN__)
    handles.window = const_cast<char*>(m_canvas_selector.c_str());
#elif defined(SDL_PLATFORM_LINUX)
    SDL_PropertiesID props = SDL_GetWindowProperties(m_window);
    handles.display = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr);

    const uint64_t x11_window = SDL_GetNumberProperty(props, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0);
    if (handles.display && x11_window != 0) {
        handles.window = reinterpret_cast<void*>(static_cast<uintptr_t>(x11_window));
        return handles;
    }

    std::fprintf(stderr,
        "[platform] X11 native handles unavailable. Try running with SDL_VIDEODRIVER=x11.\n");
#else
    handles.window = m_window;
#endif

    return handles;
}

void Platform::shutdown()
{
    if (m_window) {
        SDL_DestroyWindow(m_window);
        m_window = nullptr;
    }
    SDL_Quit();
    std::printf("[platform] shutdown\n");
}

} // namespace noveltea
