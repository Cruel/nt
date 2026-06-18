#include "noveltea/surface.hpp"

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>

using namespace noveltea;

TEST_CASE("SurfaceMetrics clamps dimensions and derives invalid scales")
{
    SurfaceMetrics surface;
    surface.logical_width = 0;
    surface.logical_height = -10;
    surface.framebuffer_width = 1600;
    surface.framebuffer_height = 900;
    surface.scale_x = NAN;
    surface.scale_y = 0.0f;

    surface = sanitize_surface_metrics(surface);
    CHECK(surface.logical_width == 1);
    CHECK(surface.logical_height == 1);
    CHECK(surface.framebuffer_width == 1600);
    CHECK(surface.framebuffer_height == 900);
    CHECK(surface.scale_x == 1600.0f);
    CHECK(surface.scale_y == 900.0f);
}

TEST_CASE("SurfaceMetrics converts logical and framebuffer coordinates")
{
    const SurfaceMetrics surface = make_surface_metrics(1280, 720, 1600, 900);
    CHECK(surface.scale_x == 1.25f);
    CHECK(surface.scale_y == 1.25f);

    const Vec2 physical = logical_to_framebuffer(Vec2{64.0f, 32.0f}, surface);
    CHECK(physical.x == 80.0f);
    CHECK(physical.y == 40.0f);

    const Vec2 logical = framebuffer_to_logical(physical, surface);
    CHECK(logical.x == 64.0f);
    CHECK(logical.y == 32.0f);

    const Rect scissor = logical_to_framebuffer({10.0f, 20.0f, 100.0f, 40.0f}, surface);
    CHECK(scissor.x == 12.5f);
    CHECK(scissor.y == 25.0f);
    CHECK(scissor.width == 125.0f);
    CHECK(scissor.height == 50.0f);
}

TEST_CASE("Proportional layout helpers use logical dimensions")
{
    const SurfaceMetrics surface = make_surface_metrics(1280, 720, 2560, 1440);
    CHECK(proportional_y(surface, 0.5f) == 360.0f);
    CHECK(title_font_size(surface) == Catch::Approx(59.4f));
    const Rect rect = anchored_rect(surface, {0.5f, 0.5f}, {200.0f, 100.0f});
    CHECK(rect.x == 540.0f);
    CHECK(rect.y == 310.0f);
}
