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
        realizer.realize({.shape = shape});

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
    realizer.realize({.shape = noveltea::host::CursorShape::Pointer, .custom = custom});

    realizer.realize({.shape = noveltea::host::CursorShape::Hidden});
    realizer.realize({.shape = noveltea::host::CursorShape::Default});

    auto missing = custom;
    missing.id = "missing";
    missing.logical_path = "project:/missing.png";
    CHECK_FALSE(realizer.prepare(missing));
    realizer.realize({.shape = noveltea::host::CursorShape::Pointer, .custom = missing});
    realizer.realize({.shape = noveltea::host::CursorShape::Default});
}
