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

TEST_CASE("Display profiles normalize ratios and resolve orientation")
{
    CHECK((normalize_aspect_ratio({1920, 1080}) == AspectRatio{16, 9}));
    CHECK((normalize_aspect_ratio({0, 9}) == AspectRatio{16, 9}));
    CHECK((effective_aspect_ratio(DisplayProfile{}) == AspectRatio{16, 9}));

    DisplayProfile portrait;
    portrait.orientation = ScreenOrientation::Portrait;
    CHECK((effective_aspect_ratio(portrait) == AspectRatio{9, 16}));
}

TEST_CASE("Centered contain fitting is deterministic across common host shapes")
{
    CHECK((fit_centered_viewport(1280, 720, {16, 9}) == IntegerRect{0, 0, 1280, 720}));
    CHECK((fit_centered_viewport(1000, 800, {16, 9}) == IntegerRect{0, 119, 1000, 562}));
    CHECK((fit_centered_viewport(1920, 1080, {4, 3}) == IntegerRect{240, 0, 1440, 1080}));
    CHECK((fit_centered_viewport(3440, 1440, {16, 9}) == IntegerRect{440, 0, 2560, 1440}));
    CHECK((fit_centered_viewport(720, 1280, {9, 16}) == IntegerRect{0, 0, 720, 1280}));
    CHECK((fit_centered_viewport(1080, 2400, {9, 16}) == IntegerRect{0, 240, 1080, 1920}));
    CHECK((fit_centered_viewport(1001, 800, {16, 9}) == IntegerRect{0, 118, 1001, 563}));
    CHECK((fit_centered_viewport(1, 1, {16, 9}) == IntegerRect{0, 0, 1, 1}));
}

TEST_CASE("Presentation metrics derive framebuffer edges from the logical viewport")
{
    DisplayProfile profile;
    profile.aspect_ratio = {4, 3};
    const PresentationMetrics presentation =
        make_presentation_metrics(make_surface_metrics(1001, 701, 2002, 1402), profile);

    CHECK((presentation.host_logical_viewport == IntegerRect{33, 0, 934, 701}));
    CHECK((presentation.host_framebuffer_viewport == IntegerRect{66, 0, 1868, 1402}));
    CHECK(presentation.game_surface.logical_width == 934);
    CHECK(presentation.game_surface.framebuffer_width == 1868);

    const PresentationMetrics fractional_dpi =
        make_presentation_metrics(make_surface_metrics(1000, 800, 1500, 1200));
    CHECK((fractional_dpi.host_logical_viewport == IntegerRect{0, 119, 1000, 562}));
    CHECK((fractional_dpi.host_framebuffer_viewport == IntegerRect{0, 179, 1500, 843}));
    CHECK(fractional_dpi.game_surface.scale_x == 1.5f);
    CHECK(fractional_dpi.game_surface.scale_y == 1.5f);
}

TEST_CASE("Host pointer transforms reject bars and use half-open viewport edges")
{
    const PresentationMetrics presentation =
        make_presentation_metrics(make_surface_metrics(1000, 800, 2000, 1600));
    CHECK_FALSE(host_to_game_logical({500.0f, 118.0f}, presentation).has_value());
    CHECK_FALSE(host_to_game_logical({1000.0f, 300.0f}, presentation).has_value());

    const auto origin = host_to_game_logical({0.0f, 119.0f}, presentation);
    REQUIRE(origin.has_value());
    CHECK(origin->x == 0.0f);
    CHECK(origin->y == 0.0f);

    const auto last = host_to_game_logical({999.0f, 680.0f}, presentation);
    REQUIRE(last.has_value());
    CHECK(last->x == 999.0f);
    CHECK(last->y == 561.0f);
}
