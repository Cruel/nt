#include "noveltea/platform.hpp"

#include <SDL3/SDL.h>
#include <cstdio>

namespace noveltea {

Platform::Platform() = default;
Platform::~Platform() { shutdown(); }

bool Platform::initialize(const PlatformConfig& config)
{
    if (m_window) {
        std::fprintf(stderr, "[platform] already initialized\n");
        return false;
    }

    Uint32 flags = SDL_INIT_VIDEO | SDL_INIT_EVENTS;
    if (!SDL_Init(flags)) {
        std::fprintf(stderr, "[platform] SDL_Init failed: %s\n", SDL_GetError());
        return false;
    }

    m_width = config.width;
    m_height = config.height;

    SDL_WindowFlags win_flags = SDL_WINDOW_RESIZABLE;
    m_window = SDL_CreateWindow(config.title, m_width, m_height, win_flags);
    if (!m_window) {
        std::fprintf(stderr, "[platform] SDL_CreateWindow failed: %s\n", SDL_GetError());
        SDL_Quit();
        return false;
    }

    m_last_tick = SDL_GetTicks();
    m_quit = false;

    std::printf("[platform] initialized: %s (%dx%d)\n", config.title, m_width, m_height);
    return true;
}

bool Platform::poll_events()
{
    if (!m_window) return false;

    uint64_t now = SDL_GetTicks();
    m_delta_time = (now - m_last_tick) / 1000.0f;
    m_last_tick = now;

    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        switch (event.type) {
            case SDL_EVENT_QUIT:
                m_quit = true;
                break;

            case SDL_EVENT_KEY_DOWN:
                if (event.key.key == SDLK_ESCAPE) {
                    m_quit = true;
                }
                std::printf("[input] key_down: scancode=%d\n", event.key.scancode);
                break;

            case SDL_EVENT_MOUSE_BUTTON_DOWN:
                std::printf("[input] mouse_down: button=%d x=%f y=%f\n",
                    event.button.button, event.button.x, event.button.y);
                break;

            case SDL_EVENT_WINDOW_RESIZED:
                m_width = event.window.data1;
                m_height = event.window.data2;
                std::printf("[window] resized: %dx%d\n", m_width, m_height);
                break;

            default:
                break;
        }
    }

    return !m_quit;
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
