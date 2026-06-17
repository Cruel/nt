#include "ui/rmlui/rmlui_system_interface_sdl3.hpp"

#if defined(NOVELTEA_HAS_RMLUI)

#include <SDL3/SDL.h>

namespace noveltea::ui::rmlui {

SdlSystemInterface::SdlSystemInterface()
    : m_start(SDL_GetPerformanceCounter())
    , m_frequency(static_cast<double>(SDL_GetPerformanceFrequency()))
{
}

SdlSystemInterface::~SdlSystemInterface() = default;

double SdlSystemInterface::GetElapsedTime()
{
    return static_cast<double>(SDL_GetPerformanceCounter() - m_start) / m_frequency;
}

void SdlSystemInterface::SetMouseCursor(const Rml::String& cursor_name)
{
    SDL_SystemCursor id = SDL_SYSTEM_CURSOR_DEFAULT;
    if (cursor_name == "pointer") id = SDL_SYSTEM_CURSOR_POINTER;
    else if (cursor_name == "text") id = SDL_SYSTEM_CURSOR_TEXT;
    else if (cursor_name == "move") id = SDL_SYSTEM_CURSOR_MOVE;
    else if (cursor_name == "resize") id = SDL_SYSTEM_CURSOR_NWSE_RESIZE;
    else if (cursor_name == "cross") id = SDL_SYSTEM_CURSOR_CROSSHAIR;
    SDL_Cursor* cursor = SDL_CreateSystemCursor(id);
    if (cursor) {
        SDL_SetCursor(cursor);
    }
}

void SdlSystemInterface::SetClipboardText(const Rml::String& text)
{
    SDL_SetClipboardText(text.c_str());
}

void SdlSystemInterface::GetClipboardText(Rml::String& text)
{
    char* clipboard = SDL_GetClipboardText();
    text = clipboard ? clipboard : "";
    SDL_free(clipboard);
}

bool SdlSystemInterface::LogMessage(Rml::Log::Type type, const Rml::String& message)
{
    SDL_LogPriority priority = SDL_LOG_PRIORITY_INFO;
    if (type == Rml::Log::LT_ERROR || type == Rml::Log::LT_ASSERT) {
        priority = SDL_LOG_PRIORITY_ERROR;
    } else if (type == Rml::Log::LT_WARNING) {
        priority = SDL_LOG_PRIORITY_WARN;
    } else if (type == Rml::Log::LT_DEBUG) {
        priority = SDL_LOG_PRIORITY_DEBUG;
    }
    SDL_LogMessage(SDL_LOG_CATEGORY_APPLICATION, priority, "[rmlui] %s", message.c_str());
    return true;
}

} // namespace noveltea::ui::rmlui

#endif
