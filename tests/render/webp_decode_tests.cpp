#include <bimg/bimg.h>
#include <bimg/decode.h>
#include <bx/allocator.h>

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string_view>
#include <vector>

namespace {

std::vector<std::uint8_t> read_bytes(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    REQUIRE(input.good());
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

} // namespace

TEST_CASE("bimg decodes the Feature Lab WebP texture fixtures to RGBA8")
{
    const std::filesystem::path root =
        std::filesystem::path(NOVELTEA_SOURCE_DIR) / "tests/projects/feature-lab/assets/images";
    constexpr std::string_view fixtures[] = {
        "bedroom.webp",
        "button.webp",
        "girl_normal.webp",
        "girl_smile.webp",
    };

    bx::DefaultAllocator allocator;
    for (const std::string_view fixture : fixtures) {
        CAPTURE(fixture);
        const auto bytes = read_bytes(root / fixture);
        REQUIRE_FALSE(bytes.empty());
        REQUIRE(bytes.size() <= UINT32_MAX);

        bimg::ImageContainer* image =
            bimg::imageParse(&allocator, bytes.data(), static_cast<std::uint32_t>(bytes.size()),
                             bimg::TextureFormat::RGBA8);
        REQUIRE(image != nullptr);
        CHECK(image->m_width > 0);
        CHECK(image->m_height > 0);
        CHECK(image->m_format == bimg::TextureFormat::RGBA8);
        CHECK(image->m_numLayers == 1);
        CHECK(bimg::imageGetNumSlices(*image) == 1);
        bimg::ImageMip mip{};
        REQUIRE(bimg::imageGetRawData(*image, 0, 0, image->m_data, image->m_size, mip));
        CHECK(mip.m_format == bimg::TextureFormat::RGBA8);
        CHECK(mip.m_width == image->m_width);
        CHECK(mip.m_height == image->m_height);
        bimg::imageFree(image);
    }
}
