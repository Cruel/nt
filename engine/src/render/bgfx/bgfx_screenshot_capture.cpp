#include "render/bgfx/bgfx_screenshot_capture.hpp"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>

namespace noveltea::bgfx_backend {

std::optional<CroppedScreenshotPixels>
crop_screenshot_bgra8(const void* data, std::uint32_t width, std::uint32_t height,
                      std::uint32_t pitch, std::uint32_t size, bool yflip,
                      IntegerSize captured_host_size, IntegerRect crop)
{
    if (!data || captured_host_size.width <= 0 || captured_host_size.height <= 0 || crop.x < 0 ||
        crop.y < 0 || crop.width <= 0 || crop.height <= 0)
        return std::nullopt;

    const auto captured_width = static_cast<std::uint64_t>(captured_host_size.width);
    const auto captured_height = static_cast<std::uint64_t>(captured_host_size.height);
    if (captured_width != width || captured_height != height)
        return std::nullopt;

    const auto source_row_bytes = static_cast<std::uint64_t>(width) * 4u;
    const auto source_size = static_cast<std::uint64_t>(pitch) * height;
    if (source_row_bytes > pitch || source_size > size)
        return std::nullopt;

    const auto crop_right = static_cast<std::uint64_t>(crop.x) + crop.width;
    const auto crop_bottom = static_cast<std::uint64_t>(crop.y) + crop.height;
    if (crop_right > captured_width || crop_bottom > captured_height)
        return std::nullopt;

    const auto cropped_pitch = static_cast<std::uint64_t>(crop.width) * 4u;
    const auto cropped_size = cropped_pitch * static_cast<std::uint64_t>(crop.height);
    if (cropped_pitch > std::numeric_limits<std::uint32_t>::max() ||
        cropped_size > std::numeric_limits<std::size_t>::max())
        return std::nullopt;

    CroppedScreenshotPixels result;
    result.width = static_cast<std::uint32_t>(crop.width);
    result.height = static_cast<std::uint32_t>(crop.height);
    result.pitch = static_cast<std::uint32_t>(cropped_pitch);
    result.bgra8.resize(static_cast<std::size_t>(cropped_size));

    const auto* source = static_cast<const std::uint8_t*>(data);
    for (std::uint32_t output_y = 0; output_y < result.height; ++output_y) {
        const auto host_y = static_cast<std::uint32_t>(crop.y) + output_y;
        const auto source_y = yflip ? height - 1u - host_y : host_y;
        const auto source_offset =
            static_cast<std::size_t>(source_y) * pitch + static_cast<std::size_t>(crop.x) * 4u;
        const auto output_offset = static_cast<std::size_t>(output_y) * result.pitch;
        std::memcpy(result.bgra8.data() + output_offset, source + source_offset, result.pitch);
    }

    return result;
}

} // namespace noveltea::bgfx_backend
