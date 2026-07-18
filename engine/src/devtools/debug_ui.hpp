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
                                                   const SurfaceMetrics& surface);
    void begin_frame(const SurfaceMetrics& surface);
    [[nodiscard]] host::DebugUiFrameOutput
    end_frame(const host::DebugUiObservationSnapshot& observations);
    void shutdown();

    [[nodiscard]] bool is_visible() const noexcept { return m_visible; }
    void toggle_visibility() noexcept { m_visible = !m_visible; }

    void log_printf(const char* fmt, ...);

private:
    [[maybe_unused]] bool m_initialized = false;
    bool m_visible = true;
    std::string m_ini_path;
    [[maybe_unused]] float m_web_ini_sync_timer = 0.0f;
    [[maybe_unused]] char m_log_buffer[4096] = {};
    [[maybe_unused]] int m_log_len = 0;
    [[maybe_unused]] void* m_bgfx_backend = nullptr;
    [[maybe_unused]] const assets::AssetManager* m_assets = nullptr;
};

} // namespace noveltea
