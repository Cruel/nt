#pragma once

#include "host/debug_ui_contracts.hpp"
#include "noveltea/devtools_console.hpp"
#include "noveltea/devtools_snapshot.hpp"
#include "noveltea/devtools_trace.hpp"
#include "noveltea/surface.hpp"

#include <array>
#include <string>
#include <span>
#include <vector>

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
    end_frame(const devtools::DevtoolsSnapshot& snapshot,
              std::span<const devtools::ConsoleRecord> console,
              std::span<const devtools::TraceRecord> trace,
              std::uint64_t trace_evicted_record_count, bool submit_draw_data = true);
    void shutdown();

    [[nodiscard]] bool is_visible() const noexcept { return m_visible; }
    void toggle_visibility() noexcept { m_visible = !m_visible; }
    void reset_window_rect() noexcept { m_reset_window_rect = true; }

private:
    bool m_visible = false;
    bool m_reset_window_rect = false;
    bool m_initialized = false;
    [[maybe_unused]] bool m_console_frozen = false;
    [[maybe_unused]] bool m_trace_frozen = false;
    [[maybe_unused]] int m_console_severity_filter = 0;
    [[maybe_unused]] int m_trace_kind_filter = 0;
    [[maybe_unused]] std::array<char, 64> m_console_category_filter{};
    [[maybe_unused]] std::array<char, 128> m_console_text_filter{};
    [[maybe_unused]] std::array<char, 64> m_trace_category_filter{};
    [[maybe_unused]] std::array<char, 128> m_trace_text_filter{};
    [[maybe_unused]] std::vector<devtools::ConsoleRecord> m_frozen_console;
    [[maybe_unused]] std::vector<devtools::TraceRecord> m_frozen_trace;
    std::string m_ini_path;
    float m_web_ini_sync_timer = 0.0f;
    void* m_bgfx_backend = nullptr;
    const assets::AssetManager* m_assets = nullptr;
};

} // namespace noveltea
