#include "media/animated_webp_alpha.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace {
std::vector<std::uint8_t> from_hex(std::string_view hex)
{
    auto nibble = [](char c) -> std::uint8_t {
        return c >= '0' && c <= '9' ? static_cast<std::uint8_t>(c - '0')
                                    : static_cast<std::uint8_t>(c - 'a' + 10);
    };
    std::vector<std::uint8_t> bytes;
    for (std::size_t i = 0; i < hex.size(); i += 2)
        bytes.push_back(static_cast<std::uint8_t>(nibble(hex[i]) * 16 + nibble(hex[i + 1])));
    return bytes;
}
std::vector<std::uint8_t> fixture()
{
    // Two lossless pages created by the production Sharp encoder:
    // [255, 0] alpha for 100ms; [0, 128] for 200ms.
    return from_hex("524946468a00000057454250565038580a00000012000000010000000000"
                    "414e494d06000000ffffffff0000"
                    "414e4d462a00000000000000000001000000000064000002"
                    "5650384c120000002f010000100f30fff33ffff31ff0c888fe07"
                    "414e4d462c000000000000000000010000000000c8000002"
                    "5650384c130000002f010000100f30fff33fff0318f0a84044ff0300");
}
} // namespace

TEST_CASE("animated WebP alpha is persistent, timed, bounded, and rewindable", "[video][alpha]")
{
    const auto data = fixture();
    noveltea::media::AnimatedWebpAlpha decoder;
    std::string error;
    REQUIRE(decoder.open(data, 2, 1, 300, error));
    CHECK(decoder.frame_count() == 2);
    CHECK(decoder.frames()[0].duration_ms == 100);
    CHECK(decoder.frames()[1].duration_ms == 200);
    bool changed = false;
    REQUIRE(decoder.sample(0, changed, error));
    CHECK(changed);
    CHECK(decoder.alpha()[0] == 255);
    CHECK(decoder.alpha()[1] == 0);
    CHECK(decoder.page() == 0);
    REQUIRE(decoder.sample(99, changed, error));
    CHECK_FALSE(changed);
    REQUIRE(decoder.sample(100, changed, error));
    CHECK(changed);
    CHECK(decoder.page() == 1);
    CHECK(decoder.alpha()[0] == 0);
    CHECK(decoder.alpha()[1] == 128);
    REQUIRE(decoder.sample(299, changed, error));
    CHECK_FALSE(changed);
    CHECK_FALSE(decoder.sample(300, changed, error));
    REQUIRE(decoder.sample(0, changed, error));
    CHECK(changed);
    CHECK(decoder.alpha()[0] == 255);
    CHECK(decoder.alpha()[1] == 0);
}

TEST_CASE("one alpha hold is a lossless still WebP across the full motion", "[video][alpha]")
{
    // Sharp's one-page output has a VP8L chunk, not VP8X/ANIM/ANMF.
    const auto data =
        from_hex("524946461e000000574542505650384c120000002f010000100f30fff33ffff31ff0c888fe07");
    noveltea::media::AnimatedWebpAlpha decoder;
    std::string error;
    REQUIRE(decoder.open(data, 2, 1, 300, error));
    CHECK(decoder.frame_count() == 1);
    bool changed = false;
    REQUIRE(decoder.sample(0, changed, error));
    CHECK(changed);
    CHECK(decoder.alpha()[0] == 255);
    CHECK(decoder.alpha()[1] == 0);
    REQUIRE(decoder.sample(299, changed, error));
    CHECK_FALSE(changed);
    CHECK_FALSE(decoder.sample(300, changed, error));
}

TEST_CASE("animated WebP alpha rejects corrupt inputs and mismatched timelines", "[video][alpha]")
{
    std::string error;
    noveltea::media::AnimatedWebpAlpha decoder;
    const auto data = fixture();
    CHECK_FALSE(decoder.open(data, 1, 1, 300, error));
    CHECK_FALSE(decoder.open(data, 2, 1, 299, error));
    CHECK_FALSE(decoder.open(data, 2, 1, 0, error));
    CHECK_FALSE(decoder.open(data, 2, 1, 300000000, error));
    auto corrupt = data;
    corrupt[0] = 0;
    CHECK_FALSE(decoder.open(corrupt, 2, 1, 300, error));
    corrupt = data;
    // First ANMF's VP8L payload must be lossless.
    constexpr std::string_view marker{"VP8L"};
    const auto location = std::search(corrupt.begin(), corrupt.end(), marker.begin(), marker.end());
    REQUIRE(location != corrupt.end());
    *location = 'X';
    CHECK_FALSE(decoder.open(corrupt, 2, 1, 300, error));
    corrupt = data;
    const auto payload = std::search(corrupt.begin(), corrupt.end(), marker.begin(), marker.end());
    REQUIRE(payload != corrupt.end());
    // A malicious VP8L payload cannot declare a much larger decoded frame
    // than the bounded animation rectangle admitted by the container.
    corrupt[static_cast<std::size_t>(std::distance(corrupt.begin(), payload)) + 5] = 0xff;
    CHECK_FALSE(decoder.open(corrupt, 2, 1, 300, error));
}
