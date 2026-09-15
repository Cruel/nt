#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "platform/sdl/sdl_cursor_realizer.hpp"

#include <SDL3/SDL.h>
#include <catch2/catch_test_macros.hpp>

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
    SdlVideoScope sdl;
    REQUIRE(sdl.initialized);

    auto source = std::make_shared<noveltea::assets::MemoryAssetSource>();
    source->add("cursor.png", one_pixel_png());
    noveltea::assets::AssetManager assets;
    assets.mount("project", source);

    noveltea::sdl_platform::SdlCursorRealizer realizer(&assets);
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
    (void)realizer.realize({.shape = noveltea::host::CursorShape::Default});

    auto missing = custom;
    missing.id = "missing";
    missing.logical_path = "project:/missing.png";
    CHECK_FALSE(realizer.prepare(missing));
    const auto fallback =
        realizer.realize({.shape = noveltea::host::CursorShape::Pointer, .custom = missing});
    CHECK(fallback.shape == noveltea::host::CursorShape::Pointer);
    CHECK_FALSE(fallback.custom);
    (void)realizer.realize({.shape = noveltea::host::CursorShape::Default});
}

TEST_CASE("SDL cursor realizer preserves edge hotspots and reuses equivalent realizations")
{
    SdlVideoScope sdl;
    REQUIRE(sdl.initialized);

    auto source = std::make_shared<noveltea::assets::MemoryAssetSource>();
    source->add("wide.tga", solid_tga(256, 1));
    noveltea::assets::AssetManager assets;
    assets.mount("project", source);
    noveltea::sdl_platform::SdlCursorRealizer realizer(&assets);

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

    source->add("wide.tga", {0x00, 0x01, 0x02});
    auto equivalent = fitted;
    equivalent.id = "rcss-wide";
    equivalent.width = 128;
    equivalent.height = 1;
    REQUIRE(realizer.prepare(equivalent));
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
