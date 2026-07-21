#include "rmlui_ppm_test_utils.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>

using namespace noveltea::test::rmlui;

TEST_CASE("Barred host capture contains only the fitted game viewport")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_PRESENTATION_READBACK_PPM));
    REQUIRE(image.width == 1000);
    REQUIRE(image.height == 562);

    CHECK(close_to(image.pixel(0, 0), std::array<int, 3>{16, 24, 32}));
    CHECK(close_to(image.pixel(999, 0), std::array<int, 3>{32, 36, 44}));
    CHECK(close_to(image.pixel(0, 561), std::array<int, 3>{32, 36, 44}));
    CHECK(close_to(image.pixel(999, 561), std::array<int, 3>{32, 36, 44}));
}

TEST_CASE("Capture frame excludes host debug rendering")
{
    const Image with_debug_enabled =
        read_ppm(std::filesystem::path(NOVELTEA_PRESENTATION_READBACK_PPM));
    const Image without_debug =
        read_ppm(std::filesystem::path(NOVELTEA_PRESENTATION_NO_DEBUG_READBACK_PPM));

    REQUIRE(with_debug_enabled.width == without_debug.width);
    REQUIRE(with_debug_enabled.height == without_debug.height);
    CHECK(with_debug_enabled.rgb == without_debug.rgb);
}

TEST_CASE("Unbarred host uses the same fitted capture path")
{
    const Image image =
        read_ppm(std::filesystem::path(NOVELTEA_PRESENTATION_UNBARRED_READBACK_PPM));
    REQUIRE(image.width == 960);
    REQUIRE(image.height == 540);

    CHECK(close_to(image.pixel(0, 0), std::array<int, 3>{16, 24, 32}));
    CHECK(close_to(image.pixel(959, 0), std::array<int, 3>{32, 36, 44}));
    CHECK(close_to(image.pixel(0, 539), std::array<int, 3>{32, 36, 44}));
    CHECK(close_to(image.pixel(959, 539), std::array<int, 3>{32, 36, 44}));
}
