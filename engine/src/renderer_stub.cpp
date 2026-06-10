// Stub renderer — used when bgfx is not available (Android, Web, etc.)
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
    m_width = config.width;
    m_height = config.height;
    m_initialized = true;
    std::printf("[renderer] stub initialized (%dx%d)\n", m_width, m_height);
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

void Renderer::resize(int width, int height)
{
    m_width = width;
    m_height = height;
    std::printf("[renderer] stub resize: %dx%d\n", m_width, m_height);
}

void Renderer::shutdown()
{
    m_initialized = false;
    std::printf("[renderer] stub shutdown\n");
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
