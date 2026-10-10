#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"

#include <cstdint>
#include <memory>
#include <span>
#include <vector>

namespace noveltea::media {

struct VideoPacket {
    std::size_t offset = 0;
    std::size_t size = 0;
    std::uint64_t time_ns = 0;
    bool keyframe = false;
};

class NativeVideoSource {
public:
    [[nodiscard]] static core::Result<std::shared_ptr<const NativeVideoSource>, core::Diagnostics>
    open(std::vector<std::uint8_t> bytes, std::uint16_t width, std::uint16_t height);
    [[nodiscard]] std::span<const std::uint8_t> packet(std::size_t index) const noexcept;
    [[nodiscard]] const std::vector<VideoPacket>& packets() const noexcept { return m_packets; }
    [[nodiscard]] std::uint16_t width() const noexcept { return m_width; }
    [[nodiscard]] std::uint16_t height() const noexcept { return m_height; }
    [[nodiscard]] std::uint64_t resident_bytes() const noexcept;

private:
    std::vector<std::uint8_t> m_bytes;
    std::vector<VideoPacket> m_packets;
    std::uint16_t m_width = 0;
    std::uint16_t m_height = 0;
};

struct NativeVideoFrame {
    std::uint64_t time_ns = 0;
    std::uint16_t width = 0;
    std::uint16_t height = 0;
    std::vector<std::uint8_t> y;
    std::vector<std::uint8_t> u;
    std::vector<std::uint8_t> v;
    bool full_range = false;
    bool bt709 = false;
};

class NativeVideoDecoder {
public:
    explicit NativeVideoDecoder(std::shared_ptr<const NativeVideoSource> source);
    ~NativeVideoDecoder();
    NativeVideoDecoder(const NativeVideoDecoder&) = delete;
    NativeVideoDecoder& operator=(const NativeVideoDecoder&) = delete;
    // One packet per step; callers reschedule absent results rather than blocking the owner.
    [[nodiscard]] core::Result<std::shared_ptr<const NativeVideoFrame>, core::Diagnostics>
    step(double time_ms);
    [[nodiscard]] static std::uint64_t memory_budget(std::uint16_t width, std::uint16_t height);
    [[nodiscard]] const char* backend() const noexcept;
    [[nodiscard]] std::uint64_t resident_budget() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::media
