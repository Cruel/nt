#include "render/bgfx/native_video_texture.hpp"

#ifndef __EMSCRIPTEN__
#include "assets/asset_preparation_io.hpp"
#include "media/native_video_decoder.hpp"
#include "noveltea/assets/asset_cache_keys.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"

#include <bgfx/bgfx.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <cmath>
#include <cstdio>
#include <limits>
#include <map>
#include <mutex>
#include <utility>

namespace noveltea::bgfx_backend {
namespace {
using Texture = assets::TextureAsset;
using Request = assets::TextureAssetRequest;
using Task = assets::AssetPreparationTask<Texture>;
using Prepared = assets::PreparedAsset<Texture>;

std::uint16_t next_upload_view = 0;
std::atomic<std::uint64_t> next_session{1};
std::atomic<std::uint64_t> next_sample_task{1};
std::atomic<std::uint64_t> render_epoch{0};

core::Diagnostics error(std::string code, std::string message)
{
    return {{.code = "assets.native_video." + code, .message = std::move(message)}};
}

struct SourceState {
    ~SourceState()
    {
        if (bgfx::isValid(program))
            bgfx::destroy(program);
        for (auto sampler : samplers)
            if (bgfx::isValid(sampler))
                bgfx::destroy(sampler);
        if (bgfx::isValid(color))
            bgfx::destroy(color);
    }
    std::atomic<int> status{0};
    bool producer_claimed = false;
    core::Diagnostics diagnostics;
    std::shared_ptr<const media::NativeVideoSource> source;
    bgfx::ProgramHandle program = BGFX_INVALID_HANDLE;
    std::array<bgfx::UniformHandle, 3> samplers{
        {BGFX_INVALID_HANDLE, BGFX_INVALID_HANDLE, BGFX_INVALID_HANDLE}};
    bgfx::UniformHandle color = BGFX_INVALID_HANDLE;
};

struct Surfaces {
    ~Surfaces()
    {
        for (auto buffer : output)
            if (bgfx::isValid(buffer))
                bgfx::destroy(buffer);
        for (auto plane : planes)
            if (bgfx::isValid(plane))
                bgfx::destroy(plane);
    }
    std::array<bgfx::FrameBufferHandle, 2> output{{BGFX_INVALID_HANDLE, BGFX_INVALID_HANDLE}};
    std::array<bgfx::TextureHandle, 3> planes{
        {BGFX_INVALID_HANDLE, BGFX_INVALID_HANDLE, BGFX_INVALID_HANDLE}};
    unsigned next = 0;
    std::uint64_t last_time = std::numeric_limits<std::uint64_t>::max();
};

class Session;
class SurfacePin final : public assets::VideoTextureResidencyPin {
public:
    explicit SurfacePin(assets::AssetLease<Texture> lease) : lease(std::move(lease)) {}
    assets::AssetLease<Texture> lease;
};

class SourceFactory final : public assets::VideoTextureSource,
                            public std::enable_shared_from_this<SourceFactory> {
public:
    SourceFactory(std::shared_ptr<SourceState> state, assets::AssetLease<Texture> pin = {})
        : state(std::move(state)), pin(std::move(pin))
    {
    }
    std::shared_ptr<assets::VideoTextureSession> create_session() override;
    std::shared_ptr<SourceState> state;
    assets::AssetLease<Texture> pin;
};

class Session final : public assets::VideoTextureSession,
                      public std::enable_shared_from_this<Session> {
public:
    explicit Session(std::shared_ptr<SourceFactory> factory, bool seed_only = false)
        : factory(std::move(factory)), id(next_session.fetch_add(1, std::memory_order_relaxed)),
          seed_only(seed_only)
    {
    }
    std::uint64_t identity() const noexcept override { return id; }
    const char* backend() const noexcept override
    {
        return selected_backend.load(std::memory_order_acquire);
    }
    std::uint64_t uploads_on_owner() const noexcept override { return uploads; }
    std::unique_ptr<Task> create_texture_preparation_task(Request request) override;
    std::shared_ptr<assets::VideoTextureResidencyPin>
    retain_residency(const assets::AssetLease<Texture>& lease) override
    {
        auto pin = std::make_shared<SurfacePin>(lease);
        residency_pin = pin;
        return pin;
    }
    void retire_allocation()
    {
        std::lock_guard lock(decoder_mutex);
        decoder.reset();
        surfaces.reset();
        admitted = false;
        uploaded_epoch.store(std::numeric_limits<std::uint64_t>::max(), std::memory_order_release);
    }
    std::shared_ptr<SourceFactory> factory;
    std::unique_ptr<media::NativeVideoDecoder> decoder;
    std::shared_ptr<Surfaces> surfaces;
    std::weak_ptr<assets::VideoTextureResidencyPin> residency_pin;
    std::mutex decoder_mutex;
    std::atomic<std::uint64_t> active_task{0};
    std::atomic<std::uint64_t> uploaded_epoch{std::numeric_limits<std::uint64_t>::max()};
    std::uint64_t id;
    std::atomic<const char*> selected_backend{"pending"};
    bool admitted = false;
    const bool seed_only;
    std::uint64_t uploads = 0;
};

std::shared_ptr<assets::VideoTextureSession> SourceFactory::create_session()
{
    return std::make_shared<Session>(shared_from_this());
}

core::Result<Texture, core::Diagnostics> upload(Session& session, const Request& request,
                                                const media::NativeVideoFrame& frame)
{
    const auto& source = *session.factory->state;
    constexpr auto flags = BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP | BGFX_SAMPLER_MIN_POINT |
                           BGFX_SAMPLER_MAG_POINT | BGFX_SAMPLER_MIP_POINT;
    if (frame.width > bgfx::getCaps()->limits.maxTextureSize ||
        frame.height > bgfx::getCaps()->limits.maxTextureSize)
        return core::Result<Texture, core::Diagnostics>::failure(
            error("unsupported_gpu", "Video extent exceeds the renderer texture limit."));
    if (session.surfaces && session.surfaces->last_time == frame.time_ns) {
        const auto& surfaces = *session.surfaces;
        const auto index = session.seed_only ? 0u : 1u - surfaces.next;
        return core::Result<Texture, core::Diagnostics>::success(
            {.handle = bgfx::getTexture(surfaces.output[index]).idx,
             .path = request.path,
             .width = frame.width,
             .height = frame.height,
             .sampler = request.sampler,
             .alpha_coverage = std::nullopt,
             .video_source = session.factory,
             .video_session = session.shared_from_this()});
    }
    if (next_upload_view >= 256)
        return core::Result<Texture, core::Diagnostics>::failure(
            error("upload_capacity", "Per-frame media conversion view resources are exhausted."));
    if (!session.surfaces) {
        auto surfaces = std::make_shared<Surfaces>();
        const auto width = frame.width;
        const auto height = frame.height;
        for (std::size_t index = 0; index < 3; ++index) {
            if (!bgfx::isTextureValid(0, false, 1, bgfx::TextureFormat::R8, flags))
                return core::Result<Texture, core::Diagnostics>::failure(error(
                    "unsupported_gpu", "Renderer does not support video YUV plane textures."));
            surfaces->planes[index] = bgfx::createTexture2D(
                index ? (width + 1) / 2 : width, index ? (height + 1) / 2 : height, false, 1,
                bgfx::TextureFormat::R8, flags);
            if (!bgfx::isValid(surfaces->planes[index]))
                return core::Result<Texture, core::Diagnostics>::failure(
                    error("gpu_allocation_failed", "Could not allocate a video YUV plane."));
        }
        for (std::size_t index = 0; index < (session.seed_only ? 1u : 2u); ++index) {
            auto& output = surfaces->output[index];
            output = bgfx::createFrameBuffer(width, height, bgfx::TextureFormat::RGBA8,
                                             BGFX_TEXTURE_RT | BGFX_SAMPLER_U_CLAMP |
                                                 BGFX_SAMPLER_V_CLAMP);
            if (!bgfx::isValid(output))
                return core::Result<Texture, core::Diagnostics>::failure(
                    error("gpu_allocation_failed", "Could not allocate a video RGBA surface."));
        }
        session.surfaces = std::move(surfaces);
    }
    auto& surfaces = *session.surfaces;
    // Texture updates precede all draw views; repeated session updates in one bgfx frame would
    // overwrite an earlier conversion's input. WorldVideoStream admits only one pending sample.
    const std::array<const std::vector<std::uint8_t>*, 3> planes{&frame.y, &frame.u, &frame.v};
    for (std::size_t index = 0; index < 3; ++index) {
        const auto width = index ? (frame.width + 1) / 2 : frame.width;
        const auto height = index ? (frame.height + 1) / 2 : frame.height;
        bgfx::updateTexture2D(
            surfaces.planes[index], 0, 0, 0, 0, width, height,
            bgfx::copy(planes[index]->data(), static_cast<std::uint32_t>(planes[index]->size())));
    }
    struct Vertex {
        float x, y;
        float u, v;
    };
    bgfx::VertexLayout layout;
    layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .end();
    bgfx::TransientVertexBuffer vertices;
    bgfx::TransientIndexBuffer indices;
    if (!bgfx::allocTransientBuffers(&vertices, layout, 4, &indices, 6))
        return core::Result<Texture, core::Diagnostics>::failure(
            error("upload_capacity", "Video conversion transient geometry is unavailable."));
    const auto top = bgfx::getCaps()->originBottomLeft ? -1.0f : 1.0f;
    const std::array<Vertex, 4> quad{
        {{-1, top, 0, 0}, {1, top, 1, 0}, {1, -top, 1, 1}, {-1, -top, 0, 1}}};
    const std::array<std::uint16_t, 6> triangles{0, 1, 2, 0, 2, 3};
    std::memcpy(vertices.data, quad.data(), sizeof(quad));
    std::memcpy(indices.data, triangles.data(), sizeof(triangles));
    const auto view = next_upload_view++;
    const auto output = surfaces.output[surfaces.next];
    surfaces.next = (surfaces.next + 1) % (session.seed_only ? 1u : 2u);
    bgfx::setViewName(view, "Native video YUV conversion");
    bgfx::setViewRect(view, 0, 0, frame.width, frame.height);
    bgfx::setViewFrameBuffer(view, output);
    bgfx::setViewClear(view, BGFX_CLEAR_NONE);
    bgfx::setViewTransform(view, nullptr, nullptr);
    for (std::size_t index = 0; index < 3; ++index)
        bgfx::setTexture(static_cast<std::uint8_t>(index), source.samplers[index],
                         surfaces.planes[index]);
    const std::array<float, 4> color{frame.full_range ? 1.0f : 0.0f, frame.bt709 ? 1.0f : 0.0f, 0,
                                     0};
    bgfx::setUniform(source.color, color.data());
    bgfx::setVertexBuffer(0, &vertices);
    bgfx::setIndexBuffer(&indices);
    bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
    bgfx::submit(view, source.program);
    surfaces.last_time = frame.time_ns;
    ++session.uploads;
    session.uploaded_epoch.store(render_epoch.load(std::memory_order_relaxed),
                                 std::memory_order_release);
    return core::Result<Texture, core::Diagnostics>::success(
        {.handle = bgfx::getTexture(output).idx,
         .path = request.path,
         .width = frame.width,
         .height = frame.height,
         .sampler = MaterialTextureSampler::ClampLinear,
         .mip_count = 1,
         .alpha_coverage = std::nullopt,
         .video_source = session.factory,
         .video_session = session.shared_from_this()});
}

class SampleTask final : public Task {
public:
    SampleTask(std::shared_ptr<Session> session, Request request,
               const assets::AssetManager* source_owner = nullptr,
               std::optional<Request> source_descriptor = std::nullopt)
        : m_session(std::move(session)), m_request(std::move(request)),
          m_source_owner(source_owner), m_source_descriptor(std::move(source_descriptor)),
          m_first(!m_session->admitted), m_pin(m_session->residency_pin.lock()),
          m_ticket(next_sample_task.fetch_add(1, std::memory_order_relaxed)),
          m_source_pinned(source_owner == nullptr)
    {
    }
    ~SampleTask() override
    {
        if (m_claimed && !m_session->admitted &&
            m_session->active_task.load(std::memory_order_acquire) == m_ticket)
            m_session->retire_allocation();
        auto ticket = m_ticket;
        m_session->active_task.compare_exchange_strong(ticket, 0, std::memory_order_release);
    }
    void refresh_dependencies_on_owner(
        assets::AssetRequestReason reason,
        std::optional<assets::PrefetchGenerationId> generation) noexcept override
    {
        if (!m_source_owner)
            return;
        const bool ready = m_session->factory->state->status.load(std::memory_order_acquire) == 1;
        if (ready || reason != assets::AssetRequestReason::Prefetch) {
            if (ready && reason == assets::AssetRequestReason::Prefetch && m_source_prefetch &&
                !m_source_prefetch.replace_generation_on_owner(m_source_prefetch.generation())) {
                m_dependency_failed.store(true, std::memory_order_release);
                return;
            }
            if (!m_source_request || m_source_reason != reason) {
                auto source = m_source_owner->request_texture(
                    *m_source_descriptor, reason == assets::AssetRequestReason::Prefetch
                                              ? assets::AssetRequestReason::Demand
                                              : reason);
                if (!source) {
                    m_dependency_failed.store(true, std::memory_order_release);
                    return;
                }
                m_source_request = std::move(source).value();
                m_source_prefetch.reset();
            }
            m_source_pinned.store(ready &&
                                      m_source_request.state() == assets::AssetRequestState::Ready,
                                  std::memory_order_release);
        } else if (!m_source_prefetch || m_source_generation != generation) {
            if (!generation) {
                m_dependency_failed.store(true, std::memory_order_release);
                return;
            }
            auto source = m_source_owner->prefetch_texture(*m_source_descriptor, *generation);
            if (!source) {
                m_dependency_failed.store(true, std::memory_order_release);
                return;
            }
            m_source_prefetch = std::move(source).value();
            m_source_request.reset();
        }
        m_source_reason = reason;
        m_source_generation = generation;
    }
    bool reservation_update_required_on_owner() const noexcept override
    {
        return m_waiting_pin.load(std::memory_order_acquire);
    }
    void reservation_update_granted_on_owner() noexcept override
    {
        refresh_dependencies_on_owner(m_source_reason, m_source_generation);
        m_waiting_pin.store(false, std::memory_order_release);
    }
    assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        const auto& sample = *m_request.video_sample;
        const auto pixels = static_cast<std::uint64_t>(sample.width) * sample.height;
        auto temporary =
            pixels * 4 +
            (m_first ? media::NativeVideoDecoder::memory_budget(sample.width, sample.height) : 0);
        if (m_source_owner &&
            m_session->factory->state->status.load(std::memory_order_acquire) != 1)
            temporary = std::max(
                temporary, assets::detail::estimated_source_size(
                               *m_source_owner, m_source_descriptor->video_sample->media_path) +
                               33u * 1024u * 1024u);
        return {.prepared_cpu_bytes =
                    m_first && !m_session->seed_only
                        ? media::NativeVideoDecoder::memory_budget(sample.width, sample.height)
                        : 0,
                .gpu_bytes = m_first ? pixels * 42 : 0,
                .temporary_bytes = temporary};
    }
    jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        if (context.cancellation_requested())
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        if (m_dependency_failed.load(std::memory_order_acquire))
            return {.status = jobs::JobStepStatus::Failed,
                    .diagnostics = error("source_dependency_failed",
                                         "Native media dependency could not be admitted.")};
        const auto status = m_session->factory->state->status.load(std::memory_order_acquire);
        if (status < 0)
            return {.status = jobs::JobStepStatus::Failed,
                    .diagnostics = m_session->factory->state->diagnostics};
        if (status == 0)
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        if (!m_source_pinned.load(std::memory_order_acquire)) {
            m_waiting_pin.store(true, std::memory_order_release);
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        }
        auto active = m_session->active_task.load(std::memory_order_acquire);
        if (active != m_ticket) {
            if (active != 0 ||
                m_session->uploaded_epoch.load(std::memory_order_acquire) ==
                    render_epoch.load(std::memory_order_acquire) ||
                !m_session->active_task.compare_exchange_strong(active, m_ticket,
                                                                std::memory_order_acq_rel))
                return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
            m_claimed = true;
        }
        std::unique_lock lock(m_session->decoder_mutex, std::try_to_lock);
        if (!lock.owns_lock())
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        if (!m_session->decoder)
            m_session->decoder =
                std::make_unique<media::NativeVideoDecoder>(m_session->factory->state->source);
        auto frame = m_session->decoder->step(m_request.video_sample->time_ms);
        m_session->selected_backend.store(m_session->decoder->backend(), std::memory_order_release);
        if (!frame)
            return {.status = jobs::JobStepStatus::Failed, .diagnostics = std::move(frame).error()};
        if (!frame.value())
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        m_frame = std::move(frame).value();
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }
    core::Result<Prepared, core::Diagnostics> finalize_on_owner() noexcept override
    {
        if (m_source_request) {
            auto pin = std::move(m_source_request).take_ready();
            if (!pin)
                return core::Result<Prepared, core::Diagnostics>::failure(
                    error("source_not_ready", "Video source lease is not ready."));
            m_session->factory =
                std::make_shared<SourceFactory>(m_session->factory->state, std::move(*pin));
        }
        if (!m_frame)
            return core::Result<Prepared, core::Diagnostics>::failure(
                error("sample_not_ready", "Video sample has not decoded."));
        if (m_session->seed_only) {
            std::lock_guard lock(m_session->decoder_mutex);
            m_session->decoder.reset();
        }
        auto texture = upload(*m_session, m_request, *m_frame);
        if (!texture)
            return core::Result<Prepared, core::Diagnostics>::failure(std::move(texture).error());
        auto cost = estimated_cost_on_owner();
        cost.temporary_bytes = 0;
        if (m_first && !m_session->seed_only)
            cost.prepared_cpu_bytes = m_session->decoder->resident_budget();
        const auto pixels = static_cast<std::uint64_t>(m_frame->width) * m_frame->height;
        const auto chroma =
            static_cast<std::uint64_t>((m_frame->width + 1) / 2) * ((m_frame->height + 1) / 2);
        const auto hardware = std::strcmp(m_session->backend(), "libvpx-vp9") != 0;
        cost.gpu_bytes =
            m_first ? pixels * (m_session->seed_only ? 5 : (hardware ? 39 : 9)) + chroma * 2 : 0;
        if (m_first)
            std::fprintf(stderr, "[video] backend=%s occurrence=%llu\n", m_session->backend(),
                         static_cast<unsigned long long>(m_session->identity()));
        m_session->admitted = true;
        texture.value().video_residency_pin = m_pin;
        auto allocation = m_first ? m_session : std::shared_ptr<Session>{};
        return core::Result<Prepared, core::Diagnostics>::success(
            {.asset = std::move(texture).value(),
             .cost = cost,
             .destroy_on_owner = [allocation = std::move(allocation)](Texture& asset) {
                 if (allocation)
                     allocation->retire_allocation();
                 asset.video_source.reset();
                 asset.video_session.reset();
                 asset.video_residency_pin.reset();
                 asset.handle = assets::invalid_typed_asset_handle;
             }});
    }

private:
    std::shared_ptr<Session> m_session;
    Request m_request;
    const assets::AssetManager* m_source_owner;
    std::optional<Request> m_source_descriptor;
    assets::AssetRequestHandle<Texture> m_source_request;
    assets::PrefetchTicket m_source_prefetch;
    assets::AssetRequestReason m_source_reason = assets::AssetRequestReason::Prefetch;
    std::optional<assets::PrefetchGenerationId> m_source_generation;
    bool m_first;
    std::shared_ptr<assets::VideoTextureResidencyPin> m_pin;
    std::shared_ptr<const media::NativeVideoFrame> m_frame;
    std::uint64_t m_ticket;
    bool m_claimed = false;
    std::atomic<bool> m_source_pinned;
    std::atomic<bool> m_waiting_pin{false};
    std::atomic<bool> m_dependency_failed{false};
};

std::unique_ptr<Task> Session::create_texture_preparation_task(Request request)
{
    if (seed_only)
        return nullptr;
    return std::make_unique<SampleTask>(shared_from_this(), std::move(request));
}

class SourceTask final : public Task {
public:
    SourceTask(const assets::AssetManager& assets, Request request,
               std::shared_ptr<SourceState> state)
        : m_request(std::move(request)), m_state(std::move(state)),
          m_read(assets, m_request.video_sample->media_path, "assets.native_video"),
          m_vertex(assets, shader_path("vs"), "assets.native_video.shader"),
          m_fragment(assets, shader_path("fs"), "assets.native_video.shader"),
          m_source_bytes(
              assets::detail::estimated_source_size(assets, m_request.video_sample->media_path)),
          m_producer(!m_state->producer_claimed)
    {
        if (m_producer)
            m_state->producer_claimed = true;
    }
    ~SourceTask() override
    {
        if (m_producer && m_state->status.load(std::memory_order_relaxed) == 0) {
            m_state->diagnostics = error(
                "source_canceled", "Prepared video source preparation was canceled or rejected.");
            m_state->status.store(-1, std::memory_order_release);
        }
    }
    assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return {.source_bytes = m_source_bytes,
                .prepared_cpu_bytes = 32u * 1024u * 1024u,
                .temporary_bytes = m_source_bytes + 32u * 1024u * 1024u + 1024u * 1024u};
    }
    assets::AssetCacheState cache_state_for_next_step() const noexcept override
    {
        return m_read.ready() && m_vertex.ready() && m_fragment.ready()
                   ? assets::AssetCacheState::Preparing
                   : assets::AssetCacheState::Reading;
    }
    jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        if (context.cancellation_requested())
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        const auto& sample = *m_request.video_sample;
        if (!m_source_bytes || m_source_bytes > 128u * 1024u * 1024u || !sample.width ||
            !sample.height || sample.width > 8192 || sample.height > 8192 ||
            m_request.retain_alpha_coverage)
            return fail(error("unsupported_source",
                              "No admitted opaque native VP9 WebM representation is available."));
        for (auto* read : {&m_read, &m_vertex, &m_fragment}) {
            if (read->ready())
                continue;
            auto result = read->step(context);
            if (result.status == jobs::JobStepStatus::Failed)
                return fail(std::move(result.diagnostics));
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        }
        auto source =
            media::NativeVideoSource::open(m_read.take_bytes(), sample.width, sample.height);
        if (!source)
            return fail(std::move(source).error());
        m_state->source = std::move(source).value();
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }
    core::Result<Prepared, core::Diagnostics> finalize_on_owner() noexcept override
    {
        const auto create_shader = [](const assets::AssetBytes& bytes) {
            return bytes.empty() ? bgfx::ShaderHandle{bgfx::kInvalidHandle}
                                 : bgfx::createShader(bgfx::copy(
                                       bytes.data(), static_cast<std::uint32_t>(bytes.size())));
        };
        auto vertex = create_shader(m_vertex.bytes());
        auto fragment = create_shader(m_fragment.bytes());
        if (!bgfx::isValid(vertex) || !bgfx::isValid(fragment)) {
            if (bgfx::isValid(vertex))
                bgfx::destroy(vertex);
            if (bgfx::isValid(fragment))
                bgfx::destroy(fragment);
            auto diagnostics = error("shader_failed", "Could not create video conversion shaders.");
            fail(diagnostics);
            return core::Result<Prepared, core::Diagnostics>::failure(std::move(diagnostics));
        }
        m_state->program = bgfx::createProgram(vertex, fragment, true);
        const std::array<const char*, 3> names{"s_videoY", "s_videoU", "s_videoV"};
        for (std::size_t index = 0; index < names.size(); ++index)
            m_state->samplers[index] =
                bgfx::createUniform(names[index], bgfx::UniformType::Sampler);
        m_state->color = bgfx::createUniform("u_videoColor", bgfx::UniformType::Vec4);
        if (!bgfx::isValid(m_state->program) || !bgfx::isValid(m_state->color) ||
            !std::ranges::all_of(m_state->samplers,
                                 [](auto handle) { return bgfx::isValid(handle); })) {
            auto diagnostics =
                error("shader_failed", "Could not initialize video conversion resources.");
            fail(diagnostics);
            return core::Result<Prepared, core::Diagnostics>::failure(std::move(diagnostics));
        }
        m_state->status.store(1, std::memory_order_release);
        const auto bytes = m_state->source->resident_bytes();
        return core::Result<Prepared, core::Diagnostics>::success(
            {.asset = {.path = m_request.path,
                       .alpha_coverage = std::nullopt,
                       .video_source = std::make_shared<SourceFactory>(m_state)},
             .cost = {.source_bytes = m_source_bytes,
                      .prepared_cpu_bytes = bytes - m_source_bytes + m_vertex.bytes().size() +
                                            m_fragment.bytes().size()},
             .destroy_on_owner = [](Texture& asset) { asset.video_source.reset(); }});
    }

private:
    std::string shader_path(const char* stage) const
    {
        return "system:/shaders/bgfx/" +
               std::string(shader_variant_for_renderer(bgfx::getRendererType())) + "/video_yuv." +
               stage + ".bin";
    }
    jobs::JobStepOutcome fail(core::Diagnostics diagnostics)
    {
        m_state->diagnostics = diagnostics;
        m_state->status.store(-1, std::memory_order_release);
        return {.status = jobs::JobStepStatus::Failed, .diagnostics = std::move(diagnostics)};
    }
    Request m_request;
    std::shared_ptr<SourceState> m_state;
    assets::detail::IncrementalAssetRead m_read;
    assets::detail::IncrementalAssetRead m_vertex;
    assets::detail::IncrementalAssetRead m_fragment;
    std::uint64_t m_source_bytes;
    bool m_producer;
};

} // namespace

struct NativeVideoTextureLoader::Impl {
    explicit Impl(const assets::AssetManager& assets) : assets(assets) {}
    const assets::AssetManager& assets;
    std::map<assets::AssetCacheKey, std::weak_ptr<SourceState>> sources;
};

NativeVideoTextureLoader::NativeVideoTextureLoader(const assets::AssetManager& assets)
    : m_impl(std::make_unique<Impl>(assets))
{
}
NativeVideoTextureLoader::~NativeVideoTextureLoader() = default;

std::unique_ptr<Task> NativeVideoTextureLoader::create_task(Request request)
{
    auto source_request = request;
    source_request.path = request.video_sample->media_path;
    source_request.video_sample->time_ms = -1;
    source_request.video_session.reset();
    const auto key =
        assets::make_texture_cache_key(source_request, m_impl->assets.source_generation_on_owner());
    std::erase_if(m_impl->sources, [](const auto& entry) { return entry.second.expired(); });
    auto state = m_impl->sources[key].lock();
    if (!state) {
        state = std::make_shared<SourceState>();
        m_impl->sources[key] = state;
    }
    if (request.video_sample->time_ms == -1)
        return std::make_unique<SourceTask>(m_impl->assets, std::move(request), std::move(state));
    auto session =
        std::make_shared<Session>(std::make_shared<SourceFactory>(std::move(state)), true);
    return std::make_unique<SampleTask>(std::move(session), std::move(request), &m_impl->assets,
                                        std::move(source_request));
}

void reset_native_video_upload_views() noexcept
{
    next_upload_view = 0;
    render_epoch.fetch_add(1, std::memory_order_release);
}

} // namespace noveltea::bgfx_backend
#else
namespace noveltea::bgfx_backend {
struct NativeVideoTextureLoader::Impl {};
NativeVideoTextureLoader::NativeVideoTextureLoader(const assets::AssetManager&)
    : m_impl(std::make_unique<Impl>())
{
}
NativeVideoTextureLoader::~NativeVideoTextureLoader() = default;
std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
NativeVideoTextureLoader::create_task(assets::TextureAssetRequest)
{
    return nullptr;
}
void reset_native_video_upload_views() noexcept {}
} // namespace noveltea::bgfx_backend
#endif
