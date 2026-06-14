#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <SDL3/SDL_events.h>

struct SDL_Window;

namespace noveltea {

struct PlatformConfig {
    const char* title = "NovelTea";
    int width = 1280;
    int height = 720;
    bool resizable = true;
    bool vsync = true;
};

struct NativeWindowHandles {
    void* display = nullptr;
    void* window = nullptr;
};

class Platform {
public:
    Platform();
    ~Platform();

    Platform(const Platform&) = delete;
    Platform& operator=(const Platform&) = delete;

    bool initialize(const PlatformConfig& config);
    void poll_events();
    void request_quit();
    void shutdown();

    const std::vector<SDL_Event>& events() const { return m_events; }
    int width() const { return m_width; }
    int height() const { return m_height; }
    SDL_Window* native_window() const { return m_window; }
    NativeWindowHandles native_window_handles() const;
    bool should_quit() const { return m_quit; }
    float delta_time() const { return m_delta_time; }
    void set_size(int width, int height);
    void refresh_pixel_size();

private:
    SDL_Window* m_window = nullptr;
    std::vector<SDL_Event> m_events;
    int m_width = 1280;
    int m_height = 720;
    bool m_quit = false;
    float m_delta_time = 0.0f;
    uint64_t m_last_tick = 0;
    std::string m_canvas_selector;
};

} // namespace noveltea
