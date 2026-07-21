#include "rmlui_ppm_test_utils.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>

using namespace noveltea::test::rmlui;

namespace {

[[nodiscard]] bool visibly_different(std::array<int, 3> lhs, std::array<int, 3> rhs,
                                     int threshold = 24)
{
    for (size_t channel = 0; channel < lhs.size(); ++channel) {
        if (std::abs(lhs[channel] - rhs[channel]) > threshold)
            return true;
    }
    return false;
}

} // namespace

TEST_CASE("postprocess scopes preserve world UI and host-plane boundaries")
{
    const Image baseline = read_ppm(std::filesystem::path(NOVELTEA_POSTPROCESS_BASELINE_PPM));
    const Image world = read_ppm(std::filesystem::path(NOVELTEA_POSTPROCESS_WORLD_PPM));
    const Image full_game = read_ppm(std::filesystem::path(NOVELTEA_POSTPROCESS_FULL_GAME_PPM));
    REQUIRE(baseline.width == 1000);
    REQUIRE(baseline.height == 562);
    REQUIRE(world.width == baseline.width);
    REQUIRE(world.height == baseline.height);
    REQUIRE(full_game.width == baseline.width);
    REQUIRE(full_game.height == baseline.height);

    const auto baseline_world = baseline.pixel(100, 61);
    const auto world_effect = world.pixel(100, 61);
    const auto full_game_world = full_game.pixel(100, 61);
    CHECK(visibly_different(baseline_world, world_effect));
    CHECK(close_to(world_effect, full_game_world, 2));

    const auto baseline_game_ui = baseline.pixel(500, 281);
    const auto world_game_ui = world.pixel(500, 281);
    const auto full_game_ui = full_game.pixel(500, 281);
    CHECK(close_to(baseline_game_ui, world_game_ui, 2));
    CHECK(visibly_different(baseline_game_ui, full_game_ui));
}
