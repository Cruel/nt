#include "video_workloads.hpp"

#include "benchmark_android_lifecycle.hpp"
#include "benchmark_assets.hpp"
#include "benchmark_bgfx_diagnostics.hpp"
#include "benchmark_window_size.hpp"
#include "media/native_video_decoder.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/assets/prepared_video_texture.hpp"

#include <SDL3/SDL.h>

#include <chrono>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace noveltea::benchmark {
namespace {

constexpr std::uint64_t kClipDurationMs = 200;
constexpr std::uint16_t kClipWidth = 32;
constexpr std::uint16_t kClipHeight = 16;

template<class Id> Id identifier(const char* name) { return Id::create(name).value(); }

core::PreparedVideoMotion prepared_clip()
{
    return {identifier<core::AnimationId>("benchmark-video"),
            identifier<core::AnimationMotionId>("loop"),
            std::string(64, 'b'),
            {{"unused-frame-0.png", 50},
             {"unused-frame-1.png", 50},
             {"unused-frame-2.png", 50},
             {"unused-frame-3.png", 50}},
            core::PreparedBrowserVideo{"opaque-vp9.webm", kClipWidth, kClipHeight}};
}

std::string diagnostics_text(const core::Diagnostics& diagnostics)
{
    std::string message;
    for (const auto& diagnostic : diagnostics) {
        if (!message.empty())
            message += "; ";
        message += diagnostic.code + ": " + diagnostic.message;
    }
    return message;
}

} // namespace

VideoScenario::~VideoScenario()
{
    std::string reason;
    (void)cleanup(reason);
}

const char* VideoScenario::description() const
{
    if (id_ == "video-decode")
        return "real VP9 packet decode in the production native decoder, no GPU work";
#if defined(__EMSCRIPTEN__)
    if (id_ == "video-upload")
        return "production browser-media VP9 decode and imported WebGL texture upload; no quad";
    return "production browser-media VP9 texture upload, draw, and world composition";
#else
    if (id_ == "video-upload")
        return "real prepared VP9 stream decode and production bgfx YUV upload/conversion; no quad";
    return "real prepared VP9 stream decode, texture upload, and production quad/composite";
#endif
}

void VideoScenario::service_requests()
{
    if (!executor_)
        return;
    for (unsigned step = 0; step < 64; ++step) {
        (void)executor_->dispatch_owner_completions(64);
        if (!executor_->advance_one_step())
            break;
    }
    (void)executor_->dispatch_owner_completions(64);
}

bool VideoScenario::prepare(const Options& options, std::string& reason)
{
    if (!cleanup(reason))
        return false;
    environment_ = {};
    environment_.platform = SDL_GetPlatform();
#if defined(__EMSCRIPTEN__)
    environment_.frame_path = id_ == "video-decode"   ? "unsupported-browser-decoder-only"
                              : id_ == "video-upload" ? "browser-media-upload-no-quad"
                                                      : "browser-media-production-presentation";
#else
    environment_.frame_path = id_ == "video-decode"   ? "native-vp9-decoder-no-presentation"
                              : id_ == "video-upload" ? "native-video-upload-conversion-no-quad"
                                                      : "native-video-production-presentation";
#endif
    interruption_ = Interruption::None;
    diagnostic_ = options.profile == "diagnostic";

#if defined(__EMSCRIPTEN__)
    if (id_ == "video-decode") {
        reason = "Browser video decodes directly into WebGL: no CPU-decoded packet interface "
                 "for the video-decode benchmark; select video-upload or video-present";
        return false;
    }
#else
    if (id_ == "video-decode") {
        const auto path = benchmark_asset_path("media/opaque-vp9.webm").string();
        std::size_t size = 0;
        void* data = SDL_LoadFile(path.c_str(), &size);
        if (!data || size == 0) {
            SDL_free(data);
            reason = "missing staged VP9 benchmark media: " + path;
            return false;
        }
        auto* begin = static_cast<const std::uint8_t*>(data);
        std::vector<std::uint8_t> bytes(begin, begin + size);
        SDL_free(data);
        auto parsed = media::NativeVideoSource::open(std::move(bytes), kClipWidth, kClipHeight);
        if (!parsed) {
            reason = diagnostics_text(parsed.error());
            return false;
        }
        source_ = std::move(parsed).value();
        decoder_ = std::make_unique<media::NativeVideoDecoder>(source_);
        auto first = decoder_->step(25.0);
        if (!first) {
            reason = diagnostics_text(first.error());
            return false;
        }
        if (!first.value())
            for (unsigned step = 0; step < 8 && !first.value(); ++step) {
                first = decoder_->step(25.0);
                if (!first) {
                    reason = diagnostics_text(first.error());
                    return false;
                }
            }
        if (!first.value()) {
            reason = "native video decoder did not produce its first frame";
            return false;
        }
        environment_.video_codec_backend = decoder_->backend();
        environment_.video_codec_fallback = decoder_->fallback_reason();
        ready_ = true;
        packet_index_ = 1;
        return true;
    }
#endif

    PlatformConfig config{.title = "NovelTea Video Benchmark",
                          .width = options.width,
                          .height = options.height,
                          .resizable = false,
                          .vsync = options.vsync};
    if (!requested_benchmark_window_size(options, nullptr, config.width, config.height, reason))
        return false;
    if (!platform_.initialize(config)) {
        reason = "video Platform initialization failed";
        return false;
    }
#if defined(__ANDROID__)
    while (!android_benchmark_foreground())
        SDL_Delay(100);
    assets_.mount("project", std::make_shared<assets::SdlPackagedAssetSource>("media"));
    assets_.mount("system", std::make_shared<assets::SdlPackagedAssetSource>("system"));
#else
    assets_.mount_directory("project", benchmark_asset_path("media"));
    assets_.mount_directory("system", benchmark_asset_path("system"));
#endif
    executor_ = std::make_unique<jobs::InlineJobExecutor>();
    constexpr std::uint64_t budget = 128u * 1024u * 1024u;
    residency_ = std::make_shared<assets::AssetResidencyManager>(
        assets::ResidencyBudget{budget, budget, budget, budget, budget, budget, budget, budget});
    if (!assets_.configure_async_requests(*executor_, residency_)) {
        reason = "video asset preparation could not be configured";
        return false;
    }
    const auto surface = platform_.surface();
    const auto presentation =
        make_presentation_metrics(surface, {.reference = {.size = surface.framebuffer_size},
                                            .world_raster_policy = WorldRasterPolicy::Native});
    if (!presentation) {
        reason = "video presentation metrics are unavailable";
        return false;
    }
    const auto handles = platform_.native_window_handles();
    if (!renderer_.initialize({.native_display = handles.display,
                               .native_window = handles.window,
                               .native_window_type = handles.type,
                               .presentation = presentation.value(),
                               .vsync = options.vsync,
                               .assets = &assets_})) {
        reason = "production video Renderer initialization failed";
        return false;
    }
    const auto media = prepared_clip();
    const auto request = assets::prepared_video_texture_request(media, 0);
    auto queued = assets_.request_texture(request, assets::AssetRequestReason::Demand);
    if (!queued) {
        reason = queued.error().code + ": " + queued.error().message;
        return false;
    }
    pending_seed_ = std::move(queued).value();
#ifdef __EMSCRIPTEN__
    // Browser HTMLVideoElement seeking is asynchronous. The frame-driven runner
    // advances preparation in readiness() on separate rAF callbacks.
    return true;
#else
    for (unsigned step = 0;
         step < 256 && pending_seed_.state() == assets::AssetRequestState::Pending; ++step) {
        service_requests();
        if (!render_frame(reason))
            return false;
    }
    if (pending_seed_.state() != assets::AssetRequestState::Ready) {
        reason =
            "production VP9 seed unavailable: " + diagnostics_text(pending_seed_.diagnostics());
        return false;
    }
    auto seed = std::move(pending_seed_).take_ready();
    if (!seed) {
        reason = "production VP9 seed has no texture lease";
        return false;
    }
    if (!admit_seed(std::move(*seed), reason))
        return false;
    for (unsigned step = 0; step < 128 && !stream_->sample_ready(75); ++step) {
        service_requests();
        if (!advance_source(75, reason) || !render_frame(reason))
            return false;
    }
    if (!stream_->sample_ready(75)) {
        reason = "production video occurrence did not reach its first new sample";
        return false;
    }
    return finish_stream_preparation(reason);
#endif
}

bool VideoScenario::admit_seed(assets::AssetLease<assets::TextureAsset> seed, std::string& reason)
{
    const auto media = prepared_clip();
    const auto request = assets::prepared_video_texture_request(media, 0);
    assets_.set_supplemental_leases_on_owner(
        assets::StructuredAssetLeaseSet({{{request, seed.cache_key()}, seed}}));
    AssetWorldPresentationResourceResolver resolver(assets_);
    resolver.bind_catalog(
        {.images = {},
         .animations = {{media.animation,
                         {kClipWidth, kClipHeight},
                         media.motion,
                         {{media.motion,
                           {},
                           {},
                           core::compiled::AnimationMotionKind::Video,
                           identifier<core::AssetId>("video-source"),
                           core::compiled::VideoAnimationSourceRange{0, kClipDurationMs}}}}},
         .prepared_video_motions = {media}});
    auto visual = resolver.resolve_visual(
        core::compiled::Visual{core::compiled::AnimationVisual{media.animation, media.motion}},
        std::nullopt, "benchmark-video");
    if (!visual || !visual.value().video_stream) {
        reason = visual ? "production video stream unavailable" : diagnostics_text(visual.error());
        return false;
    }
    stream_ = visual.value().video_stream;
    sample_ = std::move(seed);
    // The first occurrence's independent GPU surfaces/decoder are prepared,
    // never counted as a steady-state upload or presentation frame.
    return advance_source(75, reason);
}

bool VideoScenario::finish_stream_preparation(std::string& reason)
{
    if (!stream_ || !stream_->sample_ready(75)) {
        reason = "production video occurrence initial sample not ready";
        return false;
    }
    environment_.video_codec_backend = stream_->backend();
    environment_.video_codec_fallback = stream_->fallback_reason();
#ifdef __EMSCRIPTEN__
    environment_.video_upload_pipeline =
        "typed-asset browser-media HTMLVideoElement + imported WebGL RGBA texture";
#else
    environment_.video_upload_pipeline = "typed-asset YUV planes + bgfx video_yuv conversion";
#endif
    if (const char* driver = SDL_GetCurrentVideoDriver())
        environment_.video_driver = driver;
    if (const auto* caps = bgfx::getCaps()) {
        environment_.renderer = bgfx::getRendererName(caps->rendererType);
        environment_.gpu_vendor_id = caps->vendorId;
        environment_.gpu_device_id = caps->deviceId;
    }
    const auto surface = platform_.surface();
    environment_.width_pixels = surface.framebuffer_size.width;
    environment_.height_pixels = surface.framebuffer_size.height;
    environment_.world_raster_width = renderer_.reference_width();
    environment_.world_raster_height = renderer_.reference_height();
    epoch_ = std::chrono::steady_clock::now();
    ready_ = true;
    return true;
}

Readiness VideoScenario::readiness(std::string& reason)
{
#ifdef __EMSCRIPTEN__
    if (!ready_ && renderer_.is_initialized()) {
        service_requests();
        if (pending_seed_) {
            if (pending_seed_.state() == assets::AssetRequestState::Failed ||
                pending_seed_.state() == assets::AssetRequestState::Canceled) {
                reason =
                    "browser video seed failed: " + diagnostics_text(pending_seed_.diagnostics());
                return Readiness::Failed;
            }
            if (pending_seed_.state() == assets::AssetRequestState::Ready) {
                auto seed = std::move(pending_seed_).take_ready();
                if (!seed || !admit_seed(std::move(*seed), reason))
                    return Readiness::Failed;
            }
        } else if (stream_) {
            if (!advance_source(75, reason))
                return Readiness::Failed;
            if (stream_->sample_ready(75))
                return finish_stream_preparation(reason) ? Readiness::Ready : Readiness::Failed;
        }
        // Browser media promises and GPU ownership advance between rAF ticks.
        if (!render_frame(reason))
            return Readiness::Failed;
        return Readiness::Pending;
    }
#endif
    if (!ready_) {
        reason = "video decoder or graphics source was not prepared";
        return Readiness::Failed;
    }
    return Readiness::Ready;
}

bool VideoScenario::advance_source(std::uint64_t time_ms, std::string& reason)
{
    auto produced = stream_->sample(time_ms);
    if (!produced) {
        reason = diagnostics_text(produced.error());
        return false;
    }
    if (produced.value())
        sample_ = *produced.value();
    return true;
}

bool VideoScenario::render_frame(std::string& reason)
{
    if (!renderer_.is_initialized()) {
        reason = "video Renderer is not initialized";
        return false;
    }
    const auto begin =
        diagnostic_ ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    renderer_.begin_frame();
    if (id_ == "video-present" && sample_) {
        QuadBatch quads;
        quads.draw_textured_quad({0, 0, static_cast<float>(renderer_.reference_width()),
                                  static_cast<float>(renderer_.reference_height())},
                                 Texture{sample_->asset().handle}, {0, 0, 1, 1}, {});
        renderer_.draw_2d(quads);
        renderer_.composite_ordinary_world_surface();
    }
    renderer_.finalize_screenshot_capture();
    const auto submitted =
        diagnostic_ ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    renderer_.end_frame();
    if (diagnostic_) {
        cpu_submission_ms_ = std::chrono::duration<double, std::milli>(submitted - begin).count();
        bgfx_frame_cpu_ms_ =
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - submitted)
                .count();
    }
    return true;
}

bool VideoScenario::frame(std::string& reason)
{
    if (!ready_) {
        reason = "video scenario not ready";
        return false;
    }
#if defined(__ANDROID__)
    if (!android_benchmark_foreground()) {
        interruption_ = Interruption::Recoverable;
        reason = "Android Activity suspended during video playback benchmark";
        return false;
    }
#endif
    if (id_ == "video-decode") {
#if !defined(__EMSCRIPTEN__)
        // One semantic source packet per work unit, looping at the authored 200 ms endpoint.
        const double time_ms = static_cast<double>((packet_index_ % 4) * 50 + 25);
        for (unsigned step = 0; step < 8; ++step) {
            auto decoded = decoder_->step(time_ms);
            if (!decoded) {
                reason = diagnostics_text(decoded.error());
                return false;
            }
            if (decoded.value())
                break;
            if (step == 7) {
                reason = "decoder did not advance to requested presentation timestamp";
                return false;
            }
        }
        ++packet_index_;
#endif
        return true;
    }
    platform_.poll_events();
    if (platform_.should_quit()) {
        interruption_ = Interruption::Cancelled;
        reason = "video playback window closed";
        return false;
    }
    // Gameplay time chooses the semantic video frame. Decoder completion never advances it.
    const auto elapsed = std::chrono::steady_clock::now() - epoch_;
    const auto time_ms =
        static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count()) %
        kClipDurationMs;
    service_requests();
    if (!advance_source(time_ms, reason))
        return false;
    return render_frame(reason);
}

void VideoScenario::diagnostic_frame(DiagnosticObservation& observation)
{
    if (id_ == "video-decode")
        return;
    observation.cpu_submission_ms = cpu_submission_ms_;
    observation.bgfx_frame_cpu_ms = bgfx_frame_cpu_ms_;
    observation.submitted_frame = renderer_.last_submitted_bgfx_frame();
    capture_bgfx_diagnostics(observation);
}

void VideoScenario::diagnostic_completion(std::vector<DiagnosticObservation>& late)
{
    if (id_ == "video-decode")
        return;
    for (unsigned step = 0; step < 3; ++step) {
        renderer_.begin_frame();
        renderer_.end_frame();
        DiagnosticObservation observation;
        capture_bgfx_diagnostics(observation);
        late.push_back(std::move(observation));
    }
}

bool VideoScenario::complete(std::string&) { return true; }

bool VideoScenario::cleanup(std::string& reason)
{
    reason.clear();
    ready_ = false;
    stream_.reset();
    sample_.reset();
    pending_seed_.reset();
#ifndef __EMSCRIPTEN__
    decoder_.reset();
    source_.reset();
#endif
    assets_.clear_supplemental_leases_on_owner();
    // Release GPU state while Renderer still owns the original AssetManager.
    renderer_.shutdown();
    if (executor_) {
        executor_->begin_shutdown();
        (void)executor_->dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    }
    assets_ = assets::AssetManager{};
    executor_.reset();
    residency_.reset();
    platform_.shutdown();
    return true;
}

} // namespace noveltea::benchmark
