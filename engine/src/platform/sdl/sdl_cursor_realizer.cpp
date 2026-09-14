#include "platform/sdl/sdl_cursor_realizer.hpp"

#include "noveltea/assets/asset_manager.hpp"

#include <SDL3/SDL_mouse.h>
#include <SDL3/SDL_surface.h>
#include <bimg/decode.h>
#include <bx/allocator.h>

#include <cstdint>
#include <cstdio>
#include <string>

namespace noveltea::sdl_platform {
namespace {

std::string custom_cursor_key(const host::CustomCursorPresentation& cursor)
{
    return cursor.id + "\n" + cursor.logical_path + "\n" + std::to_string(cursor.hotspot_x) + ":" +
           std::to_string(cursor.hotspot_y);
}

} // namespace

SdlCursorRealizer::SdlCursorRealizer(const assets::AssetManager* assets)
    : m_assets(assets), m_default(SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_DEFAULT)),
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
    clear_custom();
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

bool SdlCursorRealizer::prepare(const host::CustomCursorPresentation& cursor) noexcept
{
    return custom_cursor(cursor) != nullptr;
}

void SdlCursorRealizer::clear_custom() noexcept
{
    for (const auto& [_, cursor] : m_custom)
        SDL_DestroyCursor(cursor);
    m_custom.clear();
}

void SdlCursorRealizer::realize(const host::CursorPresentation& presentation) noexcept
{
    if (presentation.custom) {
        SDL_ShowCursor();
        if (SDL_Cursor* value = custom_cursor(*presentation.custom)) {
            SDL_SetCursor(value);
            return;
        }
        std::fprintf(stderr, "[cursor] failed to realize named cursor '%s'; using native fallback\n",
                     presentation.custom->id.c_str());
    }

    if (presentation.shape == host::CursorShape::Hidden) {
        SDL_HideCursor();
        return;
    }

    SDL_ShowCursor();
    if (SDL_Cursor* value = cursor(presentation.shape))
        SDL_SetCursor(value);
}

SDL_Cursor* SdlCursorRealizer::custom_cursor(const host::CustomCursorPresentation& cursor) noexcept
{
    const std::string key = custom_cursor_key(cursor);
    if (const auto found = m_custom.find(key); found != m_custom.end())
        return found->second;
    if (!m_assets || cursor.logical_path.empty())
        return nullptr;

    auto bytes = m_assets->read_binary(cursor.logical_path);
    if (!bytes || bytes.value->bytes.empty())
        return nullptr;

    bx::DefaultAllocator allocator;
    bimg::ImageContainer* image =
        bimg::imageParse(&allocator, bytes.value->bytes.data(),
                         static_cast<std::uint32_t>(bytes.value->bytes.size()),
                         bimg::TextureFormat::RGBA8);
    if (!image || !image->m_data || image->m_format != bimg::TextureFormat::RGBA8 ||
        image->m_numLayers != 1 || image->m_depth != 1 || image->m_numMips != 1 ||
        image->m_width != cursor.width || image->m_height != cursor.height ||
        image->m_size != image->m_width * image->m_height * 4u) {
        if (image)
            bimg::imageFree(image);
        return nullptr;
    }

    SDL_Surface* surface = SDL_CreateSurfaceFrom(
        static_cast<int>(image->m_width), static_cast<int>(image->m_height), SDL_PIXELFORMAT_RGBA32,
        image->m_data, static_cast<int>(image->m_width * 4u));
    SDL_Cursor* realized =
        surface ? SDL_CreateColorCursor(surface, static_cast<int>(cursor.hotspot_x),
                                        static_cast<int>(cursor.hotspot_y))
                : nullptr;
    if (surface)
        SDL_DestroySurface(surface);
    bimg::imageFree(image);
    if (realized)
        m_custom.emplace(key, realized);
    return realized;
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
