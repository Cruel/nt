#pragma once

#if defined(NOVELTEA_HAS_LUA) || defined(NOVELTEA_HAS_BGFX) || defined(NOVELTEA_HAS_RENDER2D) ||   \
    defined(NOVELTEA_HAS_RMLUI) || defined(NOVELTEA_HAS_RMLUI_LUA) ||                              \
    defined(NOVELTEA_HAS_TEXT) || defined(NOVELTEA_HAS_IMGUI) ||                                   \
    defined(NOVELTEA_PLATFORM_DESKTOP) || defined(NOVELTEA_PLATFORM_WEB) ||                        \
    defined(NOVELTEA_PLATFORM_ANDROID) || defined(NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT) ||          \
    defined(NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT) || defined(NOVELTEA_DEFAULT_CACHE_ASSET_ROOT)
#error "A private engine, backend, platform, or Lua compile definition leaked to a public consumer"
#endif
