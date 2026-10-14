#include "media/video_alpha_session.hpp"

#include <bgfx/bgfx.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <utility>

namespace noveltea::media {
namespace {
class BgfxVideoAlphaSession final : public VideoAlphaSession {
public:
    ~BgfxVideoAlphaSession() override
    {
        for (auto handle : m_textures)
            if (bgfx::isValid(handle))
                bgfx::destroy(handle);
    }

    bool open(std::span<const std::uint8_t> bytes, std::uint16_t width, std::uint16_t height,
              std::uint64_t duration_ms, std::string& error)
    {
        if (!m_decoder.open(bytes, width, height, duration_ms, error))
            return false;
        if (!bgfx::isTextureValid(0, false, 1, bgfx::TextureFormat::R8, BGFX_TEXTURE_NONE)) {
            error = "The active GPU backend cannot allocate R8 video alpha textures.";
            return false;
        }
        constexpr std::uint64_t flags = BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP |
                                        BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT |
                                        BGFX_SAMPLER_MIP_POINT;
        // Retain three independently uploaded masks: avoid overwriting a
        // previous submitted draw while bgfx has frames in flight.
        for (auto& texture : m_textures) {
            texture =
                bgfx::createTexture2D(width, height, false, 1, bgfx::TextureFormat::R8, flags);
            if (!bgfx::isValid(texture)) {
                error = "GPU allocation failed for video alpha R8 plane.";
                return false;
            }
        }
        return true;
    }

    bool sample(std::uint64_t time_ms, std::string& error) override
    {
        bool changed = false;
        if (!m_decoder.sample(time_ms, changed, error))
            return false;
        if (!changed)
            return true;
        m_current = (m_current + 1) % m_textures.size();
        const auto bytes = m_decoder.alpha();
        if (bytes.size() > std::numeric_limits<std::uint32_t>::max()) {
            error = "Video alpha mask exceeds GPU upload limit.";
            return false;
        }
        bgfx::updateTexture2D(m_textures[m_current], 0, 0, 0, 0, m_decoder.width(),
                              m_decoder.height(),
                              bgfx::copy(bytes.data(), static_cast<std::uint32_t>(bytes.size())));
        m_presented = true;
        ++m_uploads;
        return true;
    }

    Texture texture() const noexcept override
    {
        return m_presented ? Texture{m_textures[m_current].idx} : Texture{};
    }

    bool hit(float u, float v) const noexcept override
    {
        if (!m_presented || !std::isfinite(u) || !std::isfinite(v) || u < 0.0f || v < 0.0f ||
            u > 1.0f || v > 1.0f)
            return false;
        const auto x = std::min(static_cast<std::uint32_t>(u * m_decoder.width()),
                                static_cast<std::uint32_t>(m_decoder.width() - 1));
        const auto y = std::min(static_cast<std::uint32_t>(v * m_decoder.height()),
                                static_cast<std::uint32_t>(m_decoder.height() - 1));
        return m_decoder.alpha()[static_cast<std::size_t>(y) * m_decoder.width() + x] > 0;
    }

    bool ready() const noexcept override { return m_presented; }
    std::uint64_t upload_count() const noexcept override { return m_uploads; }

private:
    AnimatedWebpAlpha m_decoder;
    std::array<bgfx::TextureHandle, 3> m_textures{
        {BGFX_INVALID_HANDLE, BGFX_INVALID_HANDLE, BGFX_INVALID_HANDLE}};
    std::size_t m_current = 2;
    bool m_presented = false;
    std::uint64_t m_uploads = 0;
};
} // namespace

std::unique_ptr<VideoAlphaSession>
make_video_alpha_session(std::span<const std::uint8_t> bytes, std::uint16_t width,
                         std::uint16_t height, std::uint64_t duration_ms, std::string& error)
{
    auto session = std::make_unique<BgfxVideoAlphaSession>();
    if (!session->open(bytes, width, height, duration_ms, error))
        return nullptr;
    return session;
}

} // namespace noveltea::media
