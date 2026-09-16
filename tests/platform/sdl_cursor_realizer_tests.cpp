#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "platform/sdl/sdl_cursor_realizer.hpp"

#include <SDL3/SDL.h>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace {

noveltea::assets::AssetBytes one_pixel_png()
{
    return {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99,
            0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82};
}

noveltea::assets::AssetBytes solid_tga(std::uint16_t width, std::uint16_t height)
{
    noveltea::assets::AssetBytes bytes(18u + static_cast<std::size_t>(width) * height * 4u, 0);
    bytes[2] = 2;
    bytes[12] = static_cast<std::uint8_t>(width & 0xffu);
    bytes[13] = static_cast<std::uint8_t>(width >> 8u);
    bytes[14] = static_cast<std::uint8_t>(height & 0xffu);
    bytes[15] = static_cast<std::uint8_t>(height >> 8u);
    bytes[16] = 32;
    bytes[17] = 0x28;
    for (std::size_t index = 18; index < bytes.size(); index += 4) {
        bytes[index + 0] = 0x20;
        bytes[index + 1] = 0x40;
        bytes[index + 2] = 0x80;
        bytes[index + 3] = 0xff;
    }
    return bytes;
}

struct NativeCursorProbe {
    int create_color_calls = 0;
    int last_hotspot_x = -1;
    int last_hotspot_y = -1;
    int last_width = 0;
    int last_height = 0;
    int show_calls = 0;
    int hide_calls = 0;
};

NativeCursorProbe* g_native_cursor_probe = nullptr;

SDL_Cursor* fake_create_system_cursor(SDL_SystemCursor shape)
{
    return reinterpret_cast<SDL_Cursor*>(static_cast<std::uintptr_t>(shape) + 1u);
}

SDL_Cursor* fake_create_color_cursor(SDL_Surface* surface, int hotspot_x, int hotspot_y)
{
    if (g_native_cursor_probe) {
        ++g_native_cursor_probe->create_color_calls;
        g_native_cursor_probe->last_hotspot_x = hotspot_x;
        g_native_cursor_probe->last_hotspot_y = hotspot_y;
        g_native_cursor_probe->last_width = surface ? surface->w : 0;
        g_native_cursor_probe->last_height = surface ? surface->h : 0;
    }
    return reinterpret_cast<SDL_Cursor*>(
        0x1000u + static_cast<std::uintptr_t>(
                      g_native_cursor_probe ? g_native_cursor_probe->create_color_calls : 1));
}

void fake_destroy_cursor(SDL_Cursor*) {}
bool fake_set_cursor(SDL_Cursor*) { return true; }
bool fake_show_cursor()
{
    if (g_native_cursor_probe)
        ++g_native_cursor_probe->show_calls;
    return true;
}
bool fake_hide_cursor()
{
    if (g_native_cursor_probe)
        ++g_native_cursor_probe->hide_calls;
    return true;
}

noveltea::sdl_platform::SdlCursorRealizer::NativeApi fake_native_cursor_api()
{
    return {.create_system_cursor = &fake_create_system_cursor,
            .create_color_cursor = &fake_create_color_cursor,
            .destroy_cursor = &fake_destroy_cursor,
            .set_cursor = &fake_set_cursor,
            .show_cursor = &fake_show_cursor,
            .hide_cursor = &fake_hide_cursor};
}

struct SdlVideoScope {
    SdlVideoScope()
    {
        SDL_SetHint(SDL_HINT_VIDEO_DRIVER, "dummy");
        initialized = SDL_InitSubSystem(SDL_INIT_VIDEO);
    }

    ~SdlVideoScope()
    {
        if (initialized)
            SDL_QuitSubSystem(SDL_INIT_VIDEO);
    }

    bool initialized = false;
};

} // namespace

TEST_CASE("SDL cursor realizer handles native custom hidden restoration and graceful failure")
{
    NativeCursorProbe probe;
    g_native_cursor_probe = &probe;
    const auto native_api = fake_native_cursor_api();

    auto source = std::make_shared<noveltea::assets::MemoryAssetSource>();
    source->add("cursor.png", one_pixel_png());
    noveltea::assets::AssetManager assets;
    assets.mount("project", source);

    noveltea::sdl_platform::SdlCursorRealizer realizer(&assets, &native_api);
    const std::vector<noveltea::host::CursorShape> system_shapes{
        noveltea::host::CursorShape::Default,    noveltea::host::CursorShape::Pointer,
        noveltea::host::CursorShape::Text,       noveltea::host::CursorShape::Wait,
        noveltea::host::CursorShape::Progress,   noveltea::host::CursorShape::Crosshair,
        noveltea::host::CursorShape::Move,       noveltea::host::CursorShape::NotAllowed,
        noveltea::host::CursorShape::NsResize,   noveltea::host::CursorShape::EwResize,
        noveltea::host::CursorShape::NeswResize, noveltea::host::CursorShape::NwseResize,
    };
    for (const auto shape : system_shapes)
        (void)realizer.realize({.shape = shape});

    const noveltea::host::CustomCursorPresentation custom{
        .id = "smoke",
        .logical_path = "project:/cursor.png",
        .width = 1,
        .height = 1,
        .hotspot_x = 0,
        .hotspot_y = 0,
        .sampling = noveltea::host::CursorImageSampling::Nearest,
    };
    REQUIRE(realizer.prepare(custom));
    REQUIRE(realizer.prepare(custom));
    (void)realizer.realize({.shape = noveltea::host::CursorShape::Pointer, .custom = custom});

    (void)realizer.realize({.shape = noveltea::host::CursorShape::Hidden});
    CHECK(probe.hide_calls == 1);
    (void)realizer.realize({.shape = noveltea::host::CursorShape::Default});
    CHECK(probe.show_calls > 0);

    auto missing = custom;
    missing.id = "missing";
    missing.logical_path = "project:/missing.png";
    CHECK_FALSE(realizer.prepare(missing));
    const auto fallback =
        realizer.realize({.shape = noveltea::host::CursorShape::Pointer, .custom = missing});
    CHECK(fallback.shape == noveltea::host::CursorShape::Pointer);
    CHECK_FALSE(fallback.custom);
    (void)realizer.realize({.shape = noveltea::host::CursorShape::Default});
    g_native_cursor_probe = nullptr;
}

TEST_CASE("SDL cursor realizer preserves edge hotspots and reuses equivalent realizations")
{
    NativeCursorProbe probe;
    g_native_cursor_probe = &probe;
    const auto native_api = fake_native_cursor_api();

    auto source = std::make_shared<noveltea::assets::MemoryAssetSource>();
    source->add("wide.tga", solid_tga(256, 1));
    noveltea::assets::AssetManager assets;
    assets.mount("project", source);
    noveltea::sdl_platform::SdlCursorRealizer realizer(&assets, &native_api);

    const noveltea::host::CustomCursorPresentation fitted{
        .id = "lua-wide",
        .logical_path = "project:/wide.tga",
        .width = 0,
        .height = 0,
        .hotspot_x = 255,
        .hotspot_y = 0,
        .sampling = noveltea::host::CursorImageSampling::Nearest,
        .fit_to_portable_bound = true,
    };
    REQUIRE(realizer.prepare(fitted));
    CHECK(probe.create_color_calls == 1);
    CHECK(probe.last_width == 128);
    CHECK(probe.last_height == 1);
    CHECK(probe.last_hotspot_x == 127);
    CHECK(probe.last_hotspot_y == 0);

    source->add("wide.tga", {0x00, 0x01, 0x02});
    auto equivalent = fitted;
    equivalent.id = "rcss-wide";
    equivalent.width = 128;
    equivalent.height = 1;
    REQUIRE(realizer.prepare(equivalent));
    CHECK(probe.create_color_calls == 1);
    g_native_cursor_probe = nullptr;
}

TEST_CASE("Cursor authority inspection reports the realized native fallback")
{
    SdlVideoScope sdl;
    REQUIRE(sdl.initialized);

    noveltea::assets::AssetManager assets;
    noveltea::sdl_platform::SdlCursorRealizer realizer(&assets);
    noveltea::host::CursorAuthority authority(&realizer);
    const noveltea::host::CustomCursorPresentation missing{
        .id = "missing",
        .logical_path = "project:/missing.png",
        .width = 16,
        .height = 16,
    };
    authority.publish(noveltea::host::CursorRequestSource::GameplayLua, 1,
                      {.shape = noveltea::host::CursorShape::Pointer, .custom = missing},
                      "runtime-session");
    authority.set_eligible_order(noveltea::host::CursorRequestSource::GameplayLua, {1});
    authority.resolve();

    const auto& inspection = authority.inspection();
    CHECK(inspection.effective == noveltea::host::CursorShape::Pointer);
    CHECK(inspection.effective_name == "pointer");
    CHECK(inspection.source == "gameplay-lua");
    CHECK(inspection.owner == "runtime-session");
    CHECK_FALSE(inspection.custom);
}
