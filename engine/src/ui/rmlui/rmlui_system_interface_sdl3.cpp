#include "ui/rmlui/rmlui_system_interface_sdl3.hpp"

#include <SDL3/SDL.h>
#include <RmlUi/Core/StringUtilities.h>

#include <algorithm>

namespace noveltea::ui::rmlui {

SdlSystemInterface::SdlSystemInterface(SDL_Window* window)
    : m_window(window), m_default_cursor(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_DEFAULT)),
      m_move_cursor(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_MOVE)),
      m_pointer_cursor(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_POINTER)),
      m_resize_cursor(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_NWSE_RESIZE)),
      m_cross_cursor(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_CROSSHAIR)),
      m_text_cursor(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_TEXT)),
      m_unavailable_cursor(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_NOT_ALLOWED)),
      m_start(SDL_GetPerformanceCounter()),
      m_frequency(static_cast<double>(SDL_GetPerformanceFrequency()))
{
}

SdlSystemInterface::~SdlSystemInterface()
{
    SDL_DestroyCursor(m_default_cursor);
    SDL_DestroyCursor(m_move_cursor);
    SDL_DestroyCursor(m_pointer_cursor);
    SDL_DestroyCursor(m_resize_cursor);
    SDL_DestroyCursor(m_cross_cursor);
    SDL_DestroyCursor(m_text_cursor);
    SDL_DestroyCursor(m_unavailable_cursor);
}

double SdlSystemInterface::GetElapsedTime()
{
    return static_cast<double>(SDL_GetPerformanceCounter() - m_start) / m_frequency;
}

void SdlSystemInterface::SetMouseCursor(const Rml::String& cursor_name)
{
    SDL_Cursor* cursor = nullptr;
    if (cursor_name.empty() || cursor_name == "arrow")
        cursor = m_default_cursor;
    else if (cursor_name == "pointer")
        cursor = m_pointer_cursor;
    else if (cursor_name == "text")
        cursor = m_text_cursor;
    else if (cursor_name == "move")
        cursor = m_move_cursor;
    else if (cursor_name == "resize")
        cursor = m_resize_cursor;
    else if (cursor_name == "cross")
        cursor = m_cross_cursor;
    else if (cursor_name == "unavailable")
        cursor = m_unavailable_cursor;
    else if (Rml::StringUtilities::StartsWith(cursor_name, "rmlui-scroll"))
        cursor = m_move_cursor;
    if (cursor)
        SDL_SetCursor(cursor);
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

void SdlSystemInterface::ActivateKeyboard(Rml::Vector2f caret_position, float line_height)
{
    if (!m_window)
        return;
    const SDL_Rect rect{int(caret_position.x), int(caret_position.y), 1,
                        std::max(1, int(line_height))};
    SDL_SetTextInputArea(m_window, &rect, 0);
    SDL_StartTextInput(m_window);
}

void SdlSystemInterface::DeactivateKeyboard()
{
    if (m_window)
        SDL_StopTextInput(m_window);
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
