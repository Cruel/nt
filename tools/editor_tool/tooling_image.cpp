#include "tooling_native_c.h"

#include <bimg/decode.h>
#include <bimg/encode.h>
#include <bx/allocator.h>
#include <bx/file.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace {

struct DecodedImage {
    bx::DefaultAllocator allocator;
    bimg::ImageContainer* container{nullptr};
    bimg::ImageMip mip{};

    ~DecodedImage()
    {
        if (container != nullptr)
            bimg::imageFree(container);
    }

    DecodedImage() = default;
    DecodedImage(const DecodedImage&) = delete;
    DecodedImage& operator=(const DecodedImage&) = delete;
};

std::optional<std::vector<std::uint8_t>> read_bytes(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input)
        return std::nullopt;
    const auto length = input.tellg();
    if (length <= 0 || static_cast<std::uint64_t>(length) > std::numeric_limits<std::uint32_t>::max())
        return std::nullopt;
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(length));
    input.seekg(0);
    input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!input)
        return std::nullopt;
    return bytes;
}

bool decode_image(const std::filesystem::path& path, DecodedImage& decoded, std::string& error)
{
    auto bytes = read_bytes(path);
    if (!bytes) {
        error = "Cannot read image source '" + path.string() + "'.";
        return false;
    }
    decoded.container = bimg::imageParse(&decoded.allocator, bytes->data(),
                                         static_cast<std::uint32_t>(bytes->size()),
                                         bimg::TextureFormat::RGBA8);
    if (decoded.container == nullptr || decoded.container->m_numLayers != 1 ||
        decoded.container->m_depth != 1 || decoded.container->m_width == 0 ||
        decoded.container->m_height == 0 ||
        !bimg::imageGetRawData(*decoded.container, 0, 0, decoded.container->m_data,
                               decoded.container->m_size, decoded.mip) ||
        decoded.mip.m_format != bimg::TextureFormat::RGBA8) {
        error = "bimg cannot decode image source '" + path.string() + "' as RGBA8.";
        return false;
    }
    return true;
}

nlohmann::json inspect_image(const nlohmann::json& request)
{
    const auto source = request.value("sourcePath", std::string{});
    if (source.empty())
        return {{"ok", false}, {"error", "Image inspection requires sourcePath."}};
    DecodedImage decoded;
    std::string error;
    if (!decode_image(source, decoded, error))
        return {{"ok", false}, {"error", std::move(error)}};

    const auto width = static_cast<std::uint32_t>(decoded.mip.m_width);
    const auto height = static_cast<std::uint32_t>(decoded.mip.m_height);
    const auto* pixels = static_cast<const std::uint8_t*>(decoded.mip.m_data);
    std::uint32_t left = width;
    std::uint32_t top = height;
    std::uint32_t right = 0;
    std::uint32_t bottom = 0;
    bool visible = false;
    for (std::uint32_t y = 0; y < height; ++y) {
        for (std::uint32_t x = 0; x < width; ++x) {
            if (pixels[(static_cast<std::size_t>(y) * width + x) * 4u + 3u] <= 8u)
                continue;
            visible = true;
            left = std::min(left, x);
            top = std::min(top, y);
            right = std::max(right, x);
            bottom = std::max(bottom, y);
        }
    }
    nlohmann::json response = {{"ok", true},
                               {"width", width},
                               {"height", height},
                               {"hasAlpha", decoded.container->m_hasAlpha},
                               {"space", "srgb"}};
    if (visible)
        response["alphaBounds"] =
            {{"left", left}, {"top", top}, {"right", right}, {"bottom", bottom}};
    return response;
}

std::uint8_t sample(const std::uint8_t* pixels, std::uint32_t width, std::uint32_t height, float x,
                    float y, std::uint32_t channel)
{
    const float clamped_x = std::clamp(x, 0.0f, static_cast<float>(width - 1));
    const float clamped_y = std::clamp(y, 0.0f, static_cast<float>(height - 1));
    const auto x0 = static_cast<std::uint32_t>(std::floor(clamped_x));
    const auto y0 = static_cast<std::uint32_t>(std::floor(clamped_y));
    const auto x1 = std::min(x0 + 1, width - 1);
    const auto y1 = std::min(y0 + 1, height - 1);
    const float tx = clamped_x - static_cast<float>(x0);
    const float ty = clamped_y - static_cast<float>(y0);
    const auto at = [&](std::uint32_t px, std::uint32_t py) {
        return static_cast<float>(pixels[(static_cast<std::size_t>(py) * width + px) * 4u + channel]);
    };
    const float top_value = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
    const float bottom_value = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
    return static_cast<std::uint8_t>(std::clamp(std::lround(top_value + (bottom_value - top_value) * ty), 0l, 255l));
}

nlohmann::json resize_image(const nlohmann::json& request)
{
    const auto source = request.value("sourcePath", std::string{});
    const auto output = request.value("outputPath", std::string{});
    const auto size = request.value("size", 0u);
    if (source.empty() || output.empty() || size == 0 || size > 4096)
        return {{"ok", false}, {"error", "Image resize requires sourcePath, outputPath, and a size up to 4096."}};
    DecodedImage decoded;
    std::string error;
    if (!decode_image(source, decoded, error))
        return {{"ok", false}, {"error", std::move(error)}};

    const auto source_width = static_cast<std::uint32_t>(decoded.mip.m_width);
    const auto source_height = static_cast<std::uint32_t>(decoded.mip.m_height);
    const float scale = std::min(static_cast<float>(size) / static_cast<float>(source_width),
                                 static_cast<float>(size) / static_cast<float>(source_height));
    const auto width = std::max(1u, static_cast<std::uint32_t>(std::lround(source_width * scale)));
    const auto height = std::max(1u, static_cast<std::uint32_t>(std::lround(source_height * scale)));
    const auto offset_x = (size - width) / 2u;
    const auto offset_y = (size - height) / 2u;
    std::vector<std::uint8_t> pixels(static_cast<std::size_t>(size) * size * 4u, 0u);
    const auto* source_pixels = static_cast<const std::uint8_t*>(decoded.mip.m_data);
    for (std::uint32_t y = 0; y < height; ++y) {
        for (std::uint32_t x = 0; x < width; ++x) {
            const float source_x = (static_cast<float>(x) + 0.5f) / scale - 0.5f;
            const float source_y = (static_cast<float>(y) + 0.5f) / scale - 0.5f;
            const auto destination =
                (static_cast<std::size_t>(y + offset_y) * size + x + offset_x) * 4u;
            for (std::uint32_t channel = 0; channel < 4; ++channel)
                pixels[destination + channel] = sample(source_pixels, source_width, source_height,
                                                       source_x, source_y, channel);
        }
    }

    const std::filesystem::path output_path(output);
    std::error_code filesystem_error;
    if (output_path.has_parent_path())
        std::filesystem::create_directories(output_path.parent_path(), filesystem_error);
    if (filesystem_error)
        return {{"ok", false}, {"error", "Cannot create image output directory: " + filesystem_error.message()}};
    bx::FileWriter writer;
    bx::Error write_error;
    if (!writer.open(bx::FilePath(output.c_str()), false, &write_error))
        return {{"ok", false}, {"error", "Cannot open PNG output '" + output + "'."}};
    const auto written = bimg::imageWritePng(&writer, size, size, size * 4u, pixels.data(),
                                              bimg::TextureFormat::RGBA8, false, &write_error);
    writer.close();
    if (!write_error.isOk() || written <= 0)
        return {{"ok", false}, {"error", "bimg failed to encode PNG output '" + output + "'."}};
    return {{"ok", true}};
}

std::uint64_t invoke_image(std::string_view command, const std::uint8_t* request,
                           std::uint64_t request_size, std::uint8_t* response,
                           std::uint64_t response_capacity)
{
    const auto input = request == nullptr
                           ? std::string_view{}
                           : std::string_view(reinterpret_cast<const char*>(request),
                                              static_cast<std::size_t>(request_size));
    const auto parsed = nlohmann::json::parse(input, nullptr, false);
    nlohmann::json result;
    if (parsed.is_discarded() || !parsed.is_object())
        result = {{"ok", false}, {"error", "Malformed image request JSON."}};
    else if (command == "inspect")
        result = inspect_image(parsed);
    else
        result = resize_image(parsed);
    const auto text = result.dump();
    const auto required = static_cast<std::uint64_t>(text.size());
    if (response != nullptr && response_capacity >= required)
        std::memcpy(response, text.data(), static_cast<std::size_t>(required));
    return required;
}

} // namespace

extern "C" std::uint64_t
noveltea_tooling_image_inspect_json(const std::uint8_t* request, std::uint64_t request_size,
                                    std::uint8_t* response, std::uint64_t response_capacity)
{
    return invoke_image("inspect", request, request_size, response, response_capacity);
}

extern "C" std::uint64_t
noveltea_tooling_image_resize_png_json(const std::uint8_t* request, std::uint64_t request_size,
                                       std::uint8_t* response, std::uint64_t response_capacity)
{
    return invoke_image("resize", request, request_size, response, response_capacity);
}

extern "C" std::uint64_t
noveltea_tooling_file_mode_json(const std::uint8_t* request, std::uint64_t request_size,
                                std::uint8_t* response, std::uint64_t response_capacity)
{
    const auto input = request == nullptr
                           ? std::string_view{}
                           : std::string_view(reinterpret_cast<const char*>(request),
                                              static_cast<std::size_t>(request_size));
    const auto parsed = nlohmann::json::parse(input, nullptr, false);
    nlohmann::json result;
    if (parsed.is_discarded() || !parsed.is_object() || !parsed.contains("path") ||
        !parsed["path"].is_string()) {
        result = {{"ok", false}, {"error", "File mode request requires path."}};
    } else {
        std::error_code error;
        const auto permissions =
            std::filesystem::status(parsed["path"].get<std::string>(), error).permissions();
        if (error)
            result = {{"ok", false}, {"error", "Cannot inspect file mode: " + error.message()}};
        else
            result = static_cast<unsigned>(permissions) & 0777u;
    }
    const auto text = result.dump();
    const auto required = static_cast<std::uint64_t>(text.size());
    if (response != nullptr && response_capacity >= required)
        std::memcpy(response, text.data(), static_cast<std::size_t>(required));
    return required;
}

extern "C" std::uint64_t
noveltea_tooling_disk_space_json(const std::uint8_t* request, std::uint64_t request_size,
                                 std::uint8_t* response, std::uint64_t response_capacity)
{
    const auto input = request == nullptr
                           ? std::string_view{}
                           : std::string_view(reinterpret_cast<const char*>(request),
                                              static_cast<std::size_t>(request_size));
    const auto parsed = nlohmann::json::parse(input, nullptr, false);
    nlohmann::json result;
    if (parsed.is_discarded() || !parsed.is_object() || !parsed.contains("path") ||
        !parsed["path"].is_string()) {
        result = {{"ok", false}, {"error", "Disk-space request requires path."}};
    } else {
        std::error_code error;
        const auto info = std::filesystem::space(parsed["path"].get<std::string>(), error);
        if (error)
            result = {{"ok", false},
                      {"error", "Cannot inspect available disk space: " + error.message()}};
        else
            result = info.available;
    }
    const auto text = result.dump();
    const auto required = static_cast<std::uint64_t>(text.size());
    if (response != nullptr && response_capacity >= required)
        std::memcpy(response, text.data(), static_cast<std::size_t>(required));
    return required;
}
