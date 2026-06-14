#pragma once

#include <cstdio>
#include <string>

struct SDL_Window;
union SDL_Event;

namespace noveltea {

class DebugUI {
public:
    DebugUI();
    ~DebugUI();

    DebugUI(const DebugUI&) = delete;
    DebugUI& operator=(const DebugUI&) = delete;

    bool initialize(SDL_Window* window);
    void process_event(const SDL_Event& event);
    void begin_frame(int width, int height);
    void end_frame();
    void shutdown();

    bool is_visible() const { return m_visible; }
    void toggle_visibility() { m_visible = !m_visible; }

    void log_printf(const char* fmt, ...);

private:
    bool m_initialized = false;
    bool m_visible = true;
    std::string m_ini_path;
    float m_web_ini_sync_timer = 0.0f;
    char m_log_buffer[4096] = {};
    int m_log_len = 0;
    void* m_bgfx_backend = nullptr;
};

} // namespace noveltea
