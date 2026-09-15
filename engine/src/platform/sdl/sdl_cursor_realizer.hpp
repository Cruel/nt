#pragma once

#include "host/cursor_presentation.hpp"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

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

    [[nodiscard]] host::CursorPresentation
    realize(const host::CursorPresentation& presentation) noexcept override;
    [[nodiscard]] bool prepare(const host::CustomCursorPresentation& cursor) noexcept override;
    void clear_custom() noexcept override;

private:
    struct DecodedCursorImage {
        std::uint32_t width = 0;
        std::uint32_t height = 0;
        std::vector<std::uint8_t> rgba;
    };

    [[nodiscard]] SDL_Cursor* cursor(host::CursorShape shape) const noexcept;
    [[nodiscard]] SDL_Cursor* custom_cursor(const host::CustomCursorPresentation& cursor) noexcept;
    [[nodiscard]] DecodedCursorImage* decoded_image(std::string_view logical_path) noexcept;

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
    std::unordered_map<std::string, DecodedCursorImage> m_decoded_images;
    std::unordered_map<std::string, SDL_Cursor*> m_custom;
};

} // namespace noveltea::sdl_platform
