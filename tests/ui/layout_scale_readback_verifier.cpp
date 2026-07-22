#include "rmlui_ppm_test_utils.hpp"

#include <catch2/catch_test_macros.hpp>

#include <filesystem>

using namespace noveltea::test::rmlui;

TEST_CASE("Interleaved Layout scale domains reconfigure one plane adapter without leakage")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_LAYOUT_SCALE_READBACK_PPM));
    REQUIRE(image.width == 1920);
    REQUIRE(image.height == 1080);

    CHECK(close_to(image.pixel(1600, 150), {255, 0, 0}, 8));
    CHECK(close_to(image.pixel(1730, 150), {0, 255, 0}, 8));
    CHECK(close_to(image.pixel(1850, 150), {0, 0, 255}, 8));

    CHECK(close_to(image.pixel(1665, 150), image.pixel(10, 10), 8));
}
