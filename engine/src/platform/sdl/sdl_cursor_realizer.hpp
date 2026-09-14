#pragma once

#include "host/cursor_presentation.hpp"

#include <string>
#include <unordered_map>

struct SDL_Cursor;

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea::sdl_platform {

class SdlCursorRealizer final : public host::CursorRealizer {
public:
    explicit SdlCursorRealizer(const assets::AssetManager* assets = nullptr);
    ~SdlCursorRealizer() override;

    SdlCursorRealizer(const SdlCursorRealizer&) = delete;
    SdlCursorRealizer& operator=(const SdlCursorRealizer&) = delete;

    void realize(const host::CursorPresentation& presentation) noexcept override;
    [[nodiscard]] bool prepare(const host::CustomCursorPresentation& cursor) noexcept override;
    void clear_custom() noexcept override;

private:
    [[nodiscard]] SDL_Cursor* cursor(host::CursorShape shape) const noexcept;
    [[nodiscard]] SDL_Cursor* custom_cursor(const host::CustomCursorPresentation& cursor) noexcept;

    const assets::AssetManager* m_assets = nullptr;
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
    std::unordered_map<std::string, SDL_Cursor*> m_custom;
};

} // namespace noveltea::sdl_platform
