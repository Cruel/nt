#include <SDL3/SDL.h>

#include <bgfx/bgfx.h>
#include <bgfx/platform.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>

#if !defined(__linux__)
#error "This first prototype is Linux/WSL2 X11-only. Add other platform handles later."
#endif

static void fail(const char* message)
{
    std::fprintf(stderr, "%s: %s\n", message, SDL_GetError());
    std::exit(1);
}

static bgfx::PlatformData get_sdl_x11_platform_data(SDL_Window* window)
{
    SDL_PropertiesID props = SDL_GetWindowProperties(window);

    void* x11_display = SDL_GetPointerProperty(
        props,
        SDL_PROP_WINDOW_X11_DISPLAY_POINTER,
        nullptr
    );

    const std::uint64_t x11_window = SDL_GetNumberProperty(
        props,
        SDL_PROP_WINDOW_X11_WINDOW_NUMBER,
        0
    );

    if (!x11_display || x11_window == 0) {
        std::fprintf(stderr,
            "Failed to get X11 window properties from SDL. "
            "Try running with: SDL_VIDEODRIVER=x11\n"
        );
        std::exit(1);
    }

    bgfx::PlatformData pd{};
    pd.ndt = x11_display;
    pd.nwh = reinterpret_cast<void*>(static_cast<uintptr_t>(x11_window));
    return pd;
}

int main()
{
    // Good for WSLg/XWayland while prototyping.
    SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "x11");

    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMEPAD | SDL_INIT_EVENTS)) {
        fail("SDL_Init failed");
    }

    int width = 1280;
    int height = 720;

    SDL_Window* window = SDL_CreateWindow(
        "NovelTea Runtime Prototype",
        width,
        height,
        SDL_WINDOW_RESIZABLE
    );

    if (!window) {
        fail("SDL_CreateWindow failed");
    }

    bgfx::PlatformData pd = get_sdl_x11_platform_data(window);

    bgfx::Init init;
    init.type = bgfx::RendererType::OpenGL; // best first choice under WSL2/llvmpipe
    init.platformData = pd;
    init.resolution.width = static_cast<std::uint32_t>(width);
    init.resolution.height = static_cast<std::uint32_t>(height);
    init.resolution.reset = BGFX_RESET_VSYNC;

    if (!bgfx::init(init)) {
        std::fprintf(stderr, "bgfx::init failed\n");
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 1;
    }

    bgfx::setDebug(BGFX_DEBUG_TEXT);
    bgfx::setViewClear(
        0,
        BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH,
        0x202030ff,
        1.0f,
        0
    );
    bgfx::setViewRect(0, 0, 0, static_cast<std::uint16_t>(width), static_cast<std::uint16_t>(height));

    bool running = true;

    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            switch (event.type) {
                case SDL_EVENT_QUIT:
                    running = false;
                    break;

                case SDL_EVENT_WINDOW_RESIZED:
                    width = event.window.data1;
                    height = event.window.data2;

                    bgfx::reset(
                        static_cast<std::uint32_t>(width),
                        static_cast<std::uint32_t>(height),
                        BGFX_RESET_VSYNC
                    );

                    bgfx::setViewRect(
                        0,
                        0,
                        0,
                        static_cast<std::uint16_t>(width),
                        static_cast<std::uint16_t>(height)
                    );
                    break;

                default:
                    break;
            }
        }

        bgfx::touch(0);

        bgfx::dbgTextClear();
        bgfx::dbgTextPrintf(1, 1, 0x0f, "NovelTea runtime prototype");
        bgfx::dbgTextPrintf(1, 2, 0x0f, "SDL3 + bgfx initialized");
        bgfx::dbgTextPrintf(1, 3, 0x0f, "Renderer: %s", bgfx::getRendererName(bgfx::getRendererType()));

        bgfx::frame();
    }

    bgfx::shutdown();
    SDL_DestroyWindow(window);
    SDL_Quit();

    return 0;
}
