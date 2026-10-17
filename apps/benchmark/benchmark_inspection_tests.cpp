#include "benchmark_inspection.hpp"

#include <png.h>

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using namespace noveltea::benchmark;

int main()
{
    // bgfx returns padded BGRA rows and may mark them upside-down; neither
    // condition may change the saved image's visual orientation or colors.
    InspectionPixels pixels;
    pixels.width = 2;
    pixels.height = 2;
    pixels.pitch = 12;
    pixels.format = bgfx::TextureFormat::BGRA8;
    pixels.yflip = true;
    pixels.bytes = {
        255, 0, 0,   255, 0,   255, 0,   255, 0, 0, 0, 0, // blue, green (bottom)
        0,   0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0  // red, white (top)
    };
    Options options;
    options.scenario = "standalone-rmlui-simple";
    options.width = 2;
    options.height = 2;
    std::vector<uint8_t> encoded;
    std::string error;
    assert(encode_inspection_png(pixels, options, encoded, error));
    assert(encoded.size() > 100);
    std::string byte_string(encoded.begin(), encoded.end());
    assert(byte_string.find("NovelTea benchmark") != std::string::npos);
    assert(byte_string.find("untimed-inspection") != std::string::npos);
    assert(byte_string.find("standalone-rmlui-simple") != std::string::npos);
    assert(byte_string.find("\"width_pixels\":2") != std::string::npos);
    assert(byte_string.find("noveltea.benchmark.configuration") != std::string::npos);

    png_image image{};
    image.version = PNG_IMAGE_VERSION;
    assert(png_image_begin_read_from_memory(&image, encoded.data(), encoded.size()));
    assert(image.width == 2 && image.height == 2);
    image.format = PNG_FORMAT_RGBA;
    std::vector<uint8_t> decoded(PNG_IMAGE_SIZE(image));
    assert(png_image_finish_read(&image, nullptr, decoded.data(), 0, nullptr));
    png_image_free(&image);
    const std::vector<uint8_t> expected{
        255, 0, 0,   255, 255, 255, 255, 255, // red white
        0,   0, 255, 255, 0,   255, 0,   255  // blue green
    };
    assert(decoded == expected);

    pixels.pitch = 4;
    assert(!encode_inspection_png(pixels, options, encoded, error));
    assert(error.find("unsupported") != std::string::npos);
    pixels.pitch = 12;
    pixels.format = bgfx::TextureFormat::D32;
    assert(!encode_inspection_png(pixels, options, encoded, error));
    assert(supports_inspection("standalone-rmlui-simple"));
    assert(!supports_inspection("integrated-rmlui-controlled"));
    assert(supports_engine_inspection("integrated-rmlui-controlled"));
    assert(!supports_engine_inspection("raw-bgfx-empty"));
    std::puts("inspection PNG metadata, colors, orientation and unsupported paths OK");
    return 0;
}
