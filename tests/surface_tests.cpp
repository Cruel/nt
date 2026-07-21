#include "noveltea/surface.hpp"

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <string>

using namespace noveltea;

namespace {

PresentationMetrics presentation_for(HostSurfaceMetrics host, IntegerSize reference = {1920, 1080},
                                     WorldRasterPolicy policy = WorldRasterPolicy::Capped)
{
    auto result = make_presentation_metrics(
        host, {.reference = {.size = reference}, .world_raster_policy = policy});
    REQUIRE(result);
    return std::move(result).value();
}

} // namespace

TEST_CASE("Host surface metrics sanitize dimensions and derive invalid host scales")
{
    HostSurfaceMetrics host;
    host.logical_size = {0, -10};
    host.framebuffer_size = {1600, 900};
    host.logical_to_framebuffer_scale = {NAN, 0.0f};

    host = sanitize_host_surface_metrics(host);
    CHECK((host.logical_size == IntegerSize{1, 1}));
    CHECK((host.framebuffer_size == IntegerSize{1600, 900}));
    CHECK(host.logical_to_framebuffer_scale.x == 1600.0f);
    CHECK(host.logical_to_framebuffer_scale.y == 900.0f);
}

TEST_CASE("Host logical and framebuffer coordinate conversions use only host metrics")
{
    const HostSurfaceMetrics host = make_host_surface_metrics(1280, 720, 1600, 900);
    CHECK(host.logical_to_framebuffer_scale.x == 1.25f);
    CHECK(host.logical_to_framebuffer_scale.y == 1.25f);

    const Vec2 framebuffer = host_logical_to_framebuffer(Vec2{64.0f, 32.0f}, host);
    CHECK(framebuffer.x == 80.0f);
    CHECK(framebuffer.y == 40.0f);

    const Vec2 logical = host_framebuffer_to_logical(framebuffer, host);
    CHECK(logical.x == 64.0f);
    CHECK(logical.y == 32.0f);

    const Rect scissor = host_logical_to_framebuffer({10.0f, 20.0f, 100.0f, 40.0f}, host);
    CHECK(scissor.x == 12.5f);
    CHECK(scissor.y == 25.0f);
    CHECK(scissor.width == 125.0f);
    CHECK(scissor.height == 50.0f);
}

TEST_CASE("Reference frame helpers derive authored geometry independent of host DPI")
{
    const ReferenceFrameMetrics reference{.size = {1280, 720}};
    CHECK(proportional_y(reference, 0.5f) == 360.0f);
    CHECK(title_font_size(reference) == Catch::Approx(59.4f));
    const Rect rect = anchored_rect(reference, {0.5f, 0.5f}, {200.0f, 100.0f});
    CHECK(rect.x == 540.0f);
    CHECK(rect.y == 310.0f);
}

TEST_CASE("Reference dimensions validate range and derive aspect and orientation")
{
    CHECK(is_valid_reference_size({1, 1}));
    CHECK(is_valid_reference_size({10000, 10000}));
    CHECK_FALSE(is_valid_reference_size({0, 1080}));
    CHECK_FALSE(is_valid_reference_size({1920, 10001}));
    CHECK((reference_aspect_ratio({1920, 1080}) == AspectRatio{16, 9}));
    CHECK((reference_aspect_ratio({1440, 1920}) == AspectRatio{3, 4}));
    CHECK(reference_orientation({1920, 1080}) == ScreenOrientation::Landscape);
    CHECK(reference_orientation({1080, 1920}) == ScreenOrientation::Portrait);
    CHECK(reference_orientation({1024, 1024}) == ScreenOrientation::Landscape);
}

TEST_CASE("Presentation construction rejects invalid reference dimensions before fitting")
{
    const auto host = make_host_surface_metrics(1280, 720, 2560, 1440);
    const auto zero = make_presentation_metrics(host, {.reference = {.size = {0, 1080}}});
    CHECK_FALSE(zero);
    CHECK(zero.error().find("1..10000") != std::string::npos);

    const auto above_max = make_presentation_metrics(host, {.reference = {.size = {1920, 10001}}});
    CHECK_FALSE(above_max);
    CHECK(above_max.error().find("1..10000") != std::string::npos);
}

TEST_CASE("Centered contain fitting derives aspect only from the reference frame")
{
    CHECK((fit_centered_viewport({1280, 720}, {1920, 1080}) == IntegerRect{0, 0, 1280, 720}));
    CHECK((fit_centered_viewport({1000, 800}, {1920, 1080}) == IntegerRect{0, 119, 1000, 562}));
    CHECK((fit_centered_viewport({1920, 1080}, {1600, 1200}) == IntegerRect{240, 0, 1440, 1080}));
    CHECK((fit_centered_viewport({3440, 1440}, {1920, 1080}) == IntegerRect{440, 0, 2560, 1440}));
    CHECK((fit_centered_viewport({720, 1280}, {1080, 1920}) == IntegerRect{0, 0, 720, 1280}));
    CHECK((fit_centered_viewport({1001, 800}, {1920, 1080}) == IntegerRect{0, 118, 1001, 563}));
}

TEST_CASE("Presentation metrics preserve named host reference viewport and raster domains")
{
    const auto presentation =
        presentation_for(make_host_surface_metrics(1001, 701, 2002, 1402), {1600, 1200});

    CHECK((presentation.host.logical_size == IntegerSize{1001, 701}));
    CHECK((presentation.host.framebuffer_size == IntegerSize{2002, 1402}));
    CHECK((presentation.reference.size == IntegerSize{1600, 1200}));
    CHECK((presentation.viewport.host_logical_rect == IntegerRect{33, 0, 934, 701}));
    CHECK((presentation.viewport.host_framebuffer_rect == IntegerRect{66, 0, 1868, 1402}));
    CHECK((presentation.viewport.reference_size == IntegerSize{1600, 1200}));
    CHECK((presentation.ui_raster.size == IntegerSize{1868, 1402}));
    CHECK((presentation.world_raster.size == IntegerSize{1600, 1200}));
    CHECK(presentation.world_raster.policy == WorldRasterPolicy::Capped);
}

TEST_CASE("World raster policy caps above reference and preserves native viewport output")
{
    CHECK((resolve_world_raster_size({1280, 720}, {1920, 1080}, WorldRasterPolicy::Capped) ==
           IntegerSize{1280, 720}));
    CHECK((resolve_world_raster_size({3840, 2160}, {1920, 1080}, WorldRasterPolicy::Capped) ==
           IntegerSize{1920, 1080}));
    CHECK((resolve_world_raster_size({1921, 1080}, {1920, 1080}, WorldRasterPolicy::Capped) ==
           IntegerSize{1920, 1080}));
    CHECK((resolve_world_raster_size({3840, 2160}, {1920, 1080}, WorldRasterPolicy::Native) ==
           IntegerSize{3840, 2160}));
}

TEST_CASE("Fractional host scale derives framebuffer viewport edges from logical edges")
{
    const auto presentation = presentation_for(make_host_surface_metrics(1000, 800, 1500, 1200));
    CHECK((presentation.viewport.host_logical_rect == IntegerRect{0, 119, 1000, 562}));
    CHECK((presentation.viewport.host_framebuffer_rect == IntegerRect{0, 179, 1500, 843}));
    CHECK((presentation.ui_raster.size == IntegerSize{1500, 843}));
    CHECK(1200 - (presentation.viewport.host_framebuffer_rect.y +
                  presentation.viewport.host_framebuffer_rect.height) ==
          178);
}

TEST_CASE("Resolved context metrics realize integer layout media and per-axis raster scales")
{
    const auto presentation = presentation_for(make_host_surface_metrics(1920, 1080, 3840, 2160));

    auto unscaled = resolve_context_metrics(presentation, 1.0f, true);
    REQUIRE(unscaled);
    CHECK((unscaled.value().layout_size == IntegerSize{1920, 1080}));
    CHECK((unscaled.value().media_query_size == IntegerSize{3840, 2160}));
    CHECK(unscaled.value().ui_raster_scale.x == Catch::Approx(2.0f));
    CHECK(unscaled.value().ui_raster_scale.y == Catch::Approx(2.0f));
    CHECK(unscaled.value().font_raster_scale == Catch::Approx(2.0f));
    CHECK(unscaled.value().text_scale_factor == Catch::Approx(1.0f));

    auto inherited = resolve_context_metrics(presentation, 1.25f, true);
    REQUIRE(inherited);
    CHECK((inherited.value().layout_size == IntegerSize{1536, 864}));
    CHECK(inherited.value().reference_to_context_scale.x == Catch::Approx(0.8f));
    CHECK(inherited.value().context_to_reference_scale.x == Catch::Approx(1.25f));
    CHECK(inherited.value().ui_raster_scale.x == Catch::Approx(2.5f));
    CHECK(inherited.value().ui_raster_scale.y == Catch::Approx(2.5f));
    CHECK(inherited.value().font_raster_scale == Catch::Approx(2.5f));

    auto ignored = resolve_context_metrics(presentation, 1.25f, false);
    REQUIRE(ignored);
    CHECK((ignored.value().layout_size == IntegerSize{1920, 1080}));
    CHECK(ignored.value().requested_ui_scale == 1.0f);
}

TEST_CASE("Resolved context metrics reject invalid runtime UI scale")
{
    const auto presentation = presentation_for(make_host_surface_metrics(1920, 1080, 1920, 1080));
    CHECK_FALSE(resolve_context_metrics(presentation, 0.0f, true));
    CHECK_FALSE(resolve_context_metrics(presentation, NAN, true));
}

TEST_CASE("Presentation diagnostics name every coordinate and raster domain")
{
    const auto presentation = presentation_for(make_host_surface_metrics(1000, 800, 1500, 1200));
    const std::string text = format_presentation_metrics(presentation);
    CHECK(text.find("host.logical=") != std::string::npos);
    CHECK(text.find("host.framebuffer=") != std::string::npos);
    CHECK(text.find("host.logical_to_framebuffer=") != std::string::npos);
    CHECK(text.find("reference=") != std::string::npos);
    CHECK(text.find("viewport.host_logical=") != std::string::npos);
    CHECK(text.find("viewport.host_framebuffer=") != std::string::npos);
    CHECK(text.find("world_raster=") != std::string::npos);
    CHECK(text.find("ui_raster=") != std::string::npos);
    CHECK(text.find("reference_to_world_raster_scale=") != std::string::npos);
    CHECK(text.find("reference_to_native_ui_raster_scale=") != std::string::npos);
    CHECK(text.find("world_raster_to_native_game_viewport_scale=") != std::string::npos);
    CHECK(text.find("dpi") == std::string::npos);

    const auto context = resolve_context_metrics(presentation, 1.25f, true);
    REQUIRE(context);
    const std::string context_text = format_resolved_context_metrics(context.value());
    CHECK(context_text.find("context.context_logical_to_native_ui_raster_scale=") !=
          std::string::npos);
    CHECK(context_text.find("context.text_scale_factor=") != std::string::npos);
    CHECK(context_text.find("context.font_raster_scale=") != std::string::npos);
    CHECK(context_text.find("dpi") == std::string::npos);
}

TEST_CASE("Presentation transform exposes explicit raster scales and exact odd viewport crop")
{
    const auto presentation =
        presentation_for(make_host_surface_metrics(1000, 800, 1500, 1200), {1280, 720});
    const PresentationTransform transform{presentation};

    const AxisScale reference_to_world = transform.reference_to_world_raster_scale();
    CHECK(reference_to_world.x == Catch::Approx(1.0f));
    CHECK(reference_to_world.y == Catch::Approx(1.0f));

    const AxisScale reference_to_ui = transform.reference_to_native_ui_raster_scale();
    CHECK(reference_to_ui.x == Catch::Approx(1500.0f / 1280.0f));
    CHECK(reference_to_ui.y == Catch::Approx(843.0f / 720.0f));

    const AxisScale world_to_viewport = transform.world_raster_to_native_game_viewport_scale();
    CHECK(world_to_viewport.x == Catch::Approx(reference_to_ui.x));
    CHECK(world_to_viewport.y == Catch::Approx(reference_to_ui.y));

    CHECK((transform.fitted_viewport_crop_in_host_framebuffer() == IntegerRect{0, 179, 1500, 843}));

    const Rect native_rect =
        transform.world_raster_to_native_game_viewport({10.5f, 20.25f, 100.5f, 40.75f});
    CHECK(native_rect.x == Catch::Approx(10.5f * world_to_viewport.x));
    CHECK(native_rect.y == Catch::Approx(20.25f * world_to_viewport.y));
    CHECK(native_rect.width == Catch::Approx(100.5f * world_to_viewport.x));
    CHECK(native_rect.height == Catch::Approx(40.75f * world_to_viewport.y));

    const auto context = resolve_context_metrics(presentation, 1.25f, true);
    REQUIRE(context);
    const AxisScale context_to_ui =
        transform.context_logical_to_native_ui_raster_scale(context.value());
    CHECK(context_to_ui.x == Catch::Approx(context.value().ui_raster_scale.x));
    CHECK(context_to_ui.y == Catch::Approx(context.value().ui_raster_scale.y));
}

TEST_CASE("Normalized viewport projection preserves fractions and does not clamp")
{
    const auto presentation = presentation_for(make_host_surface_metrics(1000, 800, 2000, 1600));
    const PresentationTransform transform{presentation};

    const Vec2 extrapolated = transform.normalized_game_viewport_to_reference({1.25f, -0.5f});
    CHECK(extrapolated.x == Catch::Approx(2400.0f));
    CHECK(extrapolated.y == Catch::Approx(-540.0f));
}

TEST_CASE("Presentation transform maps touch and context coordinates back to host logical space")
{
    const auto presentation = presentation_for(make_host_surface_metrics(1000, 800, 1500, 1200));
    const PresentationTransform transform{presentation};

    const Vec2 host_touch = transform.normalized_host_surface_to_host_logical({0.25f, 0.75f});
    CHECK(host_touch.x == Catch::Approx(250.0f));
    CHECK(host_touch.y == Catch::Approx(600.0f));

    const Vec2 host_reference = transform.reference_to_host_logical({960.0f, 540.0f});
    CHECK(host_reference.x == Catch::Approx(500.0f));
    CHECK(host_reference.y == Catch::Approx(400.0f));

    const auto context = resolve_context_metrics(presentation, 1.25f, true);
    REQUIRE(context);
    const Vec2 host_context =
        transform.context_logical_to_host_logical({768.0f, 432.0f}, context.value());
    CHECK(host_context.x == Catch::Approx(500.0f));
    CHECK(host_context.y == Catch::Approx(400.0f));
}

TEST_CASE("Legacy viewport-local conversion retains bar rejection and half-open edges")
{
    const auto presentation = presentation_for(make_host_surface_metrics(1000, 800, 2000, 1600));
    CHECK_FALSE(host_to_viewport_logical({500.0f, 118.0f}, presentation));
    CHECK_FALSE(host_to_viewport_logical({1000.0f, 300.0f}, presentation));

    const auto origin = host_to_viewport_logical({0.0f, 119.0f}, presentation);
    REQUIRE(origin);
    CHECK(origin->x == 0.0f);
    CHECK(origin->y == 0.0f);

    const auto last = host_to_viewport_logical({999.0f, 680.0f}, presentation);
    REQUIRE(last);
    CHECK(last->x == 999.0f);
    CHECK(last->y == 561.0f);

    CHECK_FALSE(host_to_viewport_logical({-0.01f, 300.0f}, presentation));
    CHECK_FALSE(host_to_viewport_logical({500.0f, 681.0f}, presentation));
}
