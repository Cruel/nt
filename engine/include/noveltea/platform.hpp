#pragma once

#include <cstdint>
#include <memory>

#include "noveltea/surface.hpp"

namespace noveltea {

struct PlatformState;

struct PlatformConfig {
    const char* title = "NovelTea";
    int width = 1280;
    int height = 720;
    bool resizable = true;
    bool vsync = true;
};

struct NativeWindowHandles {
    void* display = nullptr;
    void* window = nullptr;
};

class Platform {
public:
    Platform();
    ~Platform();

    Platform(const Platform&) = delete;
    Platform& operator=(const Platform&) = delete;

    bool initialize(const PlatformConfig& config);
    void poll_events();
    void request_quit();
    void shutdown();

    const SurfaceMetrics& surface() const { return m_surface; }
    int logical_width() const { return m_surface.logical_width; }
    int logical_height() const { return m_surface.logical_height; }
    int framebuffer_width() const { return m_surface.framebuffer_width; }
    int framebuffer_height() const { return m_surface.framebuffer_height; }
    float scale_x() const { return m_surface.scale_x; }
    float scale_y() const { return m_surface.scale_y; }
    [[deprecated("Use logical_width()")]] int width() const { return logical_width(); }
    [[deprecated("Use logical_height()")]] int height() const { return logical_height(); }
    void* native_window() const;
    const void* native_events() const;
    NativeWindowHandles native_window_handles() const;
    bool should_quit() const { return m_quit; }
    float delta_time() const { return m_delta_time; }
    void set_surface_metrics(SurfaceMetrics surface);
    void refresh_surface_metrics();
    [[deprecated("Use refresh_surface_metrics()")]] void refresh_pixel_size() { refresh_surface_metrics(); }

private:
    std::unique_ptr<PlatformState> m_state;
    SurfaceMetrics m_surface;
    bool m_quit = false;
    float m_delta_time = 0.0f;
    uint64_t m_last_tick = 0;
};

} // namespace noveltea
