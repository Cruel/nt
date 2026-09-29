#include "devtools/debug_ui.hpp"

#include <cstdarg>
#include <cstdio>

namespace noveltea {

DebugUI::DebugUI() = default;
DebugUI::~DebugUI() { shutdown(); }

bool DebugUI::initialize(SDL_Window* window, const assets::AssetManager* assets)
{
    (void)window;
    m_visible = false;
    m_reset_window_rect = false;
    m_initialized = false;
    m_imgui_scale = 1.0f;
    m_rmlui_debugger_scale = 1.0f;
    m_rmlui_debugger_scale_dirty = false;
    m_ini_path.clear();
    m_web_ini_sync_timer = 0.0f;
    m_bgfx_backend = nullptr;
    m_assets = assets;
    std::printf("[debug_ui] disabled\n");
    return true;
}

DebugUiEventResult DebugUI::process_event(const SDL_Event& event, const HostSurfaceMetrics& surface)
{
    (void)event;
    (void)surface;
    return {};
}

void DebugUI::begin_frame(const HostSurfaceMetrics& surface) { (void)surface; }

host::DebugUiFrameOutput DebugUI::end_frame(const devtools::DevtoolsSnapshot& snapshot,
                                            std::span<const devtools::ConsoleRecord> console,
                                            std::span<const devtools::TraceRecord> trace,
                                            std::uint64_t trace_evicted_record_count,
                                            bool submit_draw_data)
{
    (void)snapshot;
    (void)console;
    (void)trace;
    (void)trace_evicted_record_count;
    (void)submit_draw_data;
    return {};
}

void DebugUI::shutdown()
{
    m_initialized = false;
    m_imgui_scale = 1.0f;
    m_rmlui_debugger_scale = 1.0f;
    m_rmlui_debugger_scale_dirty = false;
    m_ini_path.clear();
    m_web_ini_sync_timer = 0.0f;
    m_bgfx_backend = nullptr;
    m_assets = nullptr;
}

} // namespace noveltea
