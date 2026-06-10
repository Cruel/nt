#include "noveltea/renderer.hpp"

#include <SDL3/SDL.h>

#include <bgfx/bgfx.h>
#include <bgfx/platform.h>

#include <cstdio>
#include <cstdint>
#include <cstdarg>

namespace noveltea {

Renderer::Renderer() = default;
Renderer::~Renderer() { shutdown(); }

bool Renderer::initialize(const RendererConfig& config)
{
    if (m_initialized) return true;

    if (!config.native_window) {
        std::fprintf(stderr, "[renderer] no native window provided\n");
        return false;
    }

    bgfx::PlatformData pd{};
    pd.ndt = config.native_display;
    pd.nwh = config.native_window;

    bgfx::Init init;
    init.type = bgfx::RendererType::Count; // auto-detect
    init.platformData = pd;
    init.resolution.width = static_cast<uint32_t>(config.width);
    init.resolution.height = static_cast<uint32_t>(config.height);
    init.resolution.reset = config.vsync ? BGFX_RESET_VSYNC : 0;

    if (!bgfx::init(init)) {
        std::fprintf(stderr, "[renderer] bgfx::init failed\n");
        return false;
    }

    m_width = config.width;
    m_height = config.height;
    m_vsync = config.vsync;
    m_initialized = true;

    bgfx::setDebug(BGFX_DEBUG_TEXT);
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x4040c0ff, 1.0f, 0);
    bgfx::setViewRect(0, 0, 0,
        static_cast<uint16_t>(m_width),
        static_cast<uint16_t>(m_height));

    SDL_Log("[renderer] bgfx initialized: %s", renderer_name());
    return true;
}

void Renderer::begin_frame()
{
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x4040c0ff, 1.0f, 0);
    bgfx::setViewRect(0, 0, 0,
        static_cast<uint16_t>(m_width),
        static_cast<uint16_t>(m_height));
    bgfx::setDebug(BGFX_DEBUG_TEXT);
    bgfx::dbgTextClear();
    bgfx::touch(0);
}

void Renderer::end_frame()
{
    bgfx::frame();
}

void Renderer::resize(int width, int height)
{
    if (!m_initialized) return;

    m_width = width;
    m_height = height;

    bgfx::reset(
        static_cast<uint32_t>(width),
        static_cast<uint32_t>(height),
        m_vsync ? BGFX_RESET_VSYNC : 0
    );
    bgfx::setViewRect(0, 0, 0,
        static_cast<uint16_t>(width),
        static_cast<uint16_t>(height));
}

void Renderer::shutdown()
{
    if (m_initialized) {
        bgfx::shutdown();
        m_initialized = false;
        std::printf("[renderer] bgfx shutdown\n");
    }
}

const char* Renderer::renderer_name() const
{
    if (!m_initialized) return "uninitialized";
    return bgfx::getRendererName(bgfx::getRendererType());
}

void Renderer::debug_printf(uint16_t x, uint16_t y, uint8_t color, const char* fmt, ...)
{
    if (!m_initialized) return;
    char buf[256];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    bgfx::dbgTextPrintf(x, y, color, "%s", buf);
}

} // namespace noveltea
