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

DebugUiEventResult DebugUI::process_event(const SDL_Event& event, const SurfaceMetrics& surface)
{
    (void)event;
    (void)surface;
    return {};
}

void DebugUI::begin_frame(const SurfaceMetrics& surface) { (void)surface; }

void DebugUI::end_frame() {}

void DebugUI::shutdown() {}

void DebugUI::log_printf(const char* fmt, ...) { (void)fmt; }

void DebugUI::set_perf_logging_enabled(bool enabled) { (void)enabled; }

} // namespace noveltea
