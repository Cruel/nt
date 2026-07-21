#include "render/bgfx/bgfx_screenshot_capture.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace {

using noveltea::IntegerRect;
using noveltea::IntegerSize;
using noveltea::bgfx_backend::crop_screenshot_bgra8;
using noveltea::bgfx_backend::CroppedScreenshotPixels;

std::array<std::uint8_t, 4> pixel_at(const CroppedScreenshotPixels& image, std::uint32_t x,
                                     std::uint32_t y)
{
    const std::size_t offset = static_cast<std::size_t>(y) * image.pitch + x * 4u;
    return {image.bgra8[offset], image.bgra8[offset + 1u], image.bgra8[offset + 2u],
            image.bgra8[offset + 3u]};
}

std::array<std::uint8_t, 4> host_pixel(std::uint32_t x, std::uint32_t y)
{
    return {static_cast<std::uint8_t>(x + 10u), static_cast<std::uint8_t>(y + 20u),
            static_cast<std::uint8_t>(x * 16u + y), 255u};
}

std::vector<std::uint8_t> make_host_image(std::uint32_t width, std::uint32_t height, bool yflip)
{
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(width) * height * 4u);
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint32_t stored_y = yflip ? height - 1u - y : y;
        for (std::uint32_t x = 0; x < width; ++x) {
            const auto pixel = host_pixel(x, y);
            const std::size_t offset = (static_cast<std::size_t>(stored_y) * width + x) * 4u;
            for (std::size_t channel = 0; channel < pixel.size(); ++channel)
                bytes[offset + channel] = pixel[channel];
        }
    }
    return bytes;
}

} // namespace

TEST_CASE("Barred screenshot crops exact fitted dimensions and corner pixels")
{
    constexpr std::uint32_t host_width = 8;
    constexpr std::uint32_t host_height = 7;
    constexpr IntegerRect crop{2, 1, 4, 5};
    const auto host = make_host_image(host_width, host_height, true);

    const auto cropped = crop_screenshot_bgra8(
        host.data(), host_width, host_height, host_width * 4u,
        static_cast<std::uint32_t>(host.size()), true,
        IntegerSize{static_cast<int>(host_width), static_cast<int>(host_height)}, crop);

    REQUIRE(cropped);
    CHECK(cropped->width == 4u);
    CHECK(cropped->height == 5u);
    CHECK(cropped->pitch == 16u);
    CHECK(pixel_at(*cropped, 0, 0) == host_pixel(2, 1));
    CHECK(pixel_at(*cropped, 3, 0) == host_pixel(5, 1));
    CHECK(pixel_at(*cropped, 0, 4) == host_pixel(2, 5));
    CHECK(pixel_at(*cropped, 3, 4) == host_pixel(5, 5));
}

TEST_CASE("Unbarred screenshot preserves full fitted dimensions and corner pixels")
{
    constexpr std::uint32_t host_width = 5;
    constexpr std::uint32_t host_height = 3;
    constexpr IntegerRect crop{0, 0, 5, 3};
    const auto host = make_host_image(host_width, host_height, false);

    const auto cropped = crop_screenshot_bgra8(
        host.data(), host_width, host_height, host_width * 4u,
        static_cast<std::uint32_t>(host.size()), false,
        IntegerSize{static_cast<int>(host_width), static_cast<int>(host_height)}, crop);

    REQUIRE(cropped);
    CHECK(cropped->width == host_width);
    CHECK(cropped->height == host_height);
    CHECK(pixel_at(*cropped, 0, 0) == host_pixel(0, 0));
    CHECK(pixel_at(*cropped, 4, 0) == host_pixel(4, 0));
    CHECK(pixel_at(*cropped, 0, 2) == host_pixel(0, 2));
    CHECK(pixel_at(*cropped, 4, 2) == host_pixel(4, 2));
}

TEST_CASE("Screenshot crop rejects callback dimensions from a different host resize")
{
    constexpr std::uint32_t callback_width = 8;
    constexpr std::uint32_t callback_height = 6;
    const auto host = make_host_image(callback_width, callback_height, false);

    CHECK_FALSE(crop_screenshot_bgra8(host.data(), callback_width, callback_height,
                                      callback_width * 4u, static_cast<std::uint32_t>(host.size()),
                                      false, IntegerSize{10, 8}, IntegerRect{1, 1, 8, 6}));
}
