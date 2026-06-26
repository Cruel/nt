#include "rmlui_ppm_test_utils.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>

using namespace noveltea::test::rmlui;

namespace {

[[nodiscard]] bool cyan_like(std::array<int, 3> color)
{
    return color[0] < 90 && color[1] > 150 && color[2] > 150;
}

[[nodiscard]] bool magenta_like(std::array<int, 3> color)
{
    return color[0] > 150 && color[1] < 90 && color[2] > 150;
}

[[nodiscard]] bool yellow_like(std::array<int, 3> color)
{
    return color[0] > 150 && color[1] > 150 && color[2] < 90;
}

} // namespace

TEST_CASE("RmlUi focused feature fixtures verify backdrop shadow perspective and layer restore")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_RMLUI_FEATURE_FIXTURES_PPM));
    const auto sample_bg = std::array<int, 3>{32, 42, 53};

    SECTION("backdrop-filter inverts backdrop contents inside the focused work area")
    {
        CHECK(red_dominant(image.pixel(50, 56)));
        CHECK(green_dominant(image.pixel(100, 48)));

        CHECK(cyan_like(image.pixel(62, 56)));
        CHECK(magenta_like(image.pixel(84, 56)));
    }

    SECTION("box-shadow fixture renders base elements while shadow output remains tracked by docs")
    {
        CHECK(nearly_neutral(image.pixel(332, 62), 18));
        CHECK(yellow_like(image.pixel(422, 72)));
    }

    SECTION("perspective transform renders projected 3D geometry in a bounded area")
    {
        CHECK(has_pixel_matching(image, 68, 194, 150, 242, [](auto color) {
            return green_dominant(color) && brightness(color) > 150;
        }));
        CHECK(has_pixel_matching(image, 138, 216, 158, 238, [](auto color) {
            return red_dominant(color) && brightness(color) > 120;
        }));
        CHECK(close_to(image.pixel(214, 184), sample_bg, 18));
    }

    SECTION("nested PopLayer restores parent clip and transform for later sibling draws")
    {
        CHECK(has_pixel_matching(image, 356, 200, 420, 246, [](auto color) {
            return blue_dominant(color) && brightness(color) > 160;
        }));
        CHECK(has_pixel_matching(image, 300, 200, 350, 244, [](auto color) {
            return red_dominant(color) && brightness(color) > 120;
        }));
        CHECK(close_to(image.pixel(444, 188), sample_bg, 22));
        CHECK(!has_pixel_matching(image, 464, 184, 472, 224, [](auto color) {
            return blue_dominant(color) && brightness(color) > 180;
        }));
    }
}
