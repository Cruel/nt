#pragma once

#include "noveltea/surface.hpp"

#include <cstdint>
#include <optional>
#include <vector>

namespace noveltea::bgfx_backend {

struct CroppedScreenshotPixels {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t pitch = 0;
    std::vector<std::uint8_t> bgra8;
};

[[nodiscard]] std::optional<CroppedScreenshotPixels>
crop_screenshot_bgra8(const void* data, std::uint32_t width, std::uint32_t height,
                      std::uint32_t pitch, std::uint32_t size, bool yflip,
                      IntegerSize captured_host_size, IntegerRect crop);

} // namespace noveltea::bgfx_backend
