#include "noveltea/surface.hpp"

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

using namespace noveltea;

namespace {

PresentationMetrics presentation_for(IntegerSize host_logical, IntegerSize host_framebuffer,
                                     IntegerSize reference,
                                     WorldRasterPolicy policy = WorldRasterPolicy::Capped)
{
    auto presentation = make_presentation_metrics(
        make_host_surface_metrics(host_logical.width, host_logical.height, host_framebuffer.width,
                                  host_framebuffer.height),
        {.reference = {.size = reference}, .world_raster_policy = policy});
    REQUIRE(presentation);
    return std::move(presentation).value();
}

} // namespace

TEST_CASE("Reference contract derives normalized aspect and orientation from production metrics")
{
    CHECK((reference_aspect_ratio({1920, 1080}) == AspectRatio{16, 9}));
    CHECK((reference_aspect_ratio({1440, 1920}) == AspectRatio{3, 4}));
    CHECK(reference_orientation({1920, 1080}) == ScreenOrientation::Landscape);
    CHECK(reference_orientation({1080, 1920}) == ScreenOrientation::Portrait);
    CHECK(reference_orientation({1024, 1024}) == ScreenOrientation::Landscape);
}

TEST_CASE("World raster contract uses the production capped and native policy resolver")
{
    const auto below_reference = presentation_for({1280, 720}, {1280, 720}, {1920, 1080});
    CHECK((below_reference.world_raster.size == IntegerSize{1280, 720}));

    const auto capped = presentation_for({1920, 1080}, {3840, 2160}, {1920, 1080});
    CHECK((capped.world_raster.size == IntegerSize{1920, 1080}));
    CHECK(capped.world_raster.policy == WorldRasterPolicy::Capped);

    const auto native =
        presentation_for({1920, 1080}, {3840, 2160}, {1920, 1080}, WorldRasterPolicy::Native);
    CHECK((native.world_raster.size == IntegerSize{3840, 2160}));
    CHECK(native.world_raster.policy == WorldRasterPolicy::Native);
}

TEST_CASE("Context contract uses production integer realization and native media dimensions")
{
    const auto presentation = presentation_for({1920, 1080}, {3840, 2160}, {1920, 1080});

    const auto unscaled = resolve_context_metrics(presentation, 1.0f, true);
    REQUIRE(unscaled);
    CHECK((unscaled.value().layout_size == IntegerSize{1920, 1080}));
    CHECK((unscaled.value().media_query_size == IntegerSize{3840, 2160}));
    CHECK(unscaled.value().ui_raster_scale.x == Catch::Approx(2.0f));
    CHECK(unscaled.value().ui_raster_scale.y == Catch::Approx(2.0f));

    const auto inherited = resolve_context_metrics(presentation, 1.25f, true);
    REQUIRE(inherited);
    CHECK((inherited.value().layout_size == IntegerSize{1536, 864}));
    CHECK(inherited.value().reference_to_context_scale.x == Catch::Approx(0.8f));
    CHECK(inherited.value().context_to_reference_scale.x == Catch::Approx(1.25f));
    CHECK(inherited.value().ui_raster_scale.x == Catch::Approx(2.5f));
    CHECK(inherited.value().ui_raster_scale.y == Catch::Approx(2.5f));

    const auto ignored = resolve_context_metrics(presentation, 1.25f, false);
    REQUIRE(ignored);
    CHECK((ignored.value().layout_size == IntegerSize{1920, 1080}));
    CHECK(ignored.value().requested_ui_scale == Catch::Approx(1.0f));
}

TEST_CASE("Production viewport fitting preserves deterministic odd-pixel bar ownership")
{
    const auto presentation = presentation_for({1000, 800}, {1500, 1200}, {1920, 1080});
    CHECK((presentation.viewport.host_logical_rect == IntegerRect{0, 119, 1000, 562}));
    CHECK((presentation.viewport.host_framebuffer_rect == IntegerRect{0, 179, 1500, 843}));
    CHECK((presentation.ui_raster.size == IntegerSize{1500, 843}));
}

TEST_CASE("Production host viewport-local conversion rejects presentation bars")
{
    const auto presentation = presentation_for({1000, 800}, {2000, 1600}, {1920, 1080});

    CHECK_FALSE(host_to_viewport_logical({500.0f, 118.999f}, presentation));
    CHECK_FALSE(host_to_viewport_logical({500.0f, 681.0f}, presentation));
    CHECK_FALSE(host_to_viewport_logical({-0.001f, 400.0f}, presentation));
    CHECK_FALSE(host_to_viewport_logical({1000.0f, 400.0f}, presentation));

    const auto first = host_to_viewport_logical({0.0f, 119.0f}, presentation);
    REQUIRE(first);
    CHECK(first->x == Catch::Approx(0.0f));
    CHECK(first->y == Catch::Approx(0.0f));

    const auto last = host_to_viewport_logical({999.999f, 680.999f}, presentation);
    REQUIRE(last);
    CHECK(last->x == Catch::Approx(999.999f));
    CHECK(last->y == Catch::Approx(561.999f));
}
