#pragma once

#include "host/debug_ui_contracts.hpp"
#include "noveltea/surface.hpp"

#include <string>

struct SDL_Window;
union SDL_Event;

namespace noveltea {

namespace assets {
class AssetManager;
}

struct DebugUiEventResult {
    bool consumed = false;
};

class DebugUI final {
public:
    DebugUI();
    ~DebugUI();

    DebugUI(const DebugUI&) = delete;
    DebugUI& operator=(const DebugUI&) = delete;

    bool initialize(SDL_Window* window, const assets::AssetManager* assets = nullptr);
    [[nodiscard]] DebugUiEventResult process_event(const SDL_Event& event,
                                                   const HostSurfaceMetrics& surface);
    void begin_frame(const HostSurfaceMetrics& surface);
    [[nodiscard]] host::DebugUiFrameOutput
    end_frame(const host::DebugUiObservationSnapshot& observations, bool submit_draw_data = true);
    void shutdown();

    [[nodiscard]] bool is_visible() const noexcept { return m_visible; }
    void toggle_visibility() noexcept { m_visible = !m_visible; }

    void log_printf(const char* fmt, ...);

private:
    bool m_visible = true;
#if defined(NOVELTEA_HAS_IMGUI)
    bool m_initialized = false;
    std::string m_ini_path;
    float m_web_ini_sync_timer = 0.0f;
    char m_log_buffer[4096] = {};
    int m_log_len = 0;
    void* m_bgfx_backend = nullptr;
    const assets::AssetManager* m_assets = nullptr;
#endif
};

} // namespace noveltea
