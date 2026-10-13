#include "render/bgfx/web_video_texture.hpp"

#ifdef __EMSCRIPTEN__
#include "assets/asset_preparation_io.hpp"

#include <bgfx/bgfx.h>
#include <GLES3/gl3.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <limits>

extern "C" {
int nt_web_video_create(const std::uint8_t* bytes, int length, int width, int height);
int nt_web_video_sample(int id, double time_ms, std::atomic<int>* status, char* error,
                        int error_capacity);
int nt_web_video_upload(int id, int texture, char* error, int error_capacity);
void nt_web_video_cancel(int id);
void nt_web_video_dispose(int id);
}
#endif

namespace noveltea::bgfx_backend {
#ifdef __EMSCRIPTEN__
namespace {
using Texture = assets::TextureAsset;
using Request = assets::TextureAssetRequest;
using Task = assets::AssetPreparationTask<Texture>;
using Prepared = assets::PreparedAsset<Texture>;

std::atomic<std::uint64_t> next_session{1};
std::atomic<std::uint64_t> render_epoch{0};
constexpr auto no_epoch = std::numeric_limits<std::uint64_t>::max();
constexpr auto texture_flags = BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;

struct RetiredTexture {
    GLuint texture;
    std::uint64_t epoch;
};
std::vector<RetiredTexture> retired_textures;

class Session;
std::vector<std::weak_ptr<Session>> live_sessions;

core::Diagnostics error(std::string code, std::string message)
{
    return {{.code = "assets.web_video." + code, .message = std::move(message)}};
}

class Source final : public assets::VideoTextureSource,
                     public std::enable_shared_from_this<Source> {
public:
    std::shared_ptr<assets::VideoTextureSession> create_session() override;
    std::vector<std::uint8_t> bytes;
};

class SurfacePin final : public assets::VideoTextureResidencyPin {
public:
    explicit SurfacePin(assets::AssetLease<Texture> lease) : lease(std::move(lease)) {}
    assets::AssetLease<Texture> lease;
};

class Session final : public assets::VideoTextureSession,
                      public std::enable_shared_from_this<Session> {
public:
    explicit Session(std::shared_ptr<Source> source, bool seed = false)
        : source(std::move(source)), id(next_session.fetch_add(1)), seed(seed)
    {
    }
    ~Session() override { dispose_browser(); }
    std::uint64_t identity() const noexcept override { return id; }
    const char* backend() const noexcept override { return "browser-media-gpu"; }
    std::uint64_t uploads_on_owner() const noexcept override { return uploads; }
    void set_presented_texture_on_owner(std::uint16_t handle) noexcept override
    {
        presented = handle;
    }
    std::shared_ptr<assets::VideoTextureResidencyPin>
    retain_residency(const assets::AssetLease<Texture>& lease) override
    {
        auto pin = std::make_shared<SurfacePin>(lease);
        residency_pin = pin;
        return pin;
    }
    std::unique_ptr<Task> create_texture_preparation_task(Request request) override;
    void dispose_browser()
    {
        if (browser_id)
            nt_web_video_dispose(browser_id);
        browser_id = 0;
    }
    void retire_on_owner()
    {
        dispose_browser();
        for (auto& texture : textures) {
            if (bgfx::isValid(texture))
                bgfx::destroy(texture);
            texture = BGFX_INVALID_HANDLE;
        }
        // bgfx may still have submitted draws referencing the imported names.
        for (auto texture : native_textures)
            if (texture)
                retired_textures.push_back({texture, render_epoch.load(std::memory_order_relaxed)});
        native_textures = {};
        admitted = false;
        last_time.reset();
        uploaded_epoch = no_epoch;
    }
    std::shared_ptr<Source> source;
    std::weak_ptr<assets::VideoTextureResidencyPin> residency_pin;
    const std::uint64_t id;
    const bool seed;
    std::atomic<bool> busy{false};
    bool admitted = false;
    int browser_id = 0;
    std::array<bgfx::TextureHandle, 2> textures{{BGFX_INVALID_HANDLE, BGFX_INVALID_HANDLE}};
    std::array<GLuint, 2> native_textures{};
    std::uint64_t uploaded_epoch = no_epoch;
    std::uint64_t uploads = 0;
    std::uint16_t presented = assets::invalid_typed_asset_handle;
    unsigned output = 0;
    std::optional<double> last_time;
};

std::shared_ptr<Session> register_session(std::shared_ptr<Session> session)
{
    std::erase_if(live_sessions, [](const auto& weak) { return weak.expired(); });
    live_sessions.push_back(session);
    return session;
}

std::shared_ptr<assets::VideoTextureSession> Source::create_session()
{
    return register_session(std::make_shared<Session>(shared_from_this()));
}

class SampleTask final : public Task {
public:
    SampleTask(std::shared_ptr<Session> session, Request request,
               const assets::AssetManager* assets = nullptr)
        : m_session(std::move(session)), m_request(std::move(request)),
          m_first(!m_session->admitted), m_pin(m_session->residency_pin.lock()),
          m_source_bytes(assets ? assets::detail::estimated_source_size(
                                      *assets, m_request.video_sample->media_path)
                                : m_session->source->bytes.size())
    {
        if (assets)
            m_read = std::make_unique<assets::detail::IncrementalAssetRead>(
                *assets, m_request.video_sample->media_path, "assets.web_video");
    }
    ~SampleTask() override
    {
        if (!m_claimed)
            return;
        if (m_session->browser_id)
            nt_web_video_cancel(m_session->browser_id);
        // Only owner finalization, eviction and renderer shutdown may touch bgfx/GL objects.
        if (!m_session->admitted)
            m_session->dispose_browser();
        m_session->busy.store(false, std::memory_order_release);
    }
    bool cache_after_release_on_owner() const noexcept override { return m_session->seed; }
    assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        const auto& sample = *m_request.video_sample;
        const auto pixels = static_cast<std::uint64_t>(sample.width) * sample.height;
        // Each occurrence charges the shared encoded source conservatively: its final alias
        // may outlive the seed's source lease. It also owns a Blob and browser decoder frames.
        const auto decoder_budget = m_session->seed ? 0 : m_source_bytes + pixels * 48;
        return {.source_bytes = m_first ? m_source_bytes : 0,
                .prepared_cpu_bytes = m_first ? decoder_budget : 0,
                .gpu_bytes = m_first ? pixels * (m_session->seed ? 4 : 8) : 0,
                .temporary_bytes = m_first ? m_source_bytes * 2 + pixels * 48 : 0};
    }
    assets::AssetCacheState cache_state_for_next_step() const noexcept override
    {
        return m_read && !m_read->ready() ? assets::AssetCacheState::Reading
                                          : assets::AssetCacheState::Preparing;
    }
    void upload_on_owner()
    {
        const auto& sample = *m_request.video_sample;
        const auto epoch = render_epoch.load(std::memory_order_acquire);
        // Web disables bgfx's render thread: interop runs only here on the renderer owner.
        if (bgfx::getRendererType() != bgfx::RendererType::OpenGLES ||
            !(bgfx::getCaps()->supported & BGFX_CAPS_TEXTURE_EXTERNAL) ||
            sample.width > bgfx::getCaps()->limits.maxTextureSize ||
            sample.height > bgfx::getCaps()->limits.maxTextureSize) {
            m_diagnostics = error("unsupported_gpu",
                                  "Browser video requires an admitted WebGL texture extent.");
            return;
        }
        if (epoch == m_session->uploaded_epoch)
            return;
        if (!bgfx::isValid(m_session->textures[0])) {
            GLint binding = 0;
            glGetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
            for (unsigned i = 0; i < (m_session->seed ? 1u : 2u); ++i) {
                auto& texture = m_session->native_textures[i];
                glGenTextures(1, &texture);
                glBindTexture(GL_TEXTURE_2D, texture);
                glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, sample.width, sample.height);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
                const auto failure = glGetError();
                glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(binding));
                if (!texture || failure != GL_NO_ERROR) {
                    m_diagnostics = error("gpu_allocation_failed",
                                          "Could not allocate a browser media texture.");
                    return;
                }
                m_session->textures[i] = bgfx::createTexture2D(sample.width, sample.height, false,
                                                               1, bgfx::TextureFormat::RGBA8,
                                                               texture_flags, nullptr, texture);
                if (!bgfx::isValid(m_session->textures[i])) {
                    m_diagnostics = error("unsupported_gpu",
                                          "bgfx could not import the browser media texture.");
                    return;
                }
            }
        }
        if (!m_session->last_time || *m_session->last_time != sample.time_ms) {
            // Discarded rewind samples must not overwrite the surface still held by presentation.
            m_session->output =
                !m_session->seed && m_session->textures[0].idx == m_session->presented ? 1 : 0;
            if (!nt_web_video_upload(
                    m_session->browser_id,
                    static_cast<int>(m_session->native_textures[m_session->output]),
                    m_browser_error.data(), m_browser_error.size())) {
                m_diagnostics = error("gpu_upload_failed", m_browser_error.data());
                return;
            }
            m_session->last_time = sample.time_ms;
            m_session->uploaded_epoch = epoch;
            ++m_session->uploads;
        }
        m_ready = true;
    }
    jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        if (context.cancellation_requested())
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        if (!m_diagnostics.empty())
            return {.status = jobs::JobStepStatus::Failed, .diagnostics = m_diagnostics};
        const auto& sample = *m_request.video_sample;
        if (!sample.width || !sample.height || sample.width > 8192 || sample.height > 8192 ||
            !std::isfinite(sample.time_ms) || sample.time_ms < 0 || !m_source_bytes ||
            m_source_bytes > 128u * 1024u * 1024u || m_request.retain_alpha_coverage)
            return fail("unsupported_source",
                        "No admitted opaque browser video representation is available.");
        if (!m_claimed) {
            bool idle = false;
            if (!m_session->busy.compare_exchange_strong(idle, true, std::memory_order_acq_rel))
                return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
            m_claimed = true;
        }
        if (m_read && !m_read->ready()) {
            auto result = m_read->step(context);
            if (result.status == jobs::JobStepStatus::Failed)
                return result;
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        }
        if (m_read) {
            m_session->source->bytes = m_read->take_bytes();
            m_read.reset();
        }
        if (!m_started) {
            if (!m_session->browser_id) {
                const auto& bytes = m_session->source->bytes;
                m_session->browser_id =
                    nt_web_video_create(bytes.data(), bytes.size(), sample.width, sample.height);
            }
            if (!m_session->browser_id ||
                !nt_web_video_sample(m_session->browser_id, sample.time_ms, &m_browser_state,
                                     m_browser_error.data(), m_browser_error.size()))
                return fail("sample_failed", "Browser media preparation could not start.");
            m_started = true;
        }
        const int state = m_browser_state.load(std::memory_order_acquire);
        if (state < 0)
            return fail("sample_failed", m_browser_error.data());
        if (!state)
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        if (render_epoch.load(std::memory_order_acquire) == m_session->uploaded_epoch)
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }
    core::Result<Prepared, core::Diagnostics> finalize_on_owner() noexcept override
    {
        upload_on_owner();
        if (!m_diagnostics.empty()) {
            // Partial external-GL allocation must be retired here, never by a later worker-side
            // canceled-task destructor which does not own the renderer context.
            if (!m_session->admitted)
                m_session->retire_on_owner();
            return core::Result<Prepared, core::Diagnostics>::failure(std::move(m_diagnostics));
        }
        if (!m_ready)
            return core::Result<Prepared, core::Diagnostics>::failure(
                error("not_ready", "Browser sample is not ready."));
        auto cost = estimated_cost_on_owner();
        cost.temporary_bytes = 0;
        if (m_session->seed) {
            nt_web_video_dispose(m_session->browser_id);
            m_session->browser_id = 0;
            cost.source_bytes = m_source_bytes;
        }
        m_session->admitted = true;
        auto allocation = m_first ? m_session : std::shared_ptr<Session>{};
        return core::Result<Prepared, core::Diagnostics>::success(
            {.asset = {.handle = m_session->textures[m_session->output].idx,
                       .path = m_request.path,
                       .width = m_request.video_sample->width,
                       .height = m_request.video_sample->height,
                       .sampler = MaterialTextureSampler::ClampLinear,
                       .mip_count = 1,
                       .alpha_coverage = std::nullopt,
                       .video_source = m_session->source,
                       .video_session = m_session,
                       .video_residency_pin = m_pin},
             .cost = cost,
             .destroy_on_owner = [allocation = std::move(allocation)](Texture& asset) {
                 if (allocation)
                     allocation->retire_on_owner();
                 asset.video_source.reset();
                 asset.video_session.reset();
                 asset.video_residency_pin.reset();
                 asset.handle = assets::invalid_typed_asset_handle;
             }});
    }

private:
    jobs::JobStepOutcome fail(std::string code, std::string message)
    {
        return {.status = jobs::JobStepStatus::Failed,
                .diagnostics = error(std::move(code), std::move(message))};
    }
    std::shared_ptr<Session> m_session;
    Request m_request;
    bool m_first;
    std::shared_ptr<assets::VideoTextureResidencyPin> m_pin;
    std::uint64_t m_source_bytes;
    std::unique_ptr<assets::detail::IncrementalAssetRead> m_read;
    std::atomic<int> m_browser_state{0};
    std::array<char, 512> m_browser_error{};
    core::Diagnostics m_diagnostics;
    bool m_claimed = false;
    bool m_started = false;
    bool m_ready = false;
    static_assert(sizeof(std::atomic<int>) == 4 && std::atomic<int>::is_always_lock_free);
};

std::unique_ptr<Task> Session::create_texture_preparation_task(Request request)
{
    if (seed)
        return nullptr;
    return std::make_unique<SampleTask>(shared_from_this(), std::move(request));
}
} // namespace
#endif

std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
make_web_video_texture_task(const assets::AssetManager& assets, assets::TextureAssetRequest request)
{
#ifdef __EMSCRIPTEN__
    auto session = register_session(std::make_shared<Session>(std::make_shared<Source>(), true));
    return std::make_unique<SampleTask>(std::move(session), std::move(request), &assets);
#else
    return nullptr;
#endif
}

void advance_web_video_render_epoch() noexcept
{
#ifdef __EMSCRIPTEN__
    const auto epoch = render_epoch.fetch_add(1, std::memory_order_release) + 1;
    std::erase_if(retired_textures, [epoch](const auto& retired) {
        if (epoch - retired.epoch < 2)
            return false;
        glDeleteTextures(1, &retired.texture);
        return true;
    });
#endif
}

void drain_web_video_textures_on_owner() noexcept
{
#ifdef __EMSCRIPTEN__
    // Asset leases may outlive the renderer. Invalidate their sessions while bgfx and the
    // WebGL context are still valid, then flush bgfx's deferred destroy commands.
    for (auto& weak : live_sessions)
        if (auto session = weak.lock())
            session->retire_on_owner();
    live_sessions.clear();
    for (int i = 0; i < 2 && !retired_textures.empty(); ++i) {
        bgfx::frame();
        advance_web_video_render_epoch();
    }
#endif
}
} // namespace noveltea::bgfx_backend
