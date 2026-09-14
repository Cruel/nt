#pragma once

#include "host/cursor_presentation.hpp"

struct SDL_Cursor;

namespace noveltea::sdl_platform {

class SdlCursorRealizer final : public host::CursorRealizer {
public:
    SdlCursorRealizer();
    ~SdlCursorRealizer() override;

    SdlCursorRealizer(const SdlCursorRealizer&) = delete;
    SdlCursorRealizer& operator=(const SdlCursorRealizer&) = delete;

    void realize(host::CursorShape shape) noexcept override;

private:
    [[nodiscard]] SDL_Cursor* cursor(host::CursorShape shape) const noexcept;

    SDL_Cursor* m_default = nullptr;
    SDL_Cursor* m_pointer = nullptr;
    SDL_Cursor* m_text = nullptr;
    SDL_Cursor* m_wait = nullptr;
    SDL_Cursor* m_progress = nullptr;
    SDL_Cursor* m_crosshair = nullptr;
    SDL_Cursor* m_move = nullptr;
    SDL_Cursor* m_not_allowed = nullptr;
    SDL_Cursor* m_ns_resize = nullptr;
    SDL_Cursor* m_ew_resize = nullptr;
    SDL_Cursor* m_nesw_resize = nullptr;
    SDL_Cursor* m_nwse_resize = nullptr;
};

} // namespace noveltea::sdl_platform
