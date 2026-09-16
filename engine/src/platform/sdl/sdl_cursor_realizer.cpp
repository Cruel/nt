#include "platform/sdl/sdl_cursor_realizer.hpp"

#include "noveltea/assets/asset_manager.hpp"

#include <SDL3/SDL_mouse.h>
#include <SDL3/SDL_surface.h>
#include <bimg/decode.h>
#include <bx/allocator.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>

namespace noveltea::sdl_platform {
namespace {

std::string custom_cursor_key(std::string_view logical_path, std::uint32_t width,
                              std::uint32_t height, std::uint32_t hotspot_x,
                              std::uint32_t hotspot_y, host::CursorImageSampling sampling)
{
    return std::string(logical_path) + "\n" + std::to_string(width) + "x" + std::to_string(height) +
           "\n" + std::to_string(hotspot_x) + ":" + std::to_string(hotspot_y) + "\n" +
           (sampling == host::CursorImageSampling::Nearest ? "nearest" : "linear");
}

std::uint32_t scaled_hotspot(std::uint32_t source_coordinate, std::uint32_t source_extent,
                             std::uint32_t target_extent) noexcept
{
    if (source_extent == 0 || target_extent == 0)
        return 0;
    return static_cast<std::uint32_t>(
        (static_cast<std::uint64_t>(source_coordinate) * target_extent) / source_extent);
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
    m_decoded_images.clear();
}

host::CursorPresentation
SdlCursorRealizer::realize(const host::CursorPresentation& presentation) noexcept
{
    if (presentation.custom) {
        SDL_ShowCursor();
        if (SDL_Cursor* value = custom_cursor(*presentation.custom)) {
            SDL_SetCursor(value);
            return presentation;
        }
        std::fprintf(stderr,
                     "[cursor] failed to realize named cursor '%s'; using native fallback\n",
                     presentation.custom->id.c_str());
    }

    const host::CursorPresentation fallback{.shape = presentation.shape, .custom = std::nullopt};
    if (presentation.shape == host::CursorShape::Hidden) {
        SDL_HideCursor();
        return fallback;
    }

    SDL_ShowCursor();
    if (SDL_Cursor* value = cursor(presentation.shape))
        SDL_SetCursor(value);
    return fallback;
}

SdlCursorRealizer::DecodedCursorImage*
SdlCursorRealizer::decoded_image(std::string_view logical_path) noexcept
{
    if (const auto found = m_decoded_images.find(std::string(logical_path));
        found != m_decoded_images.end())
        return &found->second;
    if (!m_assets || logical_path.empty())
        return nullptr;

    auto bytes = m_assets->read_binary(logical_path);
    if (!bytes || bytes.value->bytes.empty())
        return nullptr;

    bx::DefaultAllocator allocator;
    bimg::ImageContainer* image = bimg::imageParse(
        &allocator, bytes.value->bytes.data(),
        static_cast<std::uint32_t>(bytes.value->bytes.size()), bimg::TextureFormat::RGBA8);
    if (!image || !image->m_data || image->m_format != bimg::TextureFormat::RGBA8 ||
        image->m_numLayers != 1 || image->m_depth != 1 || image->m_numMips != 1 ||
        image->m_size != image->m_width * image->m_height * 4u) {
        if (image)
            bimg::imageFree(image);
        return nullptr;
    }

    DecodedCursorImage decoded{
        .width = image->m_width,
        .height = image->m_height,
        .rgba = std::vector<std::uint8_t>(static_cast<const std::uint8_t*>(image->m_data),
                                          static_cast<const std::uint8_t*>(image->m_data) +
                                              image->m_size),
    };
    bimg::imageFree(image);
    return &m_decoded_images.emplace(std::string(logical_path), std::move(decoded)).first->second;
}

SDL_Cursor* SdlCursorRealizer::custom_cursor(const host::CustomCursorPresentation& cursor) noexcept
{
    DecodedCursorImage* image = decoded_image(cursor.logical_path);
    if (!image || image->width == 0 || image->height == 0 || cursor.hotspot_x >= image->width ||
        cursor.hotspot_y >= image->height)
        return nullptr;
    if (!cursor.fit_to_portable_bound &&
        (image->width != cursor.width || image->height != cursor.height))
        return nullptr;

    std::uint32_t target_width = image->width;
    std::uint32_t target_height = image->height;
    if (cursor.fit_to_portable_bound) {
        const auto fitted = host::fit_cursor_image_size(image->width, image->height);
        target_width = cursor.width != 0 ? cursor.width : fitted.width;
        target_height = cursor.height != 0 ? cursor.height : fitted.height;
    }
    if (target_width == 0 || target_height == 0)
        return nullptr;

    const std::uint32_t hotspot_x =
        target_width == image->width ? cursor.hotspot_x
                                     : scaled_hotspot(cursor.hotspot_x, image->width, target_width);
    const std::uint32_t hotspot_y =
        target_height == image->height
            ? cursor.hotspot_y
            : scaled_hotspot(cursor.hotspot_y, image->height, target_height);
    const std::string key = custom_cursor_key(cursor.logical_path, target_width, target_height,
                                              hotspot_x, hotspot_y, cursor.sampling);
    if (const auto found = m_custom.find(key); found != m_custom.end())
        return found->second;

    SDL_Surface* source_surface = SDL_CreateSurfaceFrom(
        static_cast<int>(image->width), static_cast<int>(image->height), SDL_PIXELFORMAT_RGBA32,
        image->rgba.data(), static_cast<int>(image->width * 4u));
    SDL_Surface* cursor_surface = source_surface;
    SDL_Surface* scaled_surface = nullptr;
    if (source_surface && (target_width != image->width || target_height != image->height)) {
        scaled_surface = SDL_ScaleSurface(
            source_surface, static_cast<int>(target_width), static_cast<int>(target_height),
            cursor.sampling == host::CursorImageSampling::Nearest ? SDL_SCALEMODE_NEAREST
                                                                  : SDL_SCALEMODE_LINEAR);
        cursor_surface = scaled_surface;
    }
    SDL_Cursor* realized = cursor_surface
                               ? SDL_CreateColorCursor(cursor_surface, static_cast<int>(hotspot_x),
                                                       static_cast<int>(hotspot_y))
                               : nullptr;
    if (scaled_surface)
        SDL_DestroySurface(scaled_surface);
    if (source_surface)
        SDL_DestroySurface(source_surface);
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
