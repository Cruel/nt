#pragma once

#include "noveltea/render/quad_batch.hpp"

#include <cstdint>
#include <filesystem>
#include <string>

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

    void draw_demo_2d(float time_seconds);
    void draw_2d(const QuadBatch& batch);

    const char* renderer_name() const;
    const char* texture_status() const { return m_texture_status.c_str(); }
    bool is_initialized() const { return m_initialized; }
    int width() const { return m_width; }
    int height() const { return m_height; }

    // Draw developer overlay text (rendered in-viewport, not stdout).
    void debug_printf(uint16_t x, uint16_t y, uint8_t color, const char* fmt, ...);

private:
    void create_triangle();
    void destroy_triangle();
    void create_2d();
    void destroy_2d();
    void submit_quad(const QuadCommand& command);
    uint16_t load_ppm_texture(const std::filesystem::path& path);

    bool m_initialized = false;
    bool m_vsync = true;
    int m_width = 0;
    int m_height = 0;

    // bgfx resource handles (stored as uint16_t indices; UINT16_MAX = invalid)
    uint16_t m_triangle_vb = UINT16_MAX;
    uint16_t m_triangle_ib = UINT16_MAX;
    uint16_t m_triangle_program = UINT16_MAX;
    uint16_t m_quad_program = UINT16_MAX;
    uint16_t m_checker_texture = UINT16_MAX;
    uint16_t m_disk_texture = UINT16_MAX;
    uint16_t m_sampler = UINT16_MAX;
    uint16_t m_use_texture_uniform = UINT16_MAX;
    std::string m_texture_status = "procedural checker";
};

} // namespace noveltea
