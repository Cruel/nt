#include "noveltea/render/rasterization_policy.hpp"
#include "noveltea/surface.hpp"

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>

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

TEST_CASE("Actual DPR preview tuples survive fitted viewport and context quantization")
{
    constexpr std::array dprs{1.0, 1.25, 1.5, 2.0};
    constexpr std::array logical_sizes{IntegerSize{600, 400}, IntegerSize{601, 401}};
    constexpr std::array ui_scales{1.0f, 1.1f, 1.3f};

    for (const auto logical : logical_sizes) {
        for (const double dpr : dprs) {
            const IntegerSize framebuffer{
                static_cast<int>(std::lround(logical.width * dpr)),
                static_cast<int>(std::lround(logical.height * dpr)),
            };
            const auto presentation = presentation_for(logical, framebuffer, {1920, 1080});

            CHECK((presentation.host.logical_size == logical));
            CHECK((presentation.host.framebuffer_size == framebuffer));
            for (const float ui_scale : ui_scales) {
                INFO("logical=" << logical.width << 'x' << logical.height
                                << " framebuffer=" << framebuffer.width << 'x' << framebuffer.height
                                << " ui_scale=" << ui_scale);
                const auto context = resolve_context_metrics(presentation, ui_scale, true);
                REQUIRE(context);
                CHECK((context.value().media_query_size == presentation.ui_raster.size));
            }
        }
    }

    const auto fractional = presentation_for({600, 400}, {900, 600}, {1920, 1080});
    CHECK((fractional.viewport.host_logical_rect == IntegerRect{0, 31, 600, 337}));
    CHECK((fractional.ui_raster.size == IntegerSize{900, 505}));
    const auto fractional_context = resolve_context_metrics(fractional, 1.0f, true);
    REQUIRE(fractional_context);
    CHECK(std::abs(fractional_context.value().layout_size.height *
                       fractional_context.value().ui_raster_scale.x -
                   fractional.ui_raster.size.height) > 1.0f);

    const auto fractional_css = presentation_for({601, 400}, {752, 500}, {1920, 1080});
    const auto fractional_css_context = resolve_context_metrics(fractional_css, 1.3f, true);
    REQUIRE(fractional_css_context);
    CHECK((fractional_css_context.value().media_query_size == fractional_css.ui_raster.size));

    const auto two_x_scaled = presentation_for({600, 400}, {1200, 800}, {1920, 1080});
    const auto two_x_scaled_context = resolve_context_metrics(two_x_scaled, 1.1f, true);
    REQUIRE(two_x_scaled_context);
    CHECK(std::abs(two_x_scaled_context.value().layout_size.height *
                       two_x_scaled_context.value().ui_raster_scale.x -
                   two_x_scaled.ui_raster.size.height) > 1.0f);
}

TEST_CASE("Actual DPR contract rejects genuinely nonuniform host transforms")
{
    const auto nonuniform = make_presentation_metrics(
        make_host_surface_metrics(600, 400, 900, 700),
        {.reference = {.size = {1920, 1080}}, .world_raster_policy = WorldRasterPolicy::Capped});
    REQUIRE_FALSE(nonuniform);
    CHECK(nonuniform.error().find("nonuniform transform") != std::string::npos);

    auto presentation = presentation_for({600, 400}, {900, 600}, {1920, 1080});
    presentation.ui_raster.size.height += 1;
    const auto inconsistent_projection = resolve_context_metrics(presentation, 1.0f, true);
    REQUIRE_FALSE(inconsistent_projection);
    CHECK(inconsistent_projection.error().find("projected fitted viewport edges") !=
          std::string::npos);
}

TEST_CASE("Production viewport fitting preserves deterministic odd-pixel bar ownership")
{
    const auto presentation = presentation_for({1000, 800}, {1500, 1200}, {1280, 720});
    const PresentationTransform transform{presentation};

    CHECK((presentation.viewport.host_logical_rect == IntegerRect{0, 119, 1000, 562}));
    CHECK((presentation.viewport.host_framebuffer_rect == IntegerRect{0, 179, 1500, 843}));
    CHECK((presentation.ui_raster.size == IntegerSize{1500, 843}));
    CHECK((presentation.world_raster.size == IntegerSize{1280, 720}));
    CHECK((transform.fitted_viewport_crop_in_host_framebuffer() == IntegerRect{0, 179, 1500, 843}));
    CHECK(presentation.host.framebuffer_size.height -
              (presentation.viewport.host_framebuffer_rect.y +
               presentation.viewport.host_framebuffer_rect.height) ==
          178);

    const Rect native_viewport =
        transform.world_raster_to_native_game_viewport({0.0f, 0.0f, 1280.0f, 720.0f});
    CHECK(native_viewport.x == Catch::Approx(0.0f));
    CHECK(native_viewport.y == Catch::Approx(0.0f));
    CHECK(native_viewport.width == Catch::Approx(1500.0f));
    CHECK(native_viewport.height == Catch::Approx(843.0f));
}

TEST_CASE("Presentation transform rejects bars and preserves fractional host projection")
{
    const auto presentation = presentation_for({1000, 800}, {2000, 1600}, {1920, 1080});
    const PresentationTransform transform{presentation};

    CHECK_FALSE(transform.host_logical_to_normalized_game_viewport({500.0f, 118.999f}));
    CHECK_FALSE(transform.host_logical_to_normalized_game_viewport({500.0f, 681.0f}));
    CHECK_FALSE(transform.host_logical_to_normalized_game_viewport({-0.001f, 400.0f}));
    CHECK_FALSE(transform.host_logical_to_normalized_game_viewport({1000.0f, 400.0f}));

    const auto first = transform.host_logical_to_normalized_game_viewport({0.0f, 119.0f});
    REQUIRE(first);
    CHECK(first->x == Catch::Approx(0.0f));
    CHECK(first->y == Catch::Approx(0.0f));

    const auto center = transform.host_logical_to_normalized_game_viewport({500.0f, 400.0f});
    REQUIRE(center);
    CHECK(center->x == Catch::Approx(0.5f));
    CHECK(center->y == Catch::Approx(0.5f));

    const Vec2 reference = transform.normalized_game_viewport_to_reference(*center);
    CHECK(reference.x == Catch::Approx(960.0f));
    CHECK(reference.y == Catch::Approx(540.0f));

    const auto fractional = transform.host_logical_to_normalized_game_viewport({250.25f, 259.5f});
    REQUIRE(fractional);
    CHECK(fractional->x == Catch::Approx(0.25025f));
    CHECK(fractional->y == Catch::Approx(0.25f));
}

TEST_CASE("Presentation transform maps reference context and raster domains without snapping")
{
    const auto presentation = presentation_for({1920, 1080}, {3840, 2160}, {1920, 1080});
    const PresentationTransform transform{presentation};

    const Vec2 reference_point{100.25f, 50.5f};
    const Vec2 world_point = transform.reference_to_world_raster(reference_point);
    CHECK(world_point.x == Catch::Approx(100.25f));
    CHECK(world_point.y == Catch::Approx(50.5f));

    const Vec2 ui_point = transform.reference_to_native_ui_raster(reference_point);
    CHECK(ui_point.x == Catch::Approx(200.5f));
    CHECK(ui_point.y == Catch::Approx(101.0f));

    const Rect world_rect = transform.reference_to_world_raster({10.25f, 20.5f, 100.75f, 40.125f});
    CHECK(world_rect.x == Catch::Approx(10.25f));
    CHECK(world_rect.y == Catch::Approx(20.5f));
    CHECK(world_rect.width == Catch::Approx(100.75f));
    CHECK(world_rect.height == Catch::Approx(40.125f));

    const Rect ui_rect = transform.reference_to_native_ui_raster({10.25f, 20.5f, 100.75f, 40.125f});
    CHECK(ui_rect.x == Catch::Approx(20.5f));
    CHECK(ui_rect.y == Catch::Approx(41.0f));
    CHECK(ui_rect.width == Catch::Approx(201.5f));
    CHECK(ui_rect.height == Catch::Approx(80.25f));

    const auto context_result = resolve_context_metrics(presentation, 1.3f, true);
    REQUIRE(context_result);
    const ResolvedContextMetrics& context = context_result.value();
    CHECK((context.layout_size == IntegerSize{1477, 831}));

    const Vec2 context_edge = transform.reference_to_context_logical({1920.0f, 1080.0f}, context);
    CHECK(context_edge.x == Catch::Approx(1477.0f));
    CHECK(context_edge.y == Catch::Approx(831.0f));

    const Vec2 context_point = transform.reference_to_context_logical(reference_point, context);
    const Vec2 context_to_ui =
        transform.context_logical_to_native_ui_raster(context_point, context);
    CHECK(context_to_ui.x == Catch::Approx(ui_point.x));
    CHECK(context_to_ui.y == Catch::Approx(ui_point.y));

    const Vec2 context_round_trip =
        transform.native_ui_raster_to_context_logical(context_to_ui, context);
    CHECK(context_round_trip.x == Catch::Approx(context_point.x));
    CHECK(context_round_trip.y == Catch::Approx(context_point.y));
}

TEST_CASE("Rasterization policy snaps transformed edges after fractional scaling")
{
    const auto presentation = presentation_for({1280, 720}, {2560, 1440}, {1920, 1080});
    const PresentationTransform transform{presentation};
    const Rect transformed =
        transform.reference_to_native_ui_raster({10.25f, 20.5f, 100.75f, 40.125f});
    const Rect snapped = RasterizationPolicy::snap_transformed_rect_edges(transformed);

    CHECK(transformed.x == Catch::Approx(13.666667f));
    CHECK(transformed.y == Catch::Approx(27.333334f));
    CHECK(snapped.x == 14.0f);
    CHECK(snapped.y == 27.0f);
    CHECK(snapped.width == 134.0f);
    CHECK(snapped.height == 54.0f);
}

TEST_CASE("Rasterization policy preserves adjacent transformed edge continuity")
{
    const Rect left = RasterizationPolicy::snap_transformed_rect_edges({0.2f, 4.25f, 10.4f, 8.5f});
    const Rect right =
        RasterizationPolicy::snap_transformed_rect_edges({10.6f, 4.25f, 6.75f, 8.5f});

    CHECK(left.x + left.width == right.x);
    CHECK(left.y == right.y);
    CHECK(left.height == right.height);
}

TEST_CASE("Rasterization policy scissors contain transformed bounds before clipping")
{
    const Rect transformed{-0.25f, 10.75f, 21.5f, 9.125f};
    const RasterScissor contained = RasterizationPolicy::contain_transformed_scissor(transformed);

    CHECK((contained == RasterScissor{-1, 10, 23, 10}));
    CHECK(static_cast<float>(contained.x) <= transformed.x);
    CHECK(static_cast<float>(contained.y) <= transformed.y);
    CHECK(static_cast<float>(contained.x + contained.width) >= transformed.x + transformed.width);
    CHECK(static_cast<float>(contained.y + contained.height) >= transformed.y + transformed.height);

    const RasterScissor clipped = RasterizationPolicy::clip_scissor(contained, 20, 18);
    CHECK((clipped == RasterScissor{0, 10, 20, 8}));
}

TEST_CASE("Rasterization policy snaps one text origin without rounding glyph advances")
{
    const Vec2 snapped_origin = RasterizationPolicy::snap_text_run_origin({10.4f, 20.6f});
    const Vec2 first_glyph{snapped_origin.x + 0.375f, snapped_origin.y};
    const Vec2 second_glyph{snapped_origin.x + 7.8125f, snapped_origin.y};

    CHECK(snapped_origin.x == 10.0f);
    CHECK(snapped_origin.y == 21.0f);
    CHECK(first_glyph.x == Catch::Approx(10.375f));
    CHECK(second_glyph.x == Catch::Approx(17.8125f));
    CHECK(second_glyph.x - first_glyph.x == Catch::Approx(7.4375f));
}
