#include "rmlui_ppm_test_utils.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>

using namespace noveltea::test::rmlui;

TEST_CASE("Compiled world presentation readback is reconstructed from the runtime snapshot")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_WORLD_PRESENTATION_READBACK_PPM));
    REQUIRE(image.width == 1280);
    REQUIRE(image.height == 720);

    const auto background = std::array<int, 3>{32, 64, 96};
    CHECK(close_to(image.pixel(8, 8), background, 8));
    CHECK(close_to(image.pixel(1271, 8), background, 8));
    CHECK(close_to(image.pixel(8, 711), background, 8));
    CHECK(close_to(image.pixel(1271, 711), background, 8));
}
