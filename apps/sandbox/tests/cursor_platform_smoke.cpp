#include "cursor_platform_smoke.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "platform/sdl/sdl_cursor_realizer.hpp"

#include <cstdio>
#include <memory>
#include <optional>

namespace noveltea::sandbox {
namespace {

assets::AssetBytes cursor_smoke_png()
{
    return {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99,
            0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82};
}

} // namespace

void run_cursor_platform_smoke()
{
    auto source = std::make_shared<assets::MemoryAssetSource>();
    source->add("cursor-smoke.png", cursor_smoke_png());
    assets::AssetManager asset_manager;
    asset_manager.mount("project", source);
    sdl_platform::SdlCursorRealizer realizer(&asset_manager);
    const host::CustomCursorPresentation custom{
        .id = "platform-smoke",
        .logical_path = "project:/cursor-smoke.png",
        .width = 1,
        .height = 1,
        .hotspot_x = 0,
        .hotspot_y = 0,
    };
    const bool realized = realizer.prepare(custom);
    realizer.realize({.shape = host::CursorShape::Pointer, .custom = custom});
    std::printf("[cursor-platform-smoke] custom=%s\n", realized ? "realized" : "fallback");
    realizer.realize({.shape = host::CursorShape::Hidden, .custom = std::nullopt});
    realizer.realize({.shape = host::CursorShape::Default, .custom = std::nullopt});
}

} // namespace noveltea::sandbox
