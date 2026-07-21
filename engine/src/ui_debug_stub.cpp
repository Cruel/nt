#include "devtools/debug_ui.hpp"

#include <cstdarg>
#include <cstdio>

namespace noveltea {

DebugUI::DebugUI() = default;
DebugUI::~DebugUI() { shutdown(); }

bool DebugUI::initialize(SDL_Window* window, const assets::AssetManager* assets)
{
    (void)window;
    (void)assets;
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

host::DebugUiFrameOutput DebugUI::end_frame(const host::DebugUiObservationSnapshot& observations,
                                            bool submit_draw_data)
{
    (void)observations;
    (void)submit_draw_data;
    return {};
}

void DebugUI::shutdown() {}

void DebugUI::log_printf(const char* fmt, ...) { (void)fmt; }

} // namespace noveltea
