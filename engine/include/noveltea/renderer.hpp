#pragma once

#include <cstdint>

struct SDL_Window;

namespace noveltea {

struct RendererConfig {
    void* native_display = nullptr;
    void* native_window = nullptr;
    int width = 1280;
    int height = 720;
    bool vsync = true;
    const char* title = "NovelTea";
};

class Renderer {
public:
    Renderer();
    ~Renderer();

    Renderer(const Renderer&) = delete;
    Renderer& operator=(const Renderer&) = delete;

    bool initialize(const RendererConfig& config);
    void begin_frame();
    void end_frame();
    void resize(int width, int height);
    void shutdown();

    const char* renderer_name() const;
    bool is_initialized() const { return m_initialized; }
    int width() const { return m_width; }
    int height() const { return m_height; }

    // Draw developer overlay text (rendered in-viewport, not stdout).
    void debug_printf(uint16_t x, uint16_t y, uint8_t color, const char* fmt, ...);

private:
    bool m_initialized = false;
    int m_width = 0;
    int m_height = 0;
};

} // namespace noveltea
