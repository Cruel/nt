#include "rmlui_ppm_test_utils.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>

using namespace noveltea::test::rmlui;

TEST_CASE("Presentation readback preserves bars and clips game content to the fitted viewport")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_PRESENTATION_READBACK_PPM));
    REQUIRE(image.width == 1000);
    REQUIRE(image.height == 800);

    const auto black = std::array<int, 3>{0, 0, 0};
    CHECK(close_to(image.pixel(500, 20), black));
    CHECK(close_to(image.pixel(500, 100), black));
    CHECK(close_to(image.pixel(500, 700), black));
    CHECK(close_to(image.pixel(500, 780), black));

    CHECK(brightness(image.pixel(20, 140)) > 10);
    CHECK(brightness(image.pixel(500, 400)) > 10);
    CHECK(has_pixel_matching(image, 0, 119, 1000, 681,
                             [](auto color) { return brightness(color) > 100; }));

    CHECK(close_to(image.pixel(500, 118), black));
    CHECK(brightness(image.pixel(500, 119)) > 10);
    CHECK(close_to(image.pixel(500, 681), black));

    for (int x = 0; x < image.width; x += 50) {
        CHECK(close_to(image.pixel(x, 60), black));
        CHECK(close_to(image.pixel(x, 740), black));
    }
}

TEST_CASE("Current screenshot capture dimensions are the complete host framebuffer")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_PRESENTATION_READBACK_PPM));
    CHECK(image.width == 1000);
    CHECK(image.height == 800);

    constexpr int fitted_viewport_height = 562;
    CHECK(image.height != fitted_viewport_height);
}
