#pragma once

#include <cstdio>
#include <string>

#include "noveltea/surface.hpp"

struct SDL_Window;
union SDL_Event;

namespace noveltea {

namespace assets {
class AssetManager;
}
class RuntimeUI;

class DebugUI {
public:
    DebugUI();
    ~DebugUI();

    DebugUI(const DebugUI&) = delete;
    DebugUI& operator=(const DebugUI&) = delete;

    bool initialize(SDL_Window* window, const assets::AssetManager* assets = nullptr);
    void process_event(const SDL_Event& event, const SurfaceMetrics& surface);
    void begin_frame(const SurfaceMetrics& surface);
    void end_frame();
    void shutdown();

    bool is_visible() const { return m_visible; }
    void toggle_visibility() { m_visible = !m_visible; }

    void set_runtime_ui(RuntimeUI* ui) { m_runtime_ui = ui; }
    void set_perf_logging_enabled(bool enabled);

    void log_printf(const char* fmt, ...);

private:
    bool m_initialized = false;
    bool m_visible = true;
    std::string m_ini_path;
    float m_web_ini_sync_timer = 0.0f;
    char m_log_buffer[4096] = {};
    int m_log_len = 0;
    void* m_bgfx_backend = nullptr;
    const assets::AssetManager* m_assets = nullptr;
    RuntimeUI* m_runtime_ui = nullptr;
    bool m_perf_logging_enabled = false;
};

} // namespace noveltea
