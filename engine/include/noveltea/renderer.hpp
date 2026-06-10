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
    void create_triangle();
    void destroy_triangle();

    bool m_initialized = false;
    bool m_vsync = true;
    int m_width = 0;
    int m_height = 0;

    // bgfx resource handles (stored as uint16_t indices; UINT16_MAX = invalid)
    uint16_t m_triangle_vb = UINT16_MAX;
    uint16_t m_triangle_ib = UINT16_MAX;
    uint16_t m_triangle_program = UINT16_MAX;
};

} // namespace noveltea
