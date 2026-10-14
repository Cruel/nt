#pragma once

#include "media/animated_webp_alpha.hpp"
#include "noveltea/render/quad_batch.hpp"

#include <cstdint>
#include <memory>
#include <span>
#include <string>

namespace noveltea::media {

// One video occurrence owns one decoder, GPU mask set, and CPU hit mask.
// Both rendering and hit testing consume the last successfully published page.
class VideoAlphaSession {
public:
    virtual ~VideoAlphaSession() = default;
    [[nodiscard]] virtual bool sample(std::uint64_t presentation_time_ms, std::string& error) = 0;
    [[nodiscard]] virtual Texture texture() const noexcept = 0;
    [[nodiscard]] virtual bool hit(float u, float v) const noexcept = 0;
    [[nodiscard]] virtual bool ready() const noexcept = 0;
    [[nodiscard]] virtual std::uint64_t upload_count() const noexcept = 0;
};

[[nodiscard]] std::unique_ptr<VideoAlphaSession>
make_video_alpha_session(std::span<const std::uint8_t> bytes, std::uint16_t width,
                         std::uint16_t height, std::uint64_t duration_ms, std::string& error);

} // namespace noveltea::media
