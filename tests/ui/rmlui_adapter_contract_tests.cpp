#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

namespace noveltea::ui::rmlui {
namespace {

PresentationMetrics presentation_at(IntegerSize ui_size)
{
    PresentationMetrics presentation;
    presentation.reference.size = {1920, 1080};
    presentation.ui_raster.size = ui_size;
    presentation.viewport.host_framebuffer_rect = {0, 0, ui_size.width, ui_size.height};
    return presentation;
}

ResolvedContextMetrics context_at(IntegerSize logical_size, AxisScale ui_raster_scale)
{
    ResolvedContextMetrics context;
    context.layout_size = logical_size;
    context.media_query_size = {3840, 2160};
    context.ui_raster_scale = ui_raster_scale;
    context.font_raster_scale = ui_raster_scale.x;
    return context;
}

} // namespace

TEST_CASE("RmlUi adapter surface uses exact active context metrics")
{
    const PresentationMetrics presentation = presentation_at({3840, 2160});
    const ResolvedContextMetrics one_x = context_at({3840, 2160}, {1.0f, 1.0f});
    const ResolvedContextMetrics two_x = context_at({1920, 1080}, {2.0f, 2.0f});

    const auto one_x_surface = to_rmlui_bgfx_surface(presentation, one_x);
    REQUIRE(one_x_surface);
    CHECK(one_x_surface->logical_width == 3840);
    CHECK(one_x_surface->logical_height == 2160);
    CHECK(one_x_surface->framebuffer_width == 3840);
    CHECK(one_x_surface->framebuffer_height == 2160);
    CHECK(one_x_surface->scale_x == 1.0f);
    CHECK(one_x_surface->scale_y == 1.0f);

    const auto two_x_surface = to_rmlui_bgfx_surface(presentation, two_x);
    REQUIRE(two_x_surface);
    CHECK(two_x_surface->logical_width == 1920);
    CHECK(two_x_surface->logical_height == 1080);
    CHECK(two_x_surface->framebuffer_width == 3840);
    CHECK(two_x_surface->framebuffer_height == 2160);
    CHECK(two_x_surface->scale_x == 2.0f);
    CHECK(two_x_surface->scale_y == 2.0f);

    const auto one_x_again = to_rmlui_bgfx_surface(presentation, one_x);
    REQUIRE(one_x_again);
    CHECK(one_x_again->logical_width == one_x_surface->logical_width);
    CHECK(one_x_again->logical_height == one_x_surface->logical_height);
    CHECK(one_x_again->framebuffer_width == one_x_surface->framebuffer_width);
    CHECK(one_x_again->framebuffer_height == one_x_surface->framebuffer_height);
    CHECK(one_x_again->scale_x == one_x_surface->scale_x);
    CHECK(one_x_again->scale_y == one_x_surface->scale_y);
}

TEST_CASE("RmlUi adapter snaps submission origins only after logical-to-raster transform")
{
    const ResolvedContextMetrics one_x = context_at({3840, 2160}, {1.0f, 1.0f});
    const ResolvedContextMetrics two_x = context_at({1920, 1080}, {2.0f, 2.0f});

    const Rml::Vector2f one_x_origin = snap_rmlui_submission_translation({10.25f, 20.75f}, one_x);
    CHECK_THAT(one_x_origin.x, Catch::Matchers::WithinAbs(10.0f, 0.0001f));
    CHECK_THAT(one_x_origin.y, Catch::Matchers::WithinAbs(21.0f, 0.0001f));

    const Rml::Vector2f two_x_origin = snap_rmlui_submission_translation({10.25f, 20.25f}, two_x);
    CHECK_THAT(two_x_origin.x, Catch::Matchers::WithinAbs(10.5f, 0.0001f));
    CHECK_THAT(two_x_origin.y, Catch::Matchers::WithinAbs(20.5f, 0.0001f));

    const Rml::Vector2f fractional_advance{two_x_origin.x + 0.375f, two_x_origin.y + 0.625f};
    CHECK_THAT(fractional_advance.x - two_x_origin.x, Catch::Matchers::WithinAbs(0.375f, 0.0001f));
    CHECK_THAT(fractional_advance.y - two_x_origin.y, Catch::Matchers::WithinAbs(0.625f, 0.0001f));
}

} // namespace noveltea::ui::rmlui
