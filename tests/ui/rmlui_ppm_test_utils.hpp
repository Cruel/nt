#pragma once

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace noveltea::test::rmlui {

struct Image {
    int width = 0;
    int height = 0;
    std::vector<uint8_t> rgb;

    [[nodiscard]] std::array<int, 3> pixel(int x, int y) const
    {
        REQUIRE(x >= 0);
        REQUIRE(y >= 0);
        REQUIRE(x < width);
        REQUIRE(y < height);
        const size_t offset = (size_t(y) * size_t(width) + size_t(x)) * 3u;
        return {rgb[offset], rgb[offset + 1], rgb[offset + 2]};
    }
};

inline Image read_ppm(const std::filesystem::path& path)
{
    std::ifstream file(path, std::ios::binary);
    REQUIRE(file.good());

    std::string magic;
    int max_value = 0;
    Image image;
    file >> magic >> image.width >> image.height >> max_value;
    REQUIRE(magic == "P6");
    REQUIRE(image.width == 1280);
    REQUIRE(image.height == 720);
    REQUIRE(max_value == 255);
    file.get();

    image.rgb.resize(size_t(image.width) * size_t(image.height) * 3u);
    file.read(reinterpret_cast<char*>(image.rgb.data()),
              static_cast<std::streamsize>(image.rgb.size()));
    REQUIRE(file.gcount() == static_cast<std::streamsize>(image.rgb.size()));
    return image;
}

[[nodiscard]] inline bool close_to(std::array<int, 3> color, std::array<int, 3> expected,
                                   int tolerance = 8)
{
    for (size_t i = 0; i < color.size(); ++i) {
        if (std::abs(color[i] - expected[i]) > tolerance)
            return false;
    }
    return true;
}

[[nodiscard]] inline int brightness(std::array<int, 3> color)
{
    return color[0] + color[1] + color[2];
}

[[nodiscard]] inline bool red_dominant(std::array<int, 3> color)
{
    return color[0] > color[1] && color[0] > color[2];
}

[[nodiscard]] inline bool green_dominant(std::array<int, 3> color)
{
    return color[1] > color[0] && color[1] > color[2];
}

[[nodiscard]] inline bool blue_dominant(std::array<int, 3> color)
{
    return color[2] > color[0] && color[2] > color[1];
}

[[nodiscard]] inline bool nearly_neutral(std::array<int, 3> color, int tolerance = 12)
{
    return std::abs(color[0] - color[1]) <= tolerance &&
           std::abs(color[1] - color[2]) <= tolerance && brightness(color) > 360;
}

template<typename Predicate>
[[nodiscard]] bool has_pixel_matching(const Image& image, int left, int top, int right, int bottom,
                                      Predicate predicate)
{
    for (int y = top; y < bottom; ++y) {
        for (int x = left; x < right; ++x) {
            if (predicate(image.pixel(x, y)))
                return true;
        }
    }
    return false;
}

} // namespace noveltea::test::rmlui
