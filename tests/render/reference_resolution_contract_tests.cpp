#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <numeric>
#include <optional>

namespace {

struct IntegerSize {
    int width = 0;
    int height = 0;

    friend bool operator==(const IntegerSize&, const IntegerSize&) = default;
};

struct IntegerRect {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;

    friend bool operator==(const IntegerRect&, const IntegerRect&) = default;
};

struct Point {
    double x = 0.0;
    double y = 0.0;
};

struct AspectRatio {
    int width = 0;
    int height = 0;

    friend bool operator==(const AspectRatio&, const AspectRatio&) = default;
};

enum class Orientation : std::uint8_t {
    Landscape,
    Portrait,
};

enum class WorldRasterPolicy : std::uint8_t {
    Capped,
    Native,
};

struct ContextMetrics {
    double effective_ui_scale = 1.0;
    Point layout_size{};
    IntegerSize media_size{};
    Point ui_raster_scale{};
};

[[nodiscard]] AspectRatio reference_aspect(IntegerSize reference)
{
    const int divisor = std::gcd(reference.width, reference.height);
    return {reference.width / divisor, reference.height / divisor};
}

[[nodiscard]] Orientation reference_orientation(IntegerSize reference)
{
    return reference.width >= reference.height ? Orientation::Landscape : Orientation::Portrait;
}

[[nodiscard]] IntegerSize world_raster_size(IntegerSize viewport, IntegerSize reference,
                                            WorldRasterPolicy policy)
{
    if (policy == WorldRasterPolicy::Native)
        return viewport;
    if (viewport.width <= reference.width && viewport.height <= reference.height)
        return viewport;
    return reference;
}

[[nodiscard]] ContextMetrics context_metrics(IntegerSize reference, IntegerSize ui_raster,
                                             double runtime_ui_scale, bool inherits_ui_scale)
{
    const double effective_ui_scale = inherits_ui_scale ? runtime_ui_scale : 1.0;
    const Point layout_size{static_cast<double>(reference.width) / effective_ui_scale,
                            static_cast<double>(reference.height) / effective_ui_scale};
    return {.effective_ui_scale = effective_ui_scale,
            .layout_size = layout_size,
            .media_size = ui_raster,
            .ui_raster_scale = {static_cast<double>(ui_raster.width) / layout_size.x,
                                static_cast<double>(ui_raster.height) / layout_size.y}};
}

[[nodiscard]] Point reference_to_context(Point reference, double effective_ui_scale)
{
    return {reference.x / effective_ui_scale, reference.y / effective_ui_scale};
}

[[nodiscard]] Point context_to_reference(Point context, double effective_ui_scale)
{
    return {context.x * effective_ui_scale, context.y * effective_ui_scale};
}

[[nodiscard]] IntegerRect fit_centered_viewport(IntegerSize host, AspectRatio aspect)
{
    int width = host.width;
    int height =
        static_cast<int>((static_cast<std::int64_t>(host.width) * aspect.height) / aspect.width);
    if (height > host.height) {
        height = host.height;
        width = static_cast<int>((static_cast<std::int64_t>(host.height) * aspect.width) /
                                 aspect.height);
    }
    return {(host.width - width) / 2, (host.height - height) / 2, width, height};
}

[[nodiscard]] bool contains(const IntegerRect& rect, Point point)
{
    return point.x >= static_cast<double>(rect.x) && point.y >= static_cast<double>(rect.y) &&
           point.x < static_cast<double>(rect.x + rect.width) &&
           point.y < static_cast<double>(rect.y + rect.height);
}

[[nodiscard]] std::optional<Point> host_to_reference(Point host, const IntegerRect& viewport,
                                                     IntegerSize reference)
{
    if (!contains(viewport, host))
        return std::nullopt;
    return Point{(host.x - viewport.x) * reference.width / viewport.width,
                 (host.y - viewport.y) * reference.height / viewport.height};
}

[[nodiscard]] Point reference_to_host(Point reference_point, const IntegerRect& viewport,
                                      IntegerSize reference)
{
    return {viewport.x + reference_point.x * viewport.width / reference.width,
            viewport.y + reference_point.y * viewport.height / reference.height};
}

} // namespace

TEST_CASE("Reference contract derives normalized aspect and orientation from one size")
{
    CHECK((reference_aspect({1920, 1080}) == AspectRatio{16, 9}));
    CHECK((reference_aspect({1440, 1920}) == AspectRatio{3, 4}));
    CHECK(reference_orientation({1920, 1080}) == Orientation::Landscape);
    CHECK(reference_orientation({1080, 1920}) == Orientation::Portrait);
    CHECK(reference_orientation({1024, 1024}) == Orientation::Landscape);
}

TEST_CASE("World raster contract keeps native output and caps only above reference")
{
    constexpr IntegerSize reference{1920, 1080};

    CHECK((world_raster_size({1280, 720}, reference, WorldRasterPolicy::Capped) ==
           IntegerSize{1280, 720}));
    CHECK((world_raster_size({1920, 1080}, reference, WorldRasterPolicy::Capped) == reference));
    CHECK((world_raster_size({3840, 2160}, reference, WorldRasterPolicy::Capped) == reference));
    CHECK((world_raster_size({1921, 1080}, reference, WorldRasterPolicy::Capped) == reference));
    CHECK((world_raster_size({3840, 2160}, reference, WorldRasterPolicy::Native) ==
           IntegerSize{3840, 2160}));
}

TEST_CASE("Context contract separates effective layout from native media dimensions")
{
    constexpr IntegerSize reference{1920, 1080};
    constexpr IntegerSize ui_raster{3840, 2160};

    const auto unscaled = context_metrics(reference, ui_raster, 1.0, true);
    CHECK(unscaled.layout_size.x == Catch::Approx(1920.0));
    CHECK(unscaled.layout_size.y == Catch::Approx(1080.0));
    CHECK(unscaled.media_size == ui_raster);
    CHECK(unscaled.ui_raster_scale.x == Catch::Approx(2.0));
    CHECK(unscaled.ui_raster_scale.y == Catch::Approx(2.0));

    const auto inherited = context_metrics(reference, ui_raster, 1.25, true);
    CHECK(inherited.layout_size.x == Catch::Approx(1536.0));
    CHECK(inherited.layout_size.y == Catch::Approx(864.0));
    CHECK(inherited.media_size == ui_raster);
    CHECK(inherited.ui_raster_scale.x == Catch::Approx(2.5));
    CHECK(inherited.ui_raster_scale.y == Catch::Approx(2.5));

    const auto ignored = context_metrics(reference, ui_raster, 1.25, false);
    CHECK(ignored.layout_size.x == Catch::Approx(1920.0));
    CHECK(ignored.layout_size.y == Catch::Approx(1080.0));
    CHECK(ignored.ui_raster_scale.x == Catch::Approx(2.0));
    CHECK(ignored.ui_raster_scale.y == Catch::Approx(2.0));
}

TEST_CASE("Reference and context projections round trip without raster snapping")
{
    constexpr Point reference_point{960.25, 540.75};
    const Point context_point = reference_to_context(reference_point, 1.25);
    CHECK(context_point.x == Catch::Approx(768.2));
    CHECK(context_point.y == Catch::Approx(432.6));

    const Point round_trip = context_to_reference(context_point, 1.25);
    CHECK(round_trip.x == Catch::Approx(reference_point.x));
    CHECK(round_trip.y == Catch::Approx(reference_point.y));
}

TEST_CASE("Host and reference projections round trip inside the fitted viewport")
{
    constexpr IntegerSize reference{1920, 1080};
    const IntegerRect viewport = fit_centered_viewport({1000, 800}, reference_aspect(reference));
    CHECK((viewport == IntegerRect{0, 119, 1000, 562}));

    constexpr Point host_point{437.25, 400.5};
    const auto projected = host_to_reference(host_point, viewport, reference);
    REQUIRE(projected);
    const Point round_trip = reference_to_host(*projected, viewport, reference);
    CHECK(round_trip.x == Catch::Approx(host_point.x));
    CHECK(round_trip.y == Catch::Approx(host_point.y));
}

TEST_CASE("Host-to-reference projection rejects presentation bars and trailing edges")
{
    constexpr IntegerSize reference{1920, 1080};
    const IntegerRect viewport = fit_centered_viewport({1000, 800}, reference_aspect(reference));

    CHECK_FALSE(host_to_reference({500.0, 118.999}, viewport, reference));
    CHECK_FALSE(host_to_reference({500.0, 681.0}, viewport, reference));
    CHECK_FALSE(host_to_reference({-0.001, 400.0}, viewport, reference));
    CHECK_FALSE(host_to_reference({1000.0, 400.0}, viewport, reference));

    REQUIRE(host_to_reference({0.0, 119.0}, viewport, reference));
    REQUIRE(host_to_reference({999.999, 680.999}, viewport, reference));
}
