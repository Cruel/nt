#pragma once

#include <cstdint>

struct SDL_Window;
union SDL_Event;

namespace noveltea {

struct PlatformConfig {
    const char* title = "NovelTea";
    int width = 1280;
    int height = 720;
    bool resizable = true;
    bool vsync = true;
};

class Platform {
public:
    Platform();
    ~Platform();

    Platform(const Platform&) = delete;
    Platform& operator=(const Platform&) = delete;

    bool initialize(const PlatformConfig& config);
    bool poll_events();
    void shutdown();

    int width() const { return m_width; }
    int height() const { return m_height; }
    SDL_Window* native_window() const { return m_window; }
    bool should_quit() const { return m_quit; }
    float delta_time() const { return m_delta_time; }

private:
    SDL_Window* m_window = nullptr;
    int m_width = 1280;
    int m_height = 720;
    bool m_quit = false;
    float m_delta_time = 0.0f;
    uint64_t m_last_tick = 0;
};

} // namespace noveltea
