#include "noveltea/ui_debug.hpp"

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

void DebugUI::process_event(const SDL_Event& event)
{
    (void)event;
}

void DebugUI::begin_frame(const SurfaceMetrics& surface)
{
    (void)surface;
}

void DebugUI::end_frame()
{
}

void DebugUI::shutdown()
{
}

void DebugUI::log_printf(const char* fmt, ...)
{
    (void)fmt;
}

} // namespace noveltea
