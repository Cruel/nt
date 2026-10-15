#include "media/animated_webp_alpha.hpp"

#include <bimg/bimg.h>
#include <bimg/decode.h>
#include <bx/allocator.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>

namespace noveltea::media {
namespace {
constexpr std::size_t max_encoded_bytes = 128u * 1024u * 1024u;
constexpr std::size_t max_canvas_pixels = 16u * 1024u * 1024u;
constexpr std::size_t max_frames = 65536;

bool fourcc(std::span<const std::uint8_t> bytes, std::size_t offset, const char* name)
{
    return offset <= bytes.size() && bytes.size() - offset >= 4 &&
           std::memcmp(bytes.data() + offset, name, 4) == 0;
}

std::uint32_t u24(std::span<const std::uint8_t> bytes, std::size_t offset)
{
    return static_cast<std::uint32_t>(bytes[offset]) |
           (static_cast<std::uint32_t>(bytes[offset + 1]) << 8) |
           (static_cast<std::uint32_t>(bytes[offset + 2]) << 16);
}

std::uint32_t u32(std::span<const std::uint8_t> bytes, std::size_t offset)
{
    return u24(bytes, offset) | (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
}

bool vp8l_dimensions_match(std::span<const std::uint8_t> bytes, std::size_t chunk,
                           std::size_t length, std::uint32_t width, std::uint32_t height)
{
    if (length < 5 || bytes[chunk + 8] != 0x2fu)
        return false;
    const auto at = chunk + 9;
    const auto decoded_width = static_cast<std::uint32_t>(bytes[at]) +
                               ((static_cast<std::uint32_t>(bytes[at + 1]) & 0x3fu) << 8) + 1;
    const auto decoded_height = ((static_cast<std::uint32_t>(bytes[at + 1]) >> 6) & 0x03u) +
                                (static_cast<std::uint32_t>(bytes[at + 2]) << 2) +
                                ((static_cast<std::uint32_t>(bytes[at + 3]) & 0x0fu) << 10) + 1;
    return decoded_width == width && decoded_height == height;
}

void put32(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value)
{
    for (std::size_t i = 0; i < 4; ++i)
        bytes[offset + i] = static_cast<std::uint8_t>(value >> (i * 8));
}

bool chunk_bounds(std::span<const std::uint8_t> bytes, std::size_t at, std::size_t end,
                  std::size_t& next, std::size_t& size)
{
    if (at > end || end - at < 8)
        return false;
    size = u32(bytes, at + 4);
    const auto padded = size + (size & 1u);
    if (padded > end - at - 8)
        return false;
    next = at + 8 + padded;
    return true;
}
} // namespace

void AnimatedWebpAlpha::reset() noexcept
{
    std::fill(m_canvas.begin(), m_canvas.end(), 0);
    m_decoded.reset();
    m_ready = false;
}

bool AnimatedWebpAlpha::open(std::span<const std::uint8_t> bytes, std::uint16_t expected_width,
                             std::uint16_t expected_height, std::uint64_t expected_duration_ms,
                             std::string& error)
{
    m_source.clear();
    m_frames.clear();
    m_canvas.clear();
    m_width = m_height = 0;
    reset();
    if (bytes.size() < 30 || bytes.size() > max_encoded_bytes || !fourcc(bytes, 0, "RIFF") ||
        !fourcc(bytes, 8, "WEBP") ||
        static_cast<std::uint64_t>(u32(bytes, 4)) + 8 != bytes.size()) {
        error = "Invalid or oversized animated WebP RIFF stream.";
        return false;
    }
    const std::size_t pixels = static_cast<std::size_t>(expected_width) * expected_height;
    if (!pixels || pixels > max_canvas_pixels || !expected_duration_ms) {
        error = "Invalid or oversized alpha canvas or motion duration.";
        return false;
    }

    bool header = false;
    bool animation = false;
    std::uint64_t start = 0;
    for (std::size_t at = 12; at < bytes.size();) {
        std::size_t next = 0;
        std::size_t size = 0;
        if (!chunk_bounds(bytes, at, bytes.size(), next, size)) {
            error = "Malformed top-level WebP chunk.";
            return false;
        }
        if (fourcc(bytes, at, "VP8X")) {
            if (header || size != 10 || (bytes[at + 8] & 0x02u) == 0 ||
                u24(bytes, at + 12) + 1 != expected_width ||
                u24(bytes, at + 15) + 1 != expected_height) {
                error = "Alpha WebP must have one animated VP8X header matching the canvas.";
                return false;
            }
            header = true;
        } else if (fourcc(bytes, at, "ANIM")) {
            if (!header || animation || size != 6) {
                error = "Malformed WebP animation header.";
                return false;
            }
            animation = true;
        } else if (fourcc(bytes, at, "VP8L") && at == 12 && next == bytes.size()) {
            if (!vp8l_dimensions_match(bytes, at, size, expected_width, expected_height)) {
                error = "Lossless WebP alpha frame header has an invalid canvas extent.";
                return false;
            }
            // Sharp emits a still lossless WebP when the complete motion has
            // just one alpha hold. This represents one timed page, not a
            // second color stream or an opaque decoder fallback.
            m_frames.push_back({.chunk_offset = at,
                                .chunk_bytes = next - at,
                                .width = expected_width,
                                .height = expected_height,
                                .start_ms = 0,
                                .duration_ms = expected_duration_ms});
            start = expected_duration_ms;
        } else if (fourcc(bytes, at, "ANMF")) {
            if (!header || !animation || size < 16 || m_frames.size() == max_frames) {
                error = "Malformed or oversized WebP alpha animation.";
                return false;
            }
            const auto payload = at + 8;
            const auto x = u24(bytes, payload) * 2u;
            const auto y = u24(bytes, payload + 3) * 2u;
            const auto width = u24(bytes, payload + 6) + 1;
            const auto height = u24(bytes, payload + 9) + 1;
            const auto duration = u24(bytes, payload + 12);
            const auto flags = bytes[payload + 15];
            if (!width || !height || x + width > expected_width || y + height > expected_height ||
                !duration || flags & ~0x03u ||
                duration > expected_duration_ms - std::min(start, expected_duration_ms)) {
                error = "Out-of-bounds animated-WebP rectangle or duration.";
                return false;
            }
            std::size_t inner_next = 0;
            std::size_t inner_size = 0;
            const auto inner = payload + 16;
            if (!chunk_bounds(bytes, inner, at + 8 + size, inner_next, inner_size) ||
                !fourcc(bytes, inner, "VP8L") || inner_next != at + 8 + size ||
                !vp8l_dimensions_match(bytes, inner, inner_size, width, height)) {
                error = "Alpha animation requires one lossless VP8L payload per frame.";
                return false;
            }
            m_frames.push_back({.chunk_offset = inner,
                                .chunk_bytes = inner_next - inner,
                                .x = static_cast<std::uint16_t>(x),
                                .y = static_cast<std::uint16_t>(y),
                                .width = static_cast<std::uint16_t>(width),
                                .height = static_cast<std::uint16_t>(height),
                                .start_ms = start,
                                .duration_ms = duration,
                                .dispose_to_background = (flags & 1u) != 0,
                                .blend = (flags & 2u) == 0});
            start += duration;
        } else {
            error = "Unsupported chunk in lossless animated-WebP alpha.";
            return false;
        }
        at = next;
    }
    const bool animated = header && animation;
    const bool still = !header && !animation && m_frames.size() == 1;
    if ((!animated && !still) || m_frames.empty() || start != expected_duration_ms) {
        error = "Alpha WebP does not cover exactly the prepared color timeline.";
        return false;
    }
    m_width = expected_width;
    m_height = expected_height;
    m_source.assign(bytes.begin(), bytes.end());
    m_canvas.resize(pixels, 0);
    return true;
}

bool AnimatedWebpAlpha::decode_frame(std::size_t index, std::string& error)
{
    const auto& frame = m_frames[index];
    // bimg already ships with NovelTea on native and Web. Feed the validated
    // standalone VP8L chunk rather than decoding the animated container as a
    // still image (which would silently lose all later frames).
    std::vector<std::uint8_t> still(12 + frame.chunk_bytes, 0);
    std::memcpy(still.data(), "RIFF", 4);
    put32(still, 4, static_cast<std::uint32_t>(still.size() - 8));
    std::memcpy(still.data() + 8, "WEBP", 4);
    std::memcpy(still.data() + 12, m_source.data() + frame.chunk_offset, frame.chunk_bytes);
    bx::DefaultAllocator allocator;
    auto* image =
        bimg::imageParse(&allocator, still.data(), static_cast<std::uint32_t>(still.size()),
                         bimg::TextureFormat::RGBA8);
    if (!image) {
        error = "Failed to decode prepared lossless WebP alpha frame.";
        return false;
    }
    bimg::ImageMip mip;
    const bool valid = image->m_width == frame.width && image->m_height == frame.height &&
                       bimg::imageGetRawData(*image, 0, 0, image->m_data, image->m_size, mip) &&
                       mip.m_format == bimg::TextureFormat::RGBA8;
    if (!valid) {
        bimg::imageFree(image);
        error = "Decoded WebP frame does not match its declared bounds.";
        return false;
    }
    if (index && m_frames[index - 1].dispose_to_background) {
        const auto& previous = m_frames[index - 1];
        for (std::uint32_t y = previous.y; y < previous.y + previous.height; ++y)
            std::fill_n(m_canvas.data() + static_cast<std::size_t>(y) * m_width + previous.x,
                        previous.width, 0);
    }
    const auto* rgba = static_cast<const std::uint8_t*>(mip.m_data);
    for (std::uint32_t y = 0; y < frame.height; ++y) {
        for (std::uint32_t x = 0; x < frame.width; ++x) {
            const std::size_t dest = static_cast<std::size_t>(frame.y + y) * m_width + frame.x + x;
            const auto source_alpha = rgba[(static_cast<std::size_t>(y) * frame.width + x) * 4 + 3];
            auto& alpha = m_canvas[dest];
            alpha =
                frame.blend
                    ? static_cast<std::uint8_t>(
                          source_alpha +
                          (static_cast<std::uint32_t>(alpha) * (255u - source_alpha) + 127u) / 255u)
                    : source_alpha;
        }
    }
    bimg::imageFree(image);
    return true;
}

bool AnimatedWebpAlpha::sample(std::uint64_t time_ms, bool& changed, std::string& error)
{
    changed = false;
    if (m_frames.empty()) {
        error = "No animated WebP was opened.";
        return false;
    }
    if (time_ms >= m_frames.back().start_ms + m_frames.back().duration_ms) {
        error = "Alpha sample exceeds the prepared motion endpoint.";
        return false;
    }
    const auto found = std::upper_bound(
        m_frames.begin(), m_frames.end(), time_ms,
        [](std::uint64_t timestamp, const Frame& frame) { return timestamp < frame.start_ms; });
    const auto target = static_cast<std::size_t>(std::distance(m_frames.begin(), found) - 1);
    if (m_decoded && target == *m_decoded) {
        m_page = target;
        return true;
    }
    if (m_decoded && target < *m_decoded)
        reset();
    const auto first = m_decoded ? *m_decoded + 1 : 0;
    for (std::size_t i = first; i <= target; ++i) {
        if (!decode_frame(i, error)) {
            reset();
            return false;
        }
    }
    m_decoded = target;
    m_page = target;
    m_ready = true;
    changed = true;
    return true;
}

} // namespace noveltea::media
