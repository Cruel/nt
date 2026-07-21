#include "rmlui_ppm_test_utils.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>

using namespace noveltea::test::rmlui;

namespace {

constexpr int kMarkerX = 1120;
constexpr int kSourceMarkerY = 144;
constexpr int kGameUiMarkerY = 328;
constexpr int kTargetMarkerY = 496;
constexpr int kBackgroundX = 1240;
constexpr int kBackgroundY = 360;

void require_fixture_size(const Image& image)
{
    REQUIRE(image.width == 1280);
    REQUIRE(image.height == 720);
}

void check_game_ui_excluded(const Image& image)
{
    CHECK(close_to(image.pixel(kMarkerX, kGameUiMarkerY), {0, 255, 255}, 8));
}

bool yellow_dominant(const std::array<int, 3>& color)
{
    return color[0] >= 80 && color[1] >= 80 && color[2] <= 20;
}

} // namespace

TEST_CASE("Cut publishes the target world and WorldOverlay synchronously")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_WORLD_TRANSITION_CUT_PPM));
    require_fixture_size(image);

    CHECK(close_to(image.pixel(kBackgroundX, kBackgroundY), {0, 0, 255}, 8));
    CHECK(close_to(image.pixel(kMarkerX, kTargetMarkerY), {255, 255, 0}, 8));
    check_game_ui_excluded(image);
}

TEST_CASE("Fade uses source-color-target phases without affecting GameUi")
{
    const Image source = read_ppm(std::filesystem::path(NOVELTEA_WORLD_TRANSITION_FADE_SOURCE_PPM));
    const Image midpoint =
        read_ppm(std::filesystem::path(NOVELTEA_WORLD_TRANSITION_FADE_MIDPOINT_PPM));
    const Image target = read_ppm(std::filesystem::path(NOVELTEA_WORLD_TRANSITION_FADE_TARGET_PPM));
    require_fixture_size(source);
    require_fixture_size(midpoint);
    require_fixture_size(target);

    const auto source_background = source.pixel(kBackgroundX, kBackgroundY);
    CHECK(source_background[0] >= 140);
    CHECK(source_background[1] <= 12);
    CHECK(source_background[2] <= 12);
    CHECK(green_dominant(source.pixel(kMarkerX, kSourceMarkerY)));
    CHECK(red_dominant(source.pixel(kMarkerX, kTargetMarkerY)));

    CHECK(close_to(midpoint.pixel(kBackgroundX, kBackgroundY), {0, 0, 0}, 8));
    CHECK(close_to(midpoint.pixel(kMarkerX, kTargetMarkerY), {0, 0, 0}, 8));

    const auto target_background = target.pixel(kBackgroundX, kBackgroundY);
    CHECK(target_background[0] <= 12);
    CHECK(target_background[1] <= 12);
    CHECK(target_background[2] >= 90);
    const auto target_marker = target.pixel(kMarkerX, kTargetMarkerY);
    CHECK(target_marker[0] >= 90);
    CHECK(target_marker[1] >= 90);
    CHECK(target_marker[2] <= 12);
    CHECK(blue_dominant(target.pixel(kMarkerX, kSourceMarkerY)));

    check_game_ui_excluded(source);
    check_game_ui_excluded(midpoint);
    check_game_ui_excluded(target);
}

TEST_CASE("Current transition routing keeps source and target WorldOverlay on matching surfaces")
{
    const Image source = read_ppm(std::filesystem::path(NOVELTEA_WORLD_TRANSITION_FADE_SOURCE_PPM));
    const Image target = read_ppm(std::filesystem::path(NOVELTEA_WORLD_TRANSITION_FADE_TARGET_PPM));
    require_fixture_size(source);
    require_fixture_size(target);

    CHECK(green_dominant(source.pixel(kMarkerX, kSourceMarkerY)));
    CHECK(red_dominant(source.pixel(kMarkerX, kTargetMarkerY)));
    CHECK(blue_dominant(target.pixel(kMarkerX, kSourceMarkerY)));
    CHECK(yellow_dominant(target.pixel(kMarkerX, kTargetMarkerY)));
}

TEST_CASE("Dissolve directly cross-composites source and target surfaces")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_WORLD_TRANSITION_DISSOLVE_PPM));
    require_fixture_size(image);

    const auto background = image.pixel(kBackgroundX, kBackgroundY);
    CHECK(background[0] >= 110);
    CHECK(background[0] <= 145);
    CHECK(background[1] <= 12);
    CHECK(background[2] >= 110);
    CHECK(background[2] <= 145);

    const auto target_marker = image.pixel(kMarkerX, kTargetMarkerY);
    CHECK(target_marker[0] >= 240);
    CHECK(target_marker[1] >= 110);
    CHECK(target_marker[1] <= 145);
    CHECK(target_marker[2] <= 12);

    check_game_ui_excluded(image);
}
