#include "media/native_video_decoder.hpp"

#include <catch2/catch_test_macros.hpp>
#include <fstream>
#include <iterator>

namespace {
using namespace noveltea;
std::vector<std::uint8_t> fixture_bytes()
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) + "/tests/fixtures/media/opaque-vp9.webm",
                        std::ios::binary);
    REQUIRE(input);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
std::shared_ptr<const media::NativeVideoFrame> sample(media::NativeVideoDecoder& decoder,
                                                      double time)
{
    for (unsigned attempt = 0; attempt < 20; ++attempt) {
        auto frame = decoder.step(time);
        REQUIRE(frame);
        if (frame.value())
            return frame.value();
    }
    FAIL("Decoder did not reach the requested presentation time in bounded steps");
    return nullptr;
}
} // namespace

TEST_CASE("native VP9 decoder preserves held samples, seeks, and independent occurrences",
          "[video][native-decoder]")
{
    auto source = media::NativeVideoSource::open(fixture_bytes(), 32, 16);
    REQUIRE(source);
    REQUIRE(source.value()->packets().size() == 4);
    media::NativeVideoDecoder first(source.value());
    media::NativeVideoDecoder second(source.value());
    const auto red = sample(first, 0);
    CHECK(red->time_ns == 0);
    REQUIRE(red->y.size() == 512);
    CHECK(red->y.front() == 81);
    CHECK(red->u.front() == 90);
    CHECK(red->v.front() == 240);
    CHECK(sample(first, 49) == red);
    const auto blue = sample(second, 125);
    CHECK(blue->time_ns == 100000000);
    CHECK(blue->y.front() == 41);
    CHECK(blue->u.front() == 240);
    CHECK(blue->v.front() == 110);
    CHECK(sample(first, 25) == red);
    CHECK(sample(second, 149) == blue);
    CHECK(sample(first, 175)->time_ns == 150000000);
    CHECK(sample(first, 0)->time_ns == 0);
    CHECK(sample(second, 1000)->time_ns == 150000000);
}

TEST_CASE("native WebM decoder rejects unsupported and malformed media with typed diagnostics",
          "[video][native-decoder]")
{
    SECTION("not WebM")
    {
        auto source = media::NativeVideoSource::open({1, 2, 3}, 32, 16);
        REQUIRE_FALSE(source);
        CHECK(source.error().front().code == "assets.native_video.invalid_container");
    }
    SECTION("truncated WebM")
    {
        auto bytes = fixture_bytes();
        bytes.resize(bytes.size() / 2);
        CHECK_FALSE(media::NativeVideoSource::open(std::move(bytes), 32, 16));
    }
    SECTION("manifest dimensions mismatch")
    {
        auto source = media::NativeVideoSource::open(fixture_bytes(), 64, 16);
        REQUIRE_FALSE(source);
        CHECK(source.error().front().code == "assets.native_video.dimensions_mismatch");
    }
    SECTION("invalid source envelope")
    {
        auto source = media::NativeVideoSource::open(fixture_bytes(), 0, 16);
        REQUIRE_FALSE(source);
        CHECK(source.error().front().code == "assets.native_video.invalid_source");
    }
    SECTION("terminal packet corruption")
    {
        auto bytes = fixture_bytes();
        auto valid = media::NativeVideoSource::open(bytes, 32, 16);
        REQUIRE(valid);
        const auto packet = valid.value()->packets().back();
        std::fill_n(bytes.begin() + packet.offset, packet.size, 0);
        auto source = media::NativeVideoSource::open(std::move(bytes), 32, 16);
        REQUIRE(source);
        media::NativeVideoDecoder decoder(source.value());
        bool failed = false;
        for (unsigned step = 0; step < 10; ++step) {
            auto result = decoder.step(175);
            if (!result) {
                failed = true;
                CHECK(result.error().front().code == "assets.native_video.decode_failed");
                break;
            }
        }
        CHECK(failed);
    }
}
