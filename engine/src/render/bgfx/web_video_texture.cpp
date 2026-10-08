#include "render/bgfx/web_video_texture.hpp"

#ifdef __EMSCRIPTEN__
#include "assets/asset_preparation_io.hpp"

#include <array>
#include <atomic>
#include <cmath>

extern "C" {
int nt_web_video_start(const std::uint8_t* bytes, int length, double time_ms, int width, int height,
                       std::uint8_t* pixels, std::atomic<int>* status, char* error,
                       int error_capacity);
void nt_web_video_dispose(int id);
}
#endif

namespace noveltea::bgfx_backend {

#ifdef __EMSCRIPTEN__
namespace {

class WebVideoTextureTask final : public assets::AssetPreparationTask<assets::TextureAsset> {
public:
    WebVideoTextureTask(const assets::AssetManager& assets, TexturePreparationOwner& owner,
                        assets::TextureAssetRequest request)
        : m_owner(owner), m_request(std::move(request)),
          m_read(assets, m_request.video_sample->media_path, "assets.web_video"),
          m_source_bytes(
              assets::detail::estimated_source_size(assets, m_request.video_sample->media_path))
    {
        const auto& sample = *m_request.video_sample;
        const auto pixels = static_cast<std::uint64_t>(sample.width) * sample.height;
        // Browser decode surfaces, Blob copy, canvas/readback, mip storage and bgfx upload copy.
        m_cost = {.source_bytes = m_source_bytes,
                  .gpu_bytes = pixels * 8,
                  .temporary_bytes = m_source_bytes * 2 + pixels * 64};
    }

    ~WebVideoTextureTask() override
    {
        if (m_browser_id)
            nt_web_video_dispose(m_browser_id);
    }

    assets::ResidencyCost estimated_cost_on_owner() const noexcept override { return m_cost; }
    assets::AssetCacheState cache_state_for_next_step() const noexcept override
    {
        return m_read.ready() ? assets::AssetCacheState::Preparing
                              : assets::AssetCacheState::Reading;
    }

    jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        if (context.cancellation_requested())
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        const auto& sample = *m_request.video_sample;
        if (sample.media_path.empty() || sample.width == 0 || sample.height == 0 ||
            sample.width > 10000 || sample.height > 10000 || !std::isfinite(sample.time_ms) ||
            sample.time_ms < 0 || m_request.retain_alpha_coverage)
            return fail("No compatible opaque browser representation for this video sample.");
        if (m_source_bytes == 0 || m_source_bytes > 128u * 1024u * 1024u)
            return fail("Prepared browser video must be nonempty and no larger than 128 MiB.");
        if (!m_read.ready()) {
            const auto result = m_read.step(context);
            if (result.status == jobs::JobStepStatus::Failed)
                return result;
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        }
        if (!m_browser_id) {
            auto bytes = m_read.take_bytes();
            m_pixels.resize(static_cast<std::size_t>(sample.width) * sample.height * 4);
            m_browser_id =
                nt_web_video_start(bytes.data(), static_cast<int>(bytes.size()), sample.time_ms,
                                   sample.width, sample.height, m_pixels.data(), &m_browser_state,
                                   m_browser_error.data(), m_browser_error.size());
            if (!m_browser_id)
                return fail("Browser media preparation could not start.");
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        }
        // Poll shared completion, not synchronous main-thread proxies that starve media events.
        const int state = m_browser_state.load(std::memory_order_acquire);
        if (state < 0)
            return fail(m_browser_error.data());
        if (state == 0)
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        nt_web_video_dispose(m_browser_id);
        m_browser_id = 0;
        auto upload = build_rgba8_mip_chain(m_pixels, sample.width, sample.height);
        if (upload.bytes.empty())
            return fail("Browser video mip preparation failed.");
        m_prepared = PreparedTextureUpload{.request = m_request,
                                           .bytes = std::move(upload.bytes),
                                           .width = sample.width,
                                           .height = sample.height,
                                           .mip_count = upload.mip_count,
                                           .alpha_coverage = std::nullopt};
        m_pixels.clear();
        m_ready = true;
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    core::Result<assets::PreparedAsset<assets::TextureAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        if (!m_ready)
            return core::Result<assets::PreparedAsset<assets::TextureAsset>,
                                core::Diagnostics>::failure({{.code = "assets.web_video.not_ready",
                                                              .message =
                                                                  "Browser sample is not ready."}});
        return m_owner.finalize_texture_on_owner(std::move(m_prepared));
    }

private:
    jobs::JobStepOutcome fail(std::string message) const noexcept
    {
        return {.status = jobs::JobStepStatus::Failed,
                .diagnostics = {{.code = "assets.web_video.sample_failed",
                                 .message = std::move(message),
                                 .source_path = m_request.video_sample->media_path}}};
    }
    TexturePreparationOwner& m_owner;
    assets::TextureAssetRequest m_request;
    assets::detail::IncrementalAssetRead m_read;
    std::uint64_t m_source_bytes;
    assets::ResidencyCost m_cost;
    std::vector<std::uint8_t> m_pixels;
    PreparedTextureUpload m_prepared;
    int m_browser_id = 0;
    std::atomic<int> m_browser_state{0};
    std::array<char, 512> m_browser_error{};
    static_assert(sizeof(std::atomic<int>) == 4 && std::atomic<int>::is_always_lock_free);
    bool m_ready = false;
};

} // namespace
#endif

std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
make_web_video_texture_task(const assets::AssetManager& assets, TexturePreparationOwner& owner,
                            assets::TextureAssetRequest request)
{
#ifdef __EMSCRIPTEN__
    return std::make_unique<WebVideoTextureTask>(assets, owner, std::move(request));
#else
    return nullptr;
#endif
}

} // namespace noveltea::bgfx_backend
