#include "rmlui_ppm_test_utils.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>

using namespace noveltea::test::rmlui;

TEST_CASE("nearest and linear image sampling produce distinct pixel readback")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_TEXTURE_SAMPLING_PPM));
    REQUIRE(image.width == 1920);
    REQUIRE(image.height == 1080);

    const std::array<int, 3> red{255, 0, 0};
    const std::array<int, 3> blue{0, 0, 255};
    const std::array<int, 3> purple{128, 0, 128};

    CHECK(close_to(image.pixel(497, 350), red, 8));
    CHECK(close_to(image.pixel(503, 350), blue, 8));
    CHECK(close_to(image.pixel(1420, 350), purple, 12));

    const auto linear_left = image.pixel(1410, 350);
    const auto linear_right = image.pixel(1430, 350);
    CHECK(linear_left[0] > linear_right[0]);
    CHECK(linear_left[2] < linear_right[2]);
}
