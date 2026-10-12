#include "devtools/debug_ui.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"
#include "platform/sdl/sdl_platform.hpp"
#include "render/bgfx/bgfx_renderer_internal.hpp"

#include <bgfx/bgfx.h>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <string>
#include <vector>

namespace {
struct DebugCompositionFixture {
    noveltea::Platform platform;
    noveltea::assets::AssetManager assets;
    noveltea::Renderer renderer;
    noveltea::DebugUI debug_ui;
    bgfx::TextureHandle color = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle readback = BGFX_INVALID_HANDLE;
    bgfx::FrameBufferHandle framebuffer = BGFX_INVALID_HANDLE;
    std::vector<std::array<std::uint8_t, 4>> pixels;

    ~DebugCompositionFixture()
    {
        debug_ui.shutdown();
        if (bgfx::isValid(framebuffer))
            bgfx::destroy(framebuffer);
        if (bgfx::isValid(color))
            bgfx::destroy(color);
        if (bgfx::isValid(readback))
            bgfx::destroy(readback);
        renderer.shutdown();
    }
};
} // namespace

TEST_CASE("Native ImGui remains visible after presentation clear", "[gpu][imgui]")
{
    using namespace noveltea;
    using namespace noveltea::bgfx_backend;
    constexpr std::uint16_t size = 512;
    DebugCompositionFixture fixture;
    REQUIRE(fixture.platform.initialize(
        {.title = "ImGui Composition Regression", .width = size, .height = size, .vsync = false}));
    fixture.assets.mount_directory("system",
                                   std::string(NOVELTEA_TEST_RUNTIME_ASSET_ROOT) + "/system");
    const auto handles = fixture.platform.native_window_handles();
    const auto presentation = make_presentation_metrics(fixture.platform.surface(),
                                                        {.reference = {.size = {size, size}}});
    REQUIRE(presentation);
    REQUIRE(fixture.renderer.initialize({.native_display = handles.display,
                                         .native_window = handles.window,
                                         .native_window_type = handles.type,
                                         .presentation = presentation.value(),
                                         .vsync = false,
                                         .assets = &fixture.assets}));
    REQUIRE(fixture.debug_ui.initialize(sdl_platform::native_window(fixture.platform),
                                        &fixture.assets));
    fixture.debug_ui.toggle_visibility();
    fixture.debug_ui.reset_window_rect();

    fixture.color =
        bgfx::createTexture2D(size, size, false, 1, bgfx::TextureFormat::RGBA8, BGFX_TEXTURE_RT);
    fixture.readback = bgfx::createTexture2D(size, size, false, 1, bgfx::TextureFormat::RGBA8,
                                             BGFX_TEXTURE_BLIT_DST | BGFX_TEXTURE_READ_BACK);
    REQUIRE(bgfx::isValid(fixture.color));
    REQUIRE(bgfx::isValid(fixture.readback));
    fixture.framebuffer = bgfx::createFrameBuffer(1, &fixture.color, false);
    REQUIRE(bgfx::isValid(fixture.framebuffer));

    for (unsigned frame = 0; frame < 4; ++frame) {
        fixture.renderer.begin_frame();
        // All presentation views share one target, as on the ordinary host backbuffer.
        for (std::uint16_t view = 0; view < bgfx::getCaps()->limits.maxViews; ++view) {
            bgfx::setViewFrameBuffer(view, fixture.framebuffer);
            bgfx::setViewClear(view, BGFX_CLEAR_NONE);
        }
        bgfx::setViewClear(ViewPresentationClear, BGFX_CLEAR_COLOR, 0x123456ff);
        bgfx::touch(ViewPresentationClear);
        fixture.debug_ui.begin_frame(fixture.platform.surface());
        (void)fixture.debug_ui.end_frame({}, {}, {}, 0);
        fixture.renderer.end_frame();
    }

    // Copy in the following frame so readback cannot precede the debugger's final view.
    bgfx::TextureRegion readback_region;
    readback_region.init(fixture.readback, 0, 0, size, size);
    bgfx::TextureRegion color_region;
    color_region.init(fixture.color, 0, 0, size, size);
    bgfx::blit(0, readback_region, color_region);
    fixture.pixels.resize(size * size);
    const auto ready_frame = bgfx::read(readback_region, fixture.pixels.data());
    bool ready = false;
    for (unsigned frame = 0; frame < 16; ++frame) {
        if (bgfx::frame() >= ready_frame) {
            ready = true;
            break;
        }
    }
    REQUIRE(ready);
    const std::array<std::uint8_t, 4> clear{0x12, 0x34, 0x56, 0xff};
    const auto visible_pixels = std::count_if(fixture.pixels.begin(), fixture.pixels.end(),
                                              [&](const auto& pixel) { return pixel != clear; });
    CHECK(visible_pixels > 1000);
}
