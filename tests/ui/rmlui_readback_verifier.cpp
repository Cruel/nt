#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace {

struct Image {
    int width = 0;
    int height = 0;
    std::vector<uint8_t> rgb;

    std::array<int, 3> pixel(int x, int y) const
    {
        REQUIRE(x >= 0);
        REQUIRE(y >= 0);
        REQUIRE(x < width);
        REQUIRE(y < height);
        const size_t offset = (size_t(y) * size_t(width) + size_t(x)) * 3u;
        return {rgb[offset], rgb[offset + 1], rgb[offset + 2]};
    }
};

Image read_ppm(const std::filesystem::path& path)
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
    file.read(reinterpret_cast<char*>(image.rgb.data()), static_cast<std::streamsize>(image.rgb.size()));
    REQUIRE(file.gcount() == static_cast<std::streamsize>(image.rgb.size()));
    return image;
}

bool close_to(std::array<int, 3> color, std::array<int, 3> expected, int tolerance = 8)
{
    for (size_t i = 0; i < color.size(); ++i) {
        if (std::abs(color[i] - expected[i]) > tolerance) return false;
    }
    return true;
}

int brightness(std::array<int, 3> color)
{
    return color[0] + color[1] + color[2];
}

bool red_dominant(std::array<int, 3> color)
{
    return color[0] > color[1] && color[0] > color[2];
}

bool green_dominant(std::array<int, 3> color)
{
    return color[1] > color[0] && color[1] > color[2];
}

bool blue_dominant(std::array<int, 3> color)
{
    return color[2] > color[0] && color[2] > color[1];
}

template <typename Predicate>
bool has_pixel_matching(const Image& image, int left, int top, int right, int bottom, Predicate predicate)
{
    for (int y = top; y < bottom; ++y) {
        for (int x = left; x < right; ++x) {
            if (predicate(image.pixel(x, y))) return true;
        }
    }
    return false;
}

} // namespace

TEST_CASE("RmlUi readback gallery pixels verify advanced renderer output")
{
    const Image image = read_ppm(std::filesystem::path(NOVELTEA_RMLUI_READBACK_PPM));
    const auto bg = std::array<int, 3>{16, 24, 32};

    CHECK(has_pixel_matching(image, 16, 16, 48, 48, [](auto color) { return red_dominant(color) && brightness(color) > 60; }));
    CHECK(has_pixel_matching(image, 80, 16, 112, 48, [](auto color) { return green_dominant(color) && brightness(color) > 60; }));
    CHECK(has_pixel_matching(image, 16, 80, 48, 112, [](auto color) { return blue_dominant(color) && brightness(color) > 60; }));
    CHECK(has_pixel_matching(image, 80, 80, 112, 112, [](auto color) { return color[0] > color[2] && color[1] > color[2] && brightness(color) > 60; }));

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
}
