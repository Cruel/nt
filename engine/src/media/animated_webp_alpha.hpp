#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace noveltea::media {

// Occurrence-local, bounded, persistent animated-WebP alpha decoder.
//
// Only the lossless VP8L animation subset emitted by NovelTea preparation is
// admitted. The full RGB images never persist: the decoder retains one R8
// composited canvas, one compressed source and the frame index. Time addressing
// supports holds and backward seeks without allocating a frame atlas.
class AnimatedWebpAlpha {
public:
    struct Frame {
        std::size_t chunk_offset = 0;
        std::size_t chunk_bytes = 0;
        std::uint16_t x = 0;
        std::uint16_t y = 0;
        std::uint16_t width = 0;
        std::uint16_t height = 0;
        std::uint64_t start_ms = 0;
        std::uint64_t duration_ms = 0;
        bool dispose_to_background = false;
        bool blend = false;
    };

    [[nodiscard]] bool open(std::span<const std::uint8_t> bytes, std::uint16_t expected_width,
                            std::uint16_t expected_height, std::uint64_t expected_duration_ms,
                            std::string& error);
    // Returns true on success. 'changed' only reports a different composed mask.
    [[nodiscard]] bool sample(std::uint64_t time_ms, bool& changed, std::string& error);
    [[nodiscard]] std::span<const std::uint8_t> alpha() const noexcept { return m_canvas; }
    [[nodiscard]] std::uint16_t width() const noexcept { return m_width; }
    [[nodiscard]] std::uint16_t height() const noexcept { return m_height; }
    [[nodiscard]] std::size_t page() const noexcept { return m_page; }
    [[nodiscard]] std::size_t frame_count() const noexcept { return m_frames.size(); }
    [[nodiscard]] const std::vector<Frame>& frames() const noexcept { return m_frames; }
    [[nodiscard]] bool ready() const noexcept { return m_ready; }

private:
    [[nodiscard]] bool decode_frame(std::size_t index, std::string& error);
    void reset() noexcept;

    std::vector<std::uint8_t> m_source;
    std::vector<std::uint8_t> m_canvas;
    std::vector<Frame> m_frames;
    std::uint16_t m_width = 0;
    std::uint16_t m_height = 0;
    std::size_t m_page = 0;
    std::optional<std::size_t> m_decoded;
    bool m_ready = false;
};

} // namespace noveltea::media
