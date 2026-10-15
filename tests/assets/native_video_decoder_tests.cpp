#include "media/native_video_decoder.hpp"

#include <catch2/catch_test_macros.hpp>
#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <thread>

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
        if (!frame) {
            INFO("backend=" << decoder.backend() << ", requested_ms=" << time
                            << ", attempt=" << attempt);
            FAIL(frame.error().front().code << ": " << frame.error().front().message);
        }
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
    if (std::string_view(first.backend()) == "libvpx-vp9")
        CHECK_FALSE(first.fallback_reason().empty());
    else
        CHECK(first.fallback_reason().empty());
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

TEST_CASE("native NVIDIA NVDEC decodes VP9 and recovers on seek", "[video][native-decoder][nvdec]")
{
    // Optional GPU integration test. Pass a 256x144, 24 fps opaque VP9 WebM through
    // NOVELTEA_NVDEC_TEST_WEBM; ordinary CPU-only CI never requires an NVIDIA driver.
    const auto* file = std::getenv("NOVELTEA_NVDEC_TEST_WEBM");
    if (!file || !*file)
        return;
    std::ifstream input(file, std::ios::binary);
    REQUIRE(input);
    std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(input),
                                    std::istreambuf_iterator<char>()};
    auto source = media::NativeVideoSource::open(std::move(bytes), 256, 144);
    REQUIRE(source);
    media::NativeVideoDecoder decoder(source.value());
    const auto first = sample(decoder, 0);
    CHECK(std::string_view(decoder.backend()) == "nvdec-vp9");
    CHECK(decoder.fallback_reason().empty());
    REQUIRE(first->y.size() == 256u * 144u);
    REQUIRE(first->u.size() == 128u * 72u);
    REQUIRE(first->v.size() == 128u * 72u);
    // Optionally compare hardware output byte-for-byte with a software-decoded I420
    // reference from the very same lossless VP9 stream.
    if (const auto* expected = std::getenv("NOVELTEA_NVDEC_TEST_I420")) {
        std::ifstream raw(expected, std::ios::binary);
        REQUIRE(raw);
        std::vector<std::uint8_t> yuv{std::istreambuf_iterator<char>(raw),
                                      std::istreambuf_iterator<char>()};
        REQUIRE(yuv.size() >= first->y.size() + first->u.size() + first->v.size());
        const auto y_end = yuv.begin() + first->y.size();
        const auto u_end = y_end + first->u.size();
        CHECK(std::equal(yuv.begin(), y_end, first->y.begin()));
        CHECK(std::equal(y_end, u_end, first->u.begin()));
        CHECK(std::equal(u_end, u_end + first->v.size(), first->v.begin()));
    }
    const auto middle = sample(decoder, 500);
    CHECK(middle->time_ns >= 450000000);
    CHECK(middle->time_ns <= 500000000);
    CHECK(first->y != middle->y);
    // Decoder ownership may move between worker threads; CUDA contexts are thread-local.
    std::shared_ptr<const media::NativeVideoFrame> relocated;
    std::string thread_error;
    std::thread worker([&] {
        for (unsigned attempt = 0; attempt < 20; ++attempt) {
            auto result = decoder.step(750);
            if (!result) {
                thread_error = result.error().front().code;
                break;
            }
            if (result.value()) {
                relocated = std::move(result).value();
                break;
            }
        }
    });
    worker.join();
    CHECK(thread_error.empty());
    REQUIRE(relocated);
    CHECK(relocated->time_ns >= 700000000);
    const auto reset = sample(decoder, 0);
    CHECK(reset->time_ns == 0);
    CHECK(std::string_view(decoder.backend()) == "nvdec-vp9");
    media::NativeVideoDecoder independent(source.value());
    CHECK(sample(independent, 250)->time_ns >= 200000000);
    CHECK(std::string_view(independent.backend()) == "nvdec-vp9");
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
