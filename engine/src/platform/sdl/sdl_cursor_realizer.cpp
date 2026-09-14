#include "platform/sdl/sdl_cursor_realizer.hpp"

#include <SDL3/SDL_mouse.h>

namespace noveltea::sdl_platform {

SdlCursorRealizer::SdlCursorRealizer()
    : m_default(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_DEFAULT)),
      m_pointer(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_POINTER)),
      m_text(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_TEXT)),
      m_wait(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_WAIT)),
      m_progress(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_PROGRESS)),
      m_crosshair(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_CROSSHAIR)),
      m_move(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_MOVE)),
      m_not_allowed(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_NOT_ALLOWED)),
      m_ns_resize(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_NS_RESIZE)),
      m_ew_resize(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_EW_RESIZE)),
      m_nesw_resize(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_NESW_RESIZE)),
      m_nwse_resize(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_NWSE_RESIZE))
{
}

SdlCursorRealizer::~SdlCursorRealizer()
{
    SDL_DestroyCursor(m_default);
    SDL_DestroyCursor(m_pointer);
    SDL_DestroyCursor(m_text);
    SDL_DestroyCursor(m_wait);
    SDL_DestroyCursor(m_progress);
    SDL_DestroyCursor(m_crosshair);
    SDL_DestroyCursor(m_move);
    SDL_DestroyCursor(m_not_allowed);
    SDL_DestroyCursor(m_ns_resize);
    SDL_DestroyCursor(m_ew_resize);
    SDL_DestroyCursor(m_nesw_resize);
    SDL_DestroyCursor(m_nwse_resize);
}

void SdlCursorRealizer::realize(host::CursorShape shape) noexcept
{
    if (shape == host::CursorShape::Hidden) {
        SDL_HideCursor();
        return;
    }

    SDL_ShowCursor();
    if (SDL_Cursor* value = cursor(shape))
        SDL_SetCursor(value);
}

SDL_Cursor* SdlCursorRealizer::cursor(host::CursorShape shape) const noexcept
{
    switch (shape) {
    case host::CursorShape::Default:
        return m_default;
    case host::CursorShape::Pointer:
        return m_pointer;
    case host::CursorShape::Text:
        return m_text;
    case host::CursorShape::Wait:
        return m_wait;
    case host::CursorShape::Progress:
        return m_progress;
    case host::CursorShape::Crosshair:
        return m_crosshair;
    case host::CursorShape::Move:
        return m_move;
    case host::CursorShape::NotAllowed:
        return m_not_allowed;
    case host::CursorShape::NsResize:
        return m_ns_resize;
    case host::CursorShape::EwResize:
        return m_ew_resize;
    case host::CursorShape::NeswResize:
        return m_nesw_resize;
    case host::CursorShape::NwseResize:
        return m_nwse_resize;
    case host::CursorShape::Hidden:
        break;
    }
    return m_default;
}

} // namespace noveltea::sdl_platform
