#include "noveltea/renderer.hpp"

#include <bgfx/bgfx.h>
#include <bgfx/platform.h>

#include <SDL3/SDL.h>

#include <cstdio>
#include <cstdint>
#include <cstdarg>

namespace noveltea {

static bgfx::PlatformData get_native_platform_data(SDL_Window* window)
{
    bgfx::PlatformData pd{};

#if defined(SDL_PLATFORM_LINUX)
    SDL_PropertiesID props = SDL_GetWindowProperties(window);
    pd.ndt = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr);
    uintptr_t x11_win = static_cast<uintptr_t>(
        SDL_GetNumberProperty(props, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0));
    pd.nwh = reinterpret_cast<void*>(x11_win);

    if (!pd.ndt) {
        // Fallback: use SDL_Window pointer for Wayland or other backends
        pd.ndt = nullptr;
        pd.nwh = window;
    }
#else
    pd.ndt = nullptr;
    pd.nwh = window;
#endif

    return pd;
}

Renderer::Renderer() = default;
Renderer::~Renderer() { shutdown(); }

bool Renderer::initialize(const RendererConfig& config)
{
    if (m_initialized) return true;

    SDL_Window* window = static_cast<SDL_Window*>(config.native_window);
    if (!window) {
        std::fprintf(stderr, "[renderer] no native window provided\n");
        return false;
    }

    bgfx::PlatformData pd = get_native_platform_data(window);

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
    m_initialized = true;

    bgfx::setDebug(BGFX_DEBUG_TEXT);
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x202030ff, 1.0f, 0);
    bgfx::setViewRect(0, 0, 0,
        static_cast<uint16_t>(m_width),
        static_cast<uint16_t>(m_height));

    std::printf("[renderer] bgfx initialized: %s\n", renderer_name());
    return true;
}

void Renderer::begin_frame()
{
    bgfx::touch(0);
    bgfx::dbgTextClear();
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
        BGFX_RESET_VSYNC
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
