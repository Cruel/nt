// Stub renderer - used when bgfx is not available (Android, Web, etc.)
//
// TODO: Implement proper rendering for this target.
//       - Android: Integrate bgfx or use SDL GPU/render API.
//       - Web (Emscripten): Integrate bgfx or use WebGL directly.

#include "noveltea/renderer.hpp"

#include <cstdio>

namespace noveltea {

Renderer::Renderer() = default;
Renderer::~Renderer() { shutdown(); }

bool Renderer::initialize(const RendererConfig& config)
{
    if (m_initialized) return true;
    m_surface = sanitize_surface_metrics(config.surface);
    m_vsync = config.vsync;
    m_initialized = true;
    std::printf("[renderer] stub initialized logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
        m_surface.logical_width,
        m_surface.logical_height,
        m_surface.framebuffer_width,
        m_surface.framebuffer_height,
        m_surface.scale_x,
        m_surface.scale_y);
    return true;
}

void Renderer::begin_frame()
{
    // No-op stub
}

void Renderer::end_frame()
{
    // No-op stub
}

void Renderer::resize(const SurfaceMetrics& surface)
{
    m_surface = sanitize_surface_metrics(surface);
    std::printf("[renderer] stub resize logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
        m_surface.logical_width,
        m_surface.logical_height,
        m_surface.framebuffer_width,
        m_surface.framebuffer_height,
        m_surface.scale_x,
        m_surface.scale_y);
}

void Renderer::draw_demo_2d(float time_seconds)
{
    (void)time_seconds;
}

void Renderer::draw_2d(const QuadBatch& batch)
{
    (void)batch;
}

void Renderer::shutdown()
{
    if (m_initialized) {
        m_initialized = false;
        std::printf("[renderer] stub shutdown\n");
    }
}

const char* Renderer::renderer_name() const
{
    return "stub (bgfx not available)";
}

void Renderer::debug_printf(uint16_t x, uint16_t y, uint8_t color, const char* fmt, ...)
{
    (void)x; (void)y; (void)color; (void)fmt;
    // No in-viewport debug text in stub renderer.
}

} // namespace noveltea
