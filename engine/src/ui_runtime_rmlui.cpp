#include "noveltea/ui_runtime.hpp"

#include <cstdio>

#if defined(NOVELTEA_HAS_RMLUI)
#include <RmlUi/Core/Types.h>
#endif

namespace noveltea {

RuntimeUI::RuntimeUI() = default;
RuntimeUI::~RuntimeUI() { shutdown(); }

bool RuntimeUI::initialize()
{
    if (m_initialized) return true;

#if defined(NOVELTEA_HAS_RMLUI)
    std::printf("[runtime_ui] RmlUi linked (system/render interfaces TODO)\n");
#else
    std::printf("[runtime_ui] RmlUi scaffold active (RmlUi library not linked for this target)\n");
#endif

    m_initialized = true;
    return true;
}

void RuntimeUI::process_event(const SDL_Event& event)
{
    (void)event;
    // TODO: Translate SDL input to RmlUi once an RmlUi context exists.
}

void RuntimeUI::resize(int width, int height)
{
    m_width = width;
    m_height = height;
}

void RuntimeUI::begin_frame(float delta_time)
{
    (void)delta_time;
}

void RuntimeUI::end_frame()
{
}

void RuntimeUI::shutdown()
{
    if (!m_initialized) return;

#if defined(NOVELTEA_HAS_RMLUI)
    std::printf("[runtime_ui] RmlUi scaffold shutdown\n");
#else
    std::printf("[runtime_ui] scaffold shutdown\n");
#endif

    m_initialized = false;
}

const char* RuntimeUI::backend_name() const
{
#if defined(NOVELTEA_HAS_RMLUI)
    return "RmlUi (renderer TODO)";
#else
    return "RmlUi scaffold (not linked)";
#endif
}

} // namespace noveltea
