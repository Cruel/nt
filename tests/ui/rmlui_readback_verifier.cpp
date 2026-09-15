#include "rmlui_ppm_test_utils.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>

using namespace noveltea::test::rmlui;

TEST_CASE("RmlUi readback gallery pixels verify advanced renderer output")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_RMLUI_READBACK_PPM));
    const auto bg = std::array<int, 3>{16, 24, 32};

    CHECK(has_pixel_matching(image, 16, 16, 48, 48, [](auto color) {
        return red_dominant(color) && brightness(color) > 60;
    }));
    CHECK(has_pixel_matching(image, 80, 16, 112, 48, [](auto color) {
        return green_dominant(color) && brightness(color) > 60;
    }));
    CHECK(has_pixel_matching(image, 16, 80, 48, 112, [](auto color) {
        return blue_dominant(color) && brightness(color) > 60;
    }));
    CHECK(has_pixel_matching(image, 80, 80, 112, 112, [](auto color) {
        return color[0] > color[2] && color[1] > color[2] && brightness(color) > 60;
    }));

    CHECK(red_dominant(image.pixel(140, 56)));
    CHECK(green_dominant(image.pixel(190, 70)));
    CHECK(brightness(image.pixel(220, 20)) < 120);

    CHECK(red_dominant(image.pixel(257, 60)));
    CHECK(brightness(image.pixel(285, 60)) > 50);
    CHECK(green_dominant(image.pixel(313, 60)));
    CHECK(brightness(image.pixel(336, 70)) > 50);

    CHECK(image.pixel(371, 38)[0] > image.pixel(371, 38)[2]);
    CHECK(image.pixel(448, 38)[2] > image.pixel(448, 38)[0]);
    CHECK(image.pixel(396, 64)[1] > image.pixel(396, 64)[0]);
    CHECK(image.pixel(416, 90)[0] > image.pixel(416, 90)[2]);

    CHECK(brightness(image.pixel(524, 64)) > brightness(bg) + 120);
    CHECK(brightness(image.pixel(479, 20)) < 120);

    CHECK(red_dominant(image.pixel(644, 64)));
    CHECK(close_to(image.pixel(596, 16), bg));
    CHECK(close_to(image.pixel(688, 18), bg));

    CHECK(brightness(image.pixel(36, 186)) > 620);
    CHECK(image.pixel(66, 186)[0] < image.pixel(36, 186)[0]);
    CHECK(image.pixel(96, 186)[0] > image.pixel(96, 186)[1]);
    CHECK(nearly_neutral(image.pixel(126, 186)));
    CHECK(image.pixel(156, 186)[0] > image.pixel(156, 186)[1]);
    CHECK(image.pixel(156, 186)[1] > image.pixel(156, 186)[2]);
    CHECK(image.pixel(186, 186)[0] > 220);
    CHECK(image.pixel(186, 186)[2] > 200);
    CHECK(blue_dominant(image.pixel(216, 186)));

    CHECK(red_dominant(image.pixel(282, 162)));
    CHECK(blue_dominant(image.pixel(330, 162)));
    CHECK(brightness(image.pixel(390, 162)) > brightness(bg) + 240);
    CHECK(brightness(image.pixel(282, 188)) > 600);
    CHECK(green_dominant(image.pixel(346, 188)));
    CHECK(brightness(image.pixel(420, 188)) > 560);
    CHECK(red_dominant(image.pixel(282, 214)));
    CHECK(red_dominant(image.pixel(346, 214)));
    CHECK(image.pixel(420, 214)[1] > image.pixel(420, 214)[0]);
}
