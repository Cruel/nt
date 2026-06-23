#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_layers.hpp"

#include <catch2/catch_test_macros.hpp>

#include <unordered_map>

using namespace rmlui_bgfx;

TEST_CASE("RmlUi saved mask image uses valid content bounds")
{
    BgfxTargetCache target_cache;
    BgfxLayerSystem layer_system(target_cache);
    layer_system.begin_frame();

    LayerRecord& layer = target_cache.prepare_virtual_layer_slot(1);
    layer.framebuffer = bgfx::FrameBufferHandle{3};
    layer.color = bgfx::TextureHandle{4};
    layer.bounds = RenderBounds{{10.0f, 20.0f, 100.0f, 100.0f}, {10, 20, 100, 100}};
    layer.valid_content_bounds = {30, 40, 20, 15};
    layer.has_valid_content_bounds = true;
    layer.texture_width = 100;
    layer.texture_height = 100;
    layer.kind = LayerKind::VirtualChild;
    layer.materialized = true;

    layer_system.push_layer(1);

    std::unordered_map<Rml::TextureHandle, TextureRecord> textures;
    std::unordered_map<Rml::CompiledFilterHandle, FilterRecord> filters;
    Rml::TextureHandle texture_counter = 7;
    Rml::CompiledFilterHandle filter_counter = 11;
    Rml::Rectanglei copied_region = Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
    int copied_source_width = 0;
    int copied_source_height = 0;
    const char* copy_name = nullptr;

    BgfxLayerSaveMaskContext ctx;
    ctx.surface = SurfaceMetrics{200, 200, 200, 200, 1.0f, 1.0f};
    ctx.textures = &textures;
    ctx.filters = &filters;
    ctx.texture_counter = &texture_counter;
    ctx.filter_counter = &filter_counter;
    ctx.materialize_layer = [](Rml::LayerHandle, std::optional<FbRect>) { return true; };
    ctx.copy_region_to_texture = [&](bgfx::TextureHandle, Rml::Rectanglei region, int source_width,
                                     int source_height, const char* name) {
        copied_region = region;
        copied_source_width = source_width;
        copied_source_height = source_height;
        copy_name = name;
        return bgfx::TextureHandle{9};
    };

    const Rml::CompiledFilterHandle filter = layer_system.save_layer_as_mask_image(ctx);

    CHECK(filter == 12);
    REQUIRE(filters.contains(filter));
    REQUIRE(textures.contains(8));
    CHECK(copied_region.Left() == 20);
    CHECK(copied_region.Top() == 20);
    CHECK(copied_region.Width() == 20);
    CHECK(copied_region.Height() == 15);
    CHECK(copied_source_width == 100);
    CHECK(copied_source_height == 100);
    REQUIRE(copy_name != nullptr);
    CHECK(std::string_view(copy_name) == "RmlUi.SaveLayerAsMaskImage");

    const TextureRecord& texture = textures.at(8);
    CHECK(texture.dimensions.x == 20);
    CHECK(texture.dimensions.y == 15);
    CHECK(texture.bounds.framebuffer.x == 30);
    CHECK(texture.bounds.framebuffer.y == 40);
    CHECK(texture.bounds.framebuffer.w == 20);
    CHECK(texture.bounds.framebuffer.h == 15);

    const FilterRecord& record = filters.at(filter);
    CHECK(record.kind == FilterKind::MaskImage);
    CHECK(record.resource == 8);
    CHECK(record.mask_bounds[0] == 30);
    CHECK(record.mask_bounds[1] == 40);
    CHECK(record.mask_bounds[2] == 20);
    CHECK(record.mask_bounds[3] == 15);

    layer.framebuffer = BGFX_INVALID_HANDLE;
}
