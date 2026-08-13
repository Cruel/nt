#include "noveltea/platform.hpp"

#include <SDL3/SDL.h>
#if defined(__APPLE__)
#include <SDL3/SDL_metal.h>
#endif
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#if defined(__EMSCRIPTEN__)
#include <emscripten/html5.h>
#endif

namespace noveltea {

#if defined(__EMSCRIPTEN__)
struct WebPointerEventScale {
    AxisScale mouse{};
    AxisScale touch{};
    bool valid = false;
};
#endif

struct PlatformState {
    SDL_Window* window = nullptr;
#if defined(__APPLE__)
    SDL_MetalView metal_view = nullptr;
    void* metal_layer = nullptr;
#endif
    std::vector<SDL_Event> events;
    std::string canvas_selector;
#if defined(__EMSCRIPTEN__)
    WebPointerEventScale pointer_event_scale{};
    bool pointer_event_scale_dirty = true;
#endif
};

#if defined(__EMSCRIPTEN__)
namespace {

[[nodiscard]] bool valid_css_extent(double width, double height)
{
    return std::isfinite(width) && std::isfinite(height) && width > 0.0 && height > 0.0;
}

[[nodiscard]] WebPointerEventScale
resolve_web_pointer_event_scale(const PlatformState& state, const HostSurfaceMetrics& surface)
{
    WebPointerEventScale result;
    if (!state.window || state.canvas_selector.empty())
        return result;

    double canvas_css_width = 0.0;
    double canvas_css_height = 0.0;
    if (emscripten_get_element_css_size(state.canvas_selector.c_str(), &canvas_css_width,
                                        &canvas_css_height) != EMSCRIPTEN_RESULT_SUCCESS ||
        !valid_css_extent(canvas_css_width, canvas_css_height))
        return result;

    double host_css_width = static_cast<double>(surface.logical_size.width);
    double host_css_height = static_cast<double>(surface.logical_size.height);
    double measured_host_css_width = 0.0;
    double measured_host_css_height = 0.0;
    if (emscripten_get_element_css_size("body", &measured_host_css_width,
                                        &measured_host_css_height) == EMSCRIPTEN_RESULT_SUCCESS &&
        valid_css_extent(measured_host_css_width, measured_host_css_height)) {
        host_css_width = measured_host_css_width;
        host_css_height = measured_host_css_height;
    }

    int sdl_width = 0;
    int sdl_height = 0;
    if (!SDL_GetWindowSize(state.window, &sdl_width, &sdl_height) || sdl_width <= 0 ||
        sdl_height <= 0)
        return result;

    // SDL first projects DOM mouse coordinates through its fixed logical window and the retained
    // canvas CSS extent. Undo that projection, then map CSS pixels into the active host surface.
    result.mouse.x = static_cast<float>((canvas_css_width * surface.logical_size.width) /
                                        (static_cast<double>(sdl_width) * host_css_width));
    result.mouse.y = static_cast<float>((canvas_css_height * surface.logical_size.height) /
                                        (static_cast<double>(sdl_height) * host_css_height));

    // SDL touch coordinates are normalized directly against the retained canvas CSS extent.
    if (canvas_css_width > 1.0 && host_css_width > 1.0)
        result.touch.x = static_cast<float>((canvas_css_width - 1.0) / (host_css_width - 1.0));
    if (canvas_css_height > 1.0 && host_css_height > 1.0)
        result.touch.y = static_cast<float>((canvas_css_height - 1.0) / (host_css_height - 1.0));
    result.valid = true;
    return result;
}

[[nodiscard]] bool is_web_pointer_event(const SDL_Event& event)
{
    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION:
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP:
    case SDL_EVENT_MOUSE_WHEEL:
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED:
        return true;
    default:
        return false;
    }
}

void remap_web_pointer_event(SDL_Event& event, const WebPointerEventScale& scale)
{
    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION:
        event.motion.x *= scale.mouse.x;
        event.motion.y *= scale.mouse.y;
        event.motion.xrel *= scale.mouse.x;
        event.motion.yrel *= scale.mouse.y;
        break;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP:
        event.button.x *= scale.mouse.x;
        event.button.y *= scale.mouse.y;
        break;
    case SDL_EVENT_MOUSE_WHEEL:
        event.wheel.mouse_x *= scale.mouse.x;
        event.wheel.mouse_y *= scale.mouse.y;
        break;
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_MOTION:
    case SDL_EVENT_FINGER_CANCELED:
        event.tfinger.x *= scale.touch.x;
        event.tfinger.y *= scale.touch.y;
        event.tfinger.dx *= scale.touch.x;
        event.tfinger.dy *= scale.touch.y;
        break;
    default:
        break;
    }
}

} // namespace
#endif

Platform::Platform() : m_state(std::make_unique<PlatformState>()) {}
Platform::~Platform() { shutdown(); }

bool Platform::initialize(const PlatformConfig& config)
{
    if (m_state->window) {
        std::fprintf(stderr, "[platform] already initialized\n");
        return false;
    }

#if defined(SDL_PLATFORM_LINUX)
    if (!std::getenv("SDL_VIDEODRIVER")) {
        SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "x11");
        std::printf("[platform] SDL_VIDEODRIVER not set; defaulting SDL video "
                    "driver hint to x11\n");
    }
#endif

    Uint32 flags = SDL_INIT_VIDEO | SDL_INIT_EVENTS;
#if defined(_WIN32) || defined(__APPLE__)
    std::fprintf(stderr, "[platform] starting SDL initialization\n");
#endif
    if (!SDL_Init(flags)) {
        std::fprintf(stderr, "[platform] SDL_Init failed: %s\n", SDL_GetError());
        return false;
    }

    m_surface = make_host_surface_metrics(config.width, config.height, config.width, config.height);

#if defined(_WIN32) || defined(__APPLE__)
    // bgfx owns the native graphics context. Tell SDL which API the native window must support,
    // while keeping context creation and lifetime outside SDL.
    const SDL_PropertiesID window_properties = SDL_CreateProperties();
    if (window_properties == 0) {
        std::fprintf(stderr, "[platform] SDL_CreateProperties failed: %s\n", SDL_GetError());
        SDL_Quit();
        return false;
    }
    const bool properties_ok =
        SDL_SetStringProperty(window_properties, SDL_PROP_WINDOW_CREATE_TITLE_STRING,
                              config.title) &&
        SDL_SetNumberProperty(window_properties, SDL_PROP_WINDOW_CREATE_WIDTH_NUMBER,
                              m_surface.logical_size.width) &&
        SDL_SetNumberProperty(window_properties, SDL_PROP_WINDOW_CREATE_HEIGHT_NUMBER,
                              m_surface.logical_size.height) &&
        SDL_SetBooleanProperty(window_properties, SDL_PROP_WINDOW_CREATE_RESIZABLE_BOOLEAN,
                               config.resizable) &&
        SDL_SetBooleanProperty(window_properties,
                               SDL_PROP_WINDOW_CREATE_EXTERNAL_GRAPHICS_CONTEXT_BOOLEAN, true)
#if defined(__APPLE__)
        && SDL_SetBooleanProperty(window_properties, SDL_PROP_WINDOW_CREATE_METAL_BOOLEAN, true)
#endif
        ;
    if (!properties_ok) {
        std::fprintf(stderr, "[platform] SDL window property setup failed: %s\n", SDL_GetError());
        SDL_DestroyProperties(window_properties);
        SDL_Quit();
        return false;
    }
#if defined(_WIN32) || defined(__APPLE__)
    std::fprintf(stderr, "[platform] creating SDL window with external graphics context\n");
#endif
    m_state->window = SDL_CreateWindowWithProperties(window_properties);
    SDL_DestroyProperties(window_properties);
#else
    SDL_WindowFlags win_flags = config.resizable ? SDL_WINDOW_RESIZABLE : 0;
#if defined(__EMSCRIPTEN__)
    // The browser shell owns CSS size, DPR, and retained drawing-buffer capacity. Letting SDL's
    // resizable-window callback resize the canvas would clear WebGL behind that ownership boundary.
    win_flags &= ~SDL_WINDOW_RESIZABLE;
#endif
    m_state->window = SDL_CreateWindow(config.title, m_surface.logical_size.width,
                                       m_surface.logical_size.height, win_flags);
#endif
    if (!m_state->window) {
        std::fprintf(stderr, "[platform] SDL_CreateWindow failed: %s\n", SDL_GetError());
        SDL_Quit();
        return false;
    }

#if defined(_WIN32)
    std::fprintf(stderr, "[platform] SDL window created; bgfx owns WGL setup\n");
#elif defined(__APPLE__)
    std::fprintf(stderr, "[platform] SDL window created; creating Metal view\n");
    m_state->metal_view = SDL_Metal_CreateView(m_state->window);
    if (!m_state->metal_view) {
        std::fprintf(stderr, "[platform] SDL_Metal_CreateView failed: %s\n", SDL_GetError());
        SDL_DestroyWindow(m_state->window);
        m_state->window = nullptr;
        SDL_Quit();
        return false;
    }
    m_state->metal_layer = SDL_Metal_GetLayer(m_state->metal_view);
    if (!m_state->metal_layer) {
        std::fprintf(stderr, "[platform] SDL_Metal_GetLayer failed\n");
        SDL_Metal_DestroyView(m_state->metal_view);
        m_state->metal_view = nullptr;
        SDL_DestroyWindow(m_state->window);
        m_state->window = nullptr;
        SDL_Quit();
        return false;
    }
    std::fprintf(stderr, "[platform] Metal layer ready: %p\n", m_state->metal_layer);
#endif

    m_last_tick = SDL_GetTicks();
    m_quit = false;

#if defined(__EMSCRIPTEN__)
    SDL_PropertiesID props = SDL_GetWindowProperties(m_state->window);
    const char* canvas_id =
        SDL_GetStringProperty(props, SDL_PROP_WINDOW_EMSCRIPTEN_CANVAS_ID_STRING, "#canvas");
    if (canvas_id[0] != '#') {
        m_state->canvas_selector = "#";
        m_state->canvas_selector += canvas_id;
    } else {
        m_state->canvas_selector = canvas_id;
    }
#endif

    refresh_surface_metrics();

    std::printf("[platform] initialized: %s logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
                config.title, m_surface.logical_size.width, m_surface.logical_size.height,
                m_surface.framebuffer_size.width, m_surface.framebuffer_size.height,
                m_surface.logical_to_framebuffer_scale.x, m_surface.logical_to_framebuffer_scale.y);
    return true;
}

void Platform::poll_events()
{
    m_state->events.clear();
    if (!m_state->window)
        return;

    uint64_t now = SDL_GetTicks();
    m_delta_time = (now - m_last_tick) / 1000.0f;
    m_last_tick = now;

    SDL_Event event;
    while (SDL_PollEvent(&event)) {
#if defined(__EMSCRIPTEN__)
        if (is_web_pointer_event(event)) {
            if (m_state->pointer_event_scale_dirty) {
                const WebPointerEventScale resolved = resolve_web_pointer_event_scale(
                    *m_state, sanitize_host_surface_metrics(m_surface));
                if (resolved.valid) {
                    m_state->pointer_event_scale = resolved;
                    m_state->pointer_event_scale_dirty = false;
                }
            }
            if (m_state->pointer_event_scale.valid)
                remap_web_pointer_event(event, m_state->pointer_event_scale);
        }
#endif
        m_state->events.push_back(event);
    }
}

void Platform::request_quit() { m_quit = true; }

void Platform::set_surface_metrics(HostSurfaceMetrics surface)
{
    m_surface = sanitize_host_surface_metrics(surface);
#if defined(__EMSCRIPTEN__)
    // The shell may change both the active body extent and retained canvas CSS extent around this
    // resize call. Resolve their pointer projection lazily after the browser has applied both.
    m_state->pointer_event_scale_dirty = true;
#endif
    std::printf("[surface] logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f\n",
                m_surface.logical_size.width, m_surface.logical_size.height,
                m_surface.framebuffer_size.width, m_surface.framebuffer_size.height,
                m_surface.logical_to_framebuffer_scale.x, m_surface.logical_to_framebuffer_scale.y);
}

void Platform::refresh_surface_metrics()
{
    if (!m_state->window)
        return;

    int logical_width = m_surface.logical_size.width;
    int logical_height = m_surface.logical_size.height;
    int framebuffer_width = m_surface.framebuffer_size.width;
    int framebuffer_height = m_surface.framebuffer_size.height;
    SDL_GetWindowSize(m_state->window, &logical_width, &logical_height);
    SDL_GetWindowSizeInPixels(m_state->window, &framebuffer_width, &framebuffer_height);

#if defined(SDL_PLATFORM_ANDROID)
    const float display_scale = SDL_GetWindowDisplayScale(m_state->window);
    if (std::isfinite(display_scale) && display_scale > 0.0f && framebuffer_width > 0 &&
        framebuffer_height > 0) {
        logical_width =
            static_cast<int>(std::lround(static_cast<float>(framebuffer_width) / display_scale));
        logical_height =
            static_cast<int>(std::lround(static_cast<float>(framebuffer_height) / display_scale));
    }
#elif defined(__EMSCRIPTEN__)
    // The browser shell sends authoritative CSS logical size, backing-store size,
    // and DPR through noveltea_preview_resize once the runtime is ready.
    return;
#endif

    HostSurfaceMetrics refreshed = make_host_surface_metrics(logical_width, logical_height,
                                                             framebuffer_width, framebuffer_height);
    set_surface_metrics(refreshed);
}

void* Platform::native_window() const { return m_state->window; }

const void* Platform::native_events() const { return &m_state->events; }

NativeWindowHandles Platform::native_window_handles() const
{
    NativeWindowHandles handles;
    if (!m_state->window)
        return handles;

#if defined(__EMSCRIPTEN__)
    handles.window = const_cast<char*>(m_state->canvas_selector.c_str());
#elif defined(SDL_PLATFORM_ANDROID)
    SDL_PropertiesID props = SDL_GetWindowProperties(m_state->window);
    handles.window = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_ANDROID_WINDOW_POINTER, nullptr);
    if (!handles.window) {
        std::fprintf(stderr, "[platform] Android native window unavailable\n");
    }
#elif defined(SDL_PLATFORM_LINUX)
    SDL_PropertiesID props = SDL_GetWindowProperties(m_state->window);
    handles.display = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr);

    const uint64_t x11_window = SDL_GetNumberProperty(props, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0);
    if (handles.display && x11_window != 0) {
        handles.window = reinterpret_cast<void*>(static_cast<uintptr_t>(x11_window));
        return handles;
    }

    handles.display =
        SDL_GetPointerProperty(props, SDL_PROP_WINDOW_WAYLAND_DISPLAY_POINTER, nullptr);
    handles.window =
        SDL_GetPointerProperty(props, SDL_PROP_WINDOW_WAYLAND_SURFACE_POINTER, nullptr);
    if (handles.display && handles.window) {
        handles.type = NativeWindowHandleType::Wayland;
        return handles;
    }

    std::fprintf(stderr,
                 "[platform] Linux native window handles unavailable for X11 and Wayland.\n");
#elif defined(_WIN32)
    SDL_PropertiesID props = SDL_GetWindowProperties(m_state->window);
    handles.window = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_WIN32_HWND_POINTER, nullptr);
    if (!handles.window)
        std::fprintf(stderr, "[platform] Win32 HWND unavailable\n");
    else
        std::fprintf(stderr, "[platform] Win32 HWND ready: %p\n", handles.window);
#elif defined(__APPLE__)
    handles.window = m_state->metal_layer;
    if (!handles.window)
        std::fprintf(stderr, "[platform] CAMetalLayer unavailable\n");
    else
        std::fprintf(stderr, "[platform] CAMetalLayer ready: %p\n", handles.window);
#else
    handles.window = m_state->window;
#endif

    return handles;
}

void Platform::shutdown()
{
    if (!m_state->window)
        return;

#if defined(__APPLE__)
    if (m_state->metal_view) {
        SDL_Metal_DestroyView(m_state->metal_view);
        m_state->metal_view = nullptr;
        m_state->metal_layer = nullptr;
    }
#endif
    SDL_DestroyWindow(m_state->window);
    m_state->window = nullptr;
    SDL_Quit();
    std::printf("[platform] shutdown\n");
}

namespace sdl_platform {

SDL_Window* native_window(const Platform& platform)
{
    return static_cast<SDL_Window*>(platform.native_window());
}

const std::vector<SDL_Event>& events(const Platform& platform)
{
    return *static_cast<const std::vector<SDL_Event>*>(platform.native_events());
}

} // namespace sdl_platform

} // namespace noveltea
