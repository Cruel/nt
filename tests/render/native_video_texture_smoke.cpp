#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/assets/prepared_video_texture.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"
#include "noveltea/world_presentation.hpp"

#include <array>
#include <bgfx/bgfx.h>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <limits>
#include <set>
#include <string_view>
#include <utility>

namespace {
using namespace noveltea;

bool check(bool passed, const char* message)
{
    if (!passed)
        std::fprintf(stderr, "NATIVE_VIDEO_SMOKE_FAILED: %s\n", message);
    return passed;
}

template<class Id> Id id(const char* value) { return Id::create(value).value(); }

struct Fixture {
    Platform platform;
    Renderer renderer;
    jobs::InlineJobExecutor executor;
    assets::AssetManager assets;
    std::shared_ptr<assets::AssetResidencyManager> residency;

    Fixture()
    {
        constexpr std::uint64_t budget = 128u * 1024u * 1024u;
        residency = std::make_shared<assets::AssetResidencyManager>(assets::ResidencyBudget{
            budget, budget, budget, budget, budget, budget, budget, budget});
    }
    ~Fixture()
    {
        executor.begin_shutdown();
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        assets = assets::AssetManager{};
        residency.reset();
        renderer.shutdown();
    }
    void progress()
    {
        for (unsigned step = 0; step < 64; ++step) {
            (void)executor.dispatch_owner_completions(64);
            if (!executor.advance_one_step())
                break;
        }
        (void)executor.dispatch_owner_completions(64);
    }
    void draw_masked(const assets::AssetLease<assets::TextureAsset>& color, std::uint16_t mask,
                     Color backdrop = {0, 1, 0, 1})
    {
        renderer.begin_frame();
        QuadBatch batch;
        batch.draw_colored_quad({0, 0, 64, 16}, backdrop);
        QuadCommand video;
        video.rect = {0, 0, 32, 16};
        video.texture = Texture{color->handle};
        video.video_alpha_mask = Texture{mask};
        batch.draw(std::move(video));
        renderer.draw_2d(batch);
        renderer.composite_ordinary_world_surface();
        renderer.finalize_screenshot_capture();
        renderer.end_frame();
    }
    void draw(const assets::AssetLease<assets::TextureAsset>* left = nullptr,
              const assets::AssetLease<assets::TextureAsset>* right = nullptr)
    {
        renderer.begin_frame();
        QuadBatch batch;
        if (left)
            batch.draw_textured_quad({0, 0, 32, 16}, Texture{(*left)->handle}, {0, 0, 1, 1}, {});
        if (right)
            batch.draw_textured_quad({32, 0, 32, 16}, Texture{(*right)->handle}, {0, 0, 1, 1}, {});
        renderer.draw_2d(batch);
        renderer.composite_ordinary_world_surface();
        renderer.finalize_screenshot_capture();
        renderer.end_frame();
    }
};

core::PreparedVideoMotion representation()
{
    return {id<core::AnimationId>("video"),
            id<core::AnimationMotionId>("idle"),
            std::string(64, 'a'),
            {{"not-packaged-0.png", 50},
             {"not-packaged-1.png", 50},
             {"not-packaged-2.png", 50},
             {"not-packaged-3.png", 50}},
            core::PreparedBrowserVideo{"opaque-vp9.webm", 32, 16}};
}

bool run(Fixture& fixture)
{
    const auto media = representation();
    const auto initial = assets::prepared_video_texture_request(media, 0);
    auto requested = fixture.assets.request_texture(initial, assets::AssetRequestReason::Demand);
    if (!check(static_cast<bool>(requested), "initial request"))
        return false;
    auto request = std::move(requested).value();
    for (unsigned tick = 0; tick < 128 && request.state() != assets::AssetRequestState::Ready;
         ++tick) {
        fixture.progress();
        fixture.draw();
        if (request.state() == assets::AssetRequestState::Failed) {
            for (const auto& diagnostic : request.diagnostics())
                std::fprintf(stderr, "%s: %s\n", diagnostic.code.c_str(),
                             diagnostic.message.c_str());
            return false;
        }
    }
    auto seed = std::move(request).take_ready();
    if (!check(seed.has_value(), "initial sample readiness"))
        return false;
    fixture.assets.set_supplemental_leases_on_owner(
        assets::StructuredAssetLeaseSet({{{initial, seed->cache_key()}, *seed}}));
    AssetWorldPresentationResourceResolver resources(fixture.assets);
    resources.bind_catalog({.images = {},
                            .animations = {{media.animation,
                                            {32, 16},
                                            media.motion,
                                            {{media.motion,
                                              {},
                                              {},
                                              core::compiled::AnimationMotionKind::Video,
                                              id<core::AssetId>("source"),
                                              core::compiled::VideoAnimationSourceRange{0, 200}}}}},
                            .prepared_video_motions = {media}});
    const core::compiled::Visual visual{
        core::compiled::AnimationVisual{media.animation, media.motion}};
    auto left_visual = resources.resolve_visual(visual, std::nullopt, "native-smoke-left");
    auto right_visual = resources.resolve_visual(visual, std::nullopt, "native-smoke-right");
    if (!check(left_visual && right_visual, "independent occurrence realization"))
        return false;
    auto left = left_visual.value().video_stream;
    auto right = right_visual.value().video_stream;
    if (!check(left && right && left != right, "independent persistent streams"))
        return false;
    assets::AssetLease<assets::TextureAsset> left_sample = *seed;
    assets::AssetLease<assets::TextureAsset> right_sample = *seed;
    const auto sample = [&](const auto& stream, std::uint64_t time,
                            assets::AssetLease<assets::TextureAsset>& current) {
        auto result = stream->sample(time);
        if (!result)
            return false;
        if (result.value())
            current = *result.value();
        return true;
    };
    if (!check(sample(right, 125, right_sample), "independent blue request"))
        return false;
    if (!check(right_sample->handle == seed->asset().handle,
               "late sample holds complete initial output"))
        return false;
    for (unsigned tick = 0; tick < 128 && !right->sample_ready(125); ++tick) {
        fixture.progress();
        if (!check(sample(right, 125, right_sample), "blue sample progress"))
            return false;
        fixture.draw(&left_sample, &right_sample);
    }
    if (!check(right->sample_ready(125), "blue sample is ready"))
        return false;
    if (std::string_view(right->backend()) == "libvpx-vp9" &&
        !check(!right->fallback_reason().empty(), "software fallback reason reaches the stream"))
        return false;
    const auto metadata = fixture.assets.stat("project:/opaque-vp9.webm");
    if (!check(metadata && fixture.residency->accounting_on_owner().current.source_bytes ==
                               metadata.value->uncompressed_size,
               "encoded source bytes are shared and charged once"))
        return false;
    const auto uploads = right_sample->video_session->uploads_on_owner();
    for (unsigned tick = 0; tick < 16; ++tick) {
        if (!check(sample(left, 25, left_sample) && sample(right, 125, right_sample),
                   "held sampling"))
            return false;
        fixture.progress();
        fixture.draw(&left_sample, &right_sample);
    }
    if (!check(right_sample->video_session->uploads_on_owner() == uploads,
               "held samples do not upload"))
        return false;
    if (!check(fixture.renderer.request_screenshot_capture({1, 64, 16}), "GPU capture request"))
        return false;
    std::optional<RendererScreenshotCapture> capture;
    for (unsigned tick = 0; tick < 32 && !capture; ++tick) {
        fixture.draw(&left_sample, &right_sample);
        capture = fixture.renderer.take_screenshot_capture();
    }
    if (!check(capture.has_value(), "GPU readback completed"))
        return false;
    const auto color_at = [&](unsigned x) {
        const auto offset = 8u * capture->pitch + x * 4;
        const bool rgba = capture->format == RendererScreenshotPixelFormat::Rgba8;
        return std::array<unsigned, 3>{capture->pixels[offset + (rgba ? 0 : 2)],
                                       capture->pixels[offset + 1],
                                       capture->pixels[offset + (rgba ? 2 : 0)]};
    };
    const auto red = color_at(8), blue = color_at(48);
    if (!check(red[0] > 220 && red[1] < 30 && red[2] < 30 && blue[2] > 220 && blue[0] < 30 &&
                   blue[1] < 30,
               "native YUV GPU conversion renders independent red/blue samples")) {
        std::fprintf(stderr, "red=%u,%u,%u blue=%u,%u,%u\n", red[0], red[1], red[2], blue[0],
                     blue[1], blue[2]);
        return false;
    }
    // Tracer compositor: same production WorldVideoStream color lease, with a
    // single-channel alpha plane uploaded once and sampled by the quad shader.
    struct MaskTexture {
        bgfx::TextureHandle handle = BGFX_INVALID_HANDLE;
        ~MaskTexture()
        {
            if (bgfx::isValid(handle))
                bgfx::destroy(handle);
        }
    } mask_texture;
    std::array<std::uint8_t, 32 * 16> mask_pixels{};
    for (unsigned y = 0; y < 16; ++y)
        for (unsigned x = 0; x < 32; ++x)
            mask_pixels[y * 32 + x] = x < 8 ? 0 : x < 16 ? 128 : 255;
    mask_texture.handle = bgfx::createTexture2D(
        32, 16, false, 1, bgfx::TextureFormat::R8,
        BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP | BGFX_SAMPLER_MIN_POINT |
            BGFX_SAMPLER_MAG_POINT | BGFX_SAMPLER_MIP_POINT,
        bgfx::copy(mask_pixels.data(), static_cast<std::uint32_t>(mask_pixels.size())));
    if (!check(bgfx::isValid(mask_texture.handle), "R8 video mask upload"))
        return false;
    if (!check(fixture.renderer.request_screenshot_capture({3, 64, 16}),
               "masked video GPU capture request"))
        return false;
    capture.reset();
    for (unsigned tick = 0; tick < 32 && !capture; ++tick) {
        fixture.draw_masked(left_sample, mask_texture.handle.idx);
        capture = fixture.renderer.take_screenshot_capture();
    }
    if (!check(capture.has_value(), "masked video GPU readback completed"))
        return false;
    const auto masked_pixel = [&](unsigned x) {
        const auto offset = 8u * capture->pitch + x * 4;
        const bool rgba = capture->format == RendererScreenshotPixelFormat::Rgba8;
        return std::array<unsigned, 3>{capture->pixels[offset + (rgba ? 0 : 2)],
                                       capture->pixels[offset + 1],
                                       capture->pixels[offset + (rgba ? 2 : 0)]};
    };
    const auto transparent = masked_pixel(4);
    const auto partial = masked_pixel(12);
    const auto solid = masked_pixel(24);
    if (!check(transparent[0] < 25 && transparent[1] > 225 && partial[0] > 90 && partial[0] < 160 &&
                   partial[1] > 90 && partial[1] < 160 && solid[0] > 225 && solid[1] < 25,
               "straight-alpha WebP-style R8 plane composites VP9 color on GPU")) {
        std::fprintf(stderr,
                     "alpha GPU pixels: transparent=%u,%u,%u partial=%u,%u,%u solid=%u,%u,%u\n",
                     transparent[0], transparent[1], transparent[2], partial[0], partial[1],
                     partial[2], solid[0], solid[1], solid[2]);
        return false;
    }
    std::fprintf(stdout, "NATIVE_VIDEO_ALPHA_R8_GPU_CHECKS_PASSED\n");
    const auto occurrence_session = right_sample->video_session;
    std::set<std::uint16_t> reused_surfaces;
    for (auto time : {175u, 0u, 75u, 175u, 0u}) {
        if (!check(sample(right, time, right_sample), "seek/loop request"))
            return false;
        for (unsigned tick = 0; tick < 128 && !right->sample_ready(time); ++tick) {
            fixture.progress();
            if (!check(sample(right, time, right_sample), "seek/loop progress"))
                return false;
            fixture.draw(&left_sample, &right_sample);
        }
        if (!check(right->sample_ready(time), "seek/loop readiness"))
            return false;
        if (right_sample->video_session == occurrence_session)
            reused_surfaces.insert(right_sample->handle);
    }
    if (!check(reused_surfaces.size() <= 2, "GPU media surfaces are reused across seeks and loops"))
        return false;
    if (!check(sample(left, 75, left_sample), "late-frame setup"))
        return false;
    for (unsigned tick = 0; tick < 128 && !left->sample_ready(75); ++tick) {
        fixture.progress();
        if (!check(sample(left, 75, left_sample), "late-frame setup progress"))
            return false;
        fixture.draw(&left_sample, &right_sample);
    }
    if (!check(left->sample_ready(75), "late-frame setup readiness"))
        return false;
    const auto left_session = left_sample->video_session;
    const auto finish_upload = [&](std::uint64_t before) {
        for (unsigned tick = 0; tick < 128 && left_session->uploads_on_owner() == before; ++tick) {
            fixture.progress();
            fixture.draw(&left_sample, &right_sample);
        }
        return left_session->uploads_on_owner() > before;
    };
    auto before = left_session->uploads_on_owner();
    if (!check(sample(left, 125, left_sample) && finish_upload(before), "late sample upload"))
        return false;
    if (!check(sample(left, 175, left_sample) && left->sample_ready(125),
               "advancing playhead publishes a completed late sample"))
        return false;
    const auto held_blue = left_sample->handle;
    before = left_session->uploads_on_owner();
    if (!check(sample(left, 125, left_sample) && finish_upload(before) &&
                   sample(left, 125, left_sample) && left_sample->handle == held_blue,
               "rewind discards the obsolete pending result"))
        return false;
    before = left_session->uploads_on_owner();
    if (!check(sample(left, 75, left_sample) && finish_upload(before) &&
                   left_sample->handle == held_blue,
               "unpublished upload preserves the held surface"))
        return false;
    if (!check(fixture.renderer.request_screenshot_capture({2, 64, 16}), "held GPU capture"))
        return false;
    capture.reset();
    for (unsigned tick = 0; tick < 32 && !capture; ++tick) {
        fixture.draw(&left_sample, &right_sample);
        capture = fixture.renderer.take_screenshot_capture();
    }
    if (!check(capture.has_value(), "held GPU readback completed"))
        return false;
    const auto held_color = color_at(8);
    if (!check(held_color[2] > 220 && held_color[0] < 30 && held_color[1] < 30,
               "discarded and unpublished conversions do not overwrite held blue pixels"))
        return false;
    if (!check(sample(left, 75, left_sample) && left->sample_ready(75), "publish completed rewind"))
        return false;

    const auto before_hidden = occurrence_session->uploads_on_owner();
    if (!check(sample(right, 175, right_sample), "pending hidden decode"))
        return false;
    right->suspend();
    fixture.progress();
    fixture.draw(&left_sample, &right_sample);
    if (!check(occurrence_session->uploads_on_owner() == before_hidden,
               "hidden cancellation does not upload"))
        return false;
    if (!check(sample(right, 125, right_sample), "hidden occurrence catches up"))
        return false;
    for (unsigned tick = 0; tick < 128 && !right->sample_ready(125); ++tick) {
        fixture.progress();
        if (!check(sample(right, 125, right_sample), "catch-up progress"))
            return false;
        fixture.draw(&left_sample, &right_sample);
    }
    if (!check(right->sample_ready(125), "catch-up readiness"))
        return false;
    std::fprintf(stdout,
                 "NATIVE_VIDEO_GPU_CHECKS_PASSED backend=%s uploads=%llu reusedSurfaces=%zu\n",
                 right->backend(),
                 static_cast<unsigned long long>(right_sample->video_session->uploads_on_owner()),
                 reused_surfaces.size());
    auto policy = fixture.residency->policy_on_owner();
    const auto original_policy = policy;
    policy.budget.temporary_bytes = 16u * 1024u * 1024u;
    (void)fixture.residency->reconfigure_policy_on_owner(policy);
    fixture.assets.mount_directory("future",
                                   std::string(NOVELTEA_SOURCE_DIR) + "/tests/fixtures/media");
    auto future = initial;
    future.path = "future:/not-packaged.png";
    future.video_sample->media_path = "future:/opaque-vp9.webm";
    const auto source_bytes_before = fixture.residency->accounting_on_owner().current.source_bytes;
    auto blocker = fixture.residency->reserve_preparation_on_owner(
        {.temporary_bytes = 16u * 1024u * 1024u}, assets::AssetRequestReason::Startup);
    if (!check(blocker.reservation.has_value(), "temporary admission blocker"))
        return false;
    auto speculative = fixture.assets.prefetch_texture(future, {72});
    if (!check(static_cast<bool>(speculative), "bounded native prefetch registration"))
        return false;
    for (unsigned tick = 0; tick < 16; ++tick) {
        fixture.progress();
        fixture.draw(&left_sample, &right_sample);
    }
    if (!check(fixture.residency->accounting_on_owner().current.source_bytes == source_bytes_before,
               "prefetch must not force native media through demand budget admission"))
        return false;
    blocker.reservation.reset();
    (void)fixture.residency->reconfigure_policy_on_owner(original_policy);
    auto demanded = fixture.assets.request_texture(future, assets::AssetRequestReason::Demand);
    if (!check(static_cast<bool>(demanded), "demand after denied prefetch"))
        return false;
    for (unsigned tick = 0;
         tick < 128 && demanded.value().state() != assets::AssetRequestState::Ready; ++tick) {
        fixture.progress();
        fixture.draw(&left_sample, &right_sample);
    }
    if (!check(demanded.value().state() == assets::AssetRequestState::Ready,
               "denied prefetch does not poison native demand"))
        return false;
    (void)fixture.assets.refresh_namespace_on_owner("project");
    auto expired = right->sample(125);
    if (!check(!expired && expired.error().front().code == "presentation.video_source_changed",
               "expired native source fails explicitly"))
        return false;
    fixture.assets.clear_supplemental_leases_on_owner();
    std::fprintf(stdout, "NATIVE_VIDEO_SMOKE_PASSED\n");
    return true;
}

bool run_alpha_trace(Fixture& fixture, const std::filesystem::path& directory)
{
    auto media = representation();
    media.alpha_webp = core::PreparedVideoAlpha{"alpha.webp"};
    const auto initial = assets::prepared_video_texture_request(media, 0);
    auto requested = fixture.assets.request_texture(initial, assets::AssetRequestReason::Demand);
    if (!check(static_cast<bool>(requested), "trace initial sample request"))
        return false;
    auto request = std::move(requested).value();
    for (unsigned tick = 0; tick < 128 && request.state() != assets::AssetRequestState::Ready;
         ++tick) {
        fixture.progress();
        fixture.draw();
    }
    auto seed = std::move(request).take_ready();
    if (!check(seed.has_value(), "trace real prepared VP9 seed readiness"))
        return false;
    fixture.assets.set_supplemental_leases_on_owner(
        assets::StructuredAssetLeaseSet({{{initial, seed->cache_key()}, *seed}}));
    AssetWorldPresentationResourceResolver resources(fixture.assets);
    resources.bind_catalog({.images = {},
                            .animations = {{media.animation,
                                            {32, 16},
                                            media.motion,
                                            {{media.motion,
                                              {},
                                              {},
                                              core::compiled::AnimationMotionKind::Video,
                                              id<core::AssetId>("source"),
                                              core::compiled::VideoAnimationSourceRange{0, 200}}}}},
                            .prepared_video_motions = {media}});
    auto visual = resources.resolve_visual(
        core::compiled::Visual{core::compiled::AnimationVisual{media.animation, media.motion}},
        std::nullopt, "traced-alpha-occurrence");
    if (!check(static_cast<bool>(visual), "trace actual WorldVideoStream realization"))
        return false;
    auto stream = visual.value().video_stream;
    if (!check(static_cast<bool>(stream), "trace WorldVideoStream"))
        return false;
    auto color = *seed;
    const auto sample_at = [&](std::uint64_t time) {
        for (unsigned tick = 0; tick < 128; ++tick) {
            auto sampled = stream->sample(time);
            if (!sampled)
                return false;
            if (sampled.value())
                color = *sampled.value();
            if (stream->sample_ready(time))
                return true;
            fixture.progress();
            fixture.draw();
        }
        return false;
    };

    struct MaskTextures {
        std::array<bgfx::TextureHandle, 2> buffers{{BGFX_INVALID_HANDLE, BGFX_INVALID_HANDLE}};
        ~MaskTextures()
        {
            for (auto texture : buffers)
                if (bgfx::isValid(texture))
                    bgfx::destroy(texture);
        }
    } masks;
    constexpr std::uint64_t times[] = {0, 125};
    for (unsigned page = 0; page < 2; ++page) {
        // When the optional libwebp probe is available, consume *its* persistent
        // WebPAnimDecoder output, not the Sharp reference page, through the
        // production WorldVideoStream + R8 GPU shader transport.
        const auto persistent =
            directory / (page == 0 ? "persistent-alpha-page0.r8" : "persistent-alpha-page1.r8");
        const auto reference = directory / (page == 0 ? "alpha-page0.r8" : "alpha-page1.r8");
        const auto& file = std::filesystem::exists(persistent) ? persistent : reference;
        std::ifstream input(file, std::ios::binary);
        if (!check(input.good(), "trace decoded WebP page file"))
            return false;
        std::array<std::uint8_t, 32 * 16> pixels{};
        input.read(reinterpret_cast<char*>(pixels.data()), pixels.size());
        if (!check(input.gcount() == static_cast<std::streamsize>(pixels.size()) &&
                       input.peek() == std::char_traits<char>::eof(),
                   "trace WebP page matches R8 canvas"))
            return false;
        if (!check(sample_at(times[page]), "trace color frame seeks to matching alpha hold"))
            return false;
        if (!check(stream->alpha_upload_count() == page + 1,
                   "production alpha uploads only when the WebP hold changes"))
            return false;
        const auto produced_alpha = stream->alpha_mask();
        if (!check(stream->has_alpha_mask() && produced_alpha.has_value() &&
                       bgfx::isValid(bgfx::TextureHandle{produced_alpha->handle}),
                   "production video stream publishes a decoded GPU alpha mask"))
            return false;
        if (!check(stream->alpha_hit(4.0f / 32.0f, 8.0f / 16.0f) == (page == 1) &&
                       stream->alpha_hit(12.0f / 32.0f, 8.0f / 16.0f) &&
                       stream->alpha_hit(24.0f / 32.0f, 8.0f / 16.0f) == (page == 0),
                   "CPU alpha hit testing matches the same displayed WebP frame"))
            return false;
        // Keep the preceding complete sample alive while preparing the next
        // color/mask pair, just as the production video color path does.
        masks.buffers[page] = bgfx::createTexture2D(
            32, 16, false, 1, bgfx::TextureFormat::R8,
            BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP | BGFX_SAMPLER_MIN_POINT |
                BGFX_SAMPLER_MAG_POINT | BGFX_SAMPLER_MIP_POINT,
            bgfx::copy(pixels.data(), pixels.size()));
        if (!check(bgfx::isValid(masks.buffers[page]), "trace WebP-decoded GPU R8 upload"))
            return false;
        if (!check(fixture.renderer.request_screenshot_capture({10 + page, 64, 16}),
                   "trace GPU compositing capture"))
            return false;
        std::optional<RendererScreenshotCapture> capture;
        for (unsigned tick = 0; tick < 32 && !capture; ++tick) {
            fixture.draw_masked(color, produced_alpha->handle);
            capture = fixture.renderer.take_screenshot_capture();
        }
        if (!check(capture.has_value(), "trace complete masked GPU presentation"))
            return false;
        const auto rgb = [&](unsigned x) {
            const auto offset = 8u * capture->pitch + 4u * x;
            const bool rgba = capture->format == RendererScreenshotPixelFormat::Rgba8;
            return std::array<unsigned, 3>{capture->pixels[offset + (rgba ? 0 : 2)],
                                           capture->pixels[offset + 1],
                                           capture->pixels[offset + (rgba ? 2 : 0)]};
        };
        const auto transparent = rgb(page == 0 ? 4 : 24);
        const auto partial = rgb(12);
        const auto solid = rgb(page == 0 ? 24 : 4);
        const auto color_channel = page == 0 ? 0u : 2u;
        if (!check(transparent[1] > 225 && transparent[color_channel] < 25 && partial[1] > 90 &&
                       partial[1] < 160 && partial[color_channel] > 90 &&
                       partial[color_channel] < 160 && solid[color_channel] > 225 && solid[1] < 25,
                   "WebP decoded mask and production VP9 form the right straight-alpha GPU pair")) {
            std::fprintf(
                stderr, "WebP trace page=%u transparent=%u,%u,%u partial=%u,%u,%u solid=%u,%u,%u\n",
                page, transparent[0], transparent[1], transparent[2], partial[0], partial[1],
                partial[2], solid[0], solid[1], solid[2]);
            return false;
        }
    }
    // A second occurrence must allocate and own a different alpha plane; it
    // must not publish or upload another occurrence's sampled WebP page.
    auto independent = resources.resolve_visual(
        core::compiled::Visual{core::compiled::AnimationVisual{media.animation, media.motion}},
        std::nullopt, "second-transparent-occurrence");
    if (!check(static_cast<bool>(independent) && independent.value().video_stream &&
                   independent.value().video_stream != stream,
               "transparent occurrences retain independent decoder owners"))
        return false;
    auto separate = independent.value().video_stream;
    auto independent_first = separate->sample(0);
    if (!check(static_cast<bool>(independent_first) && separate->alpha_mask().has_value() &&
                   separate->alpha_mask()->handle != stream->alpha_mask()->handle &&
                   separate->alpha_upload_count() == 1 && stream->alpha_upload_count() == 2,
               "separate alpha GPU textures and upload counters do not leak between occurrences"))
        return false;
    // Inspect a partially covered edge over both dark and light backdrops.
    // The same WebP-derived alpha must blend without a green-screen/chroma key.
    for (unsigned background = 0; background < 2; ++background) {
        const float shade = background == 0 ? 0.0f : 1.0f;
        if (!check(fixture.renderer.request_screenshot_capture({20 + background, 64, 16}),
                   "contrasting backdrop edge capture"))
            return false;
        std::optional<RendererScreenshotCapture> capture;
        for (unsigned tick = 0; tick < 32 && !capture; ++tick) {
            fixture.draw_masked(color, masks.buffers[1].idx, {shade, shade, shade, 1.0f});
            capture = fixture.renderer.take_screenshot_capture();
        }
        if (!check(capture.has_value(), "contrasting backdrop GPU readback"))
            return false;
        const auto offset = 8u * capture->pitch + 12u * 4;
        const bool rgba = capture->format == RendererScreenshotPixelFormat::Rgba8;
        const auto red = capture->pixels[offset + (rgba ? 0 : 2)];
        const auto green = capture->pixels[offset + 1];
        const auto blue = capture->pixels[offset + (rgba ? 2 : 0)];
        if (!check(red >= (background ? 90 : 0) && red <= (background ? 160 : 25) &&
                       green >= (background ? 90 : 0) && green <= (background ? 160 : 25) &&
                       blue >= (background ? 225 : 90),
                   "partially covered blue WebP edge composites correctly over black and white")) {
            std::fprintf(stderr, "WebP edge backdrop=%u pixel=%u,%u,%u\n", background, red, green,
                         blue);
            return false;
        }
    }
    // Validate automatic, held WebP R8 publication over seeks, loop/reset and
    // unchanged intervals without redundant GPU uploads.
    constexpr std::array<std::pair<std::uint64_t, unsigned>, 7> revisits{{
        {25, 0},
        {75, 0},
        {125, 1},
        {175, 1},
        {25, 0},
        {175, 1},
        {0, 0},
    }};
    unsigned previous_page = 1;
    auto alpha_uploads = stream->alpha_upload_count();
    for (unsigned step = 0; step < revisits.size(); ++step) {
        const auto [time, page] = revisits[step];
        if (!check(sample_at(time), "trace frame hold/seek/loop prepared color"))
            return false;
        if (page != previous_page)
            ++alpha_uploads;
        if (!check(stream->alpha_upload_count() == alpha_uploads,
                   "held alpha pages avoid repeat R8 uploads on color-only samples"))
            return false;
        previous_page = page;
        if (!check(fixture.renderer.request_screenshot_capture({30 + step, 64, 16}),
                   "trace held/seek GPU pair capture"))
            return false;
        std::optional<RendererScreenshotCapture> capture;
        for (unsigned tick = 0; tick < 32 && !capture; ++tick) {
            const auto alpha = stream->alpha_mask();
            if (!check(alpha.has_value(), "alpha mask remains available over held seeks"))
                return false;
            fixture.draw_masked(color, alpha->handle);
            capture = fixture.renderer.take_screenshot_capture();
        }
        if (!check(capture.has_value(), "trace held/seek GPU pair readback"))
            return false;
        const bool rgba = capture->format == RendererScreenshotPixelFormat::Rgba8;
        const auto color_channel = page == 0 ? 0u : 2u;
        const auto opposite_channel = page == 0 ? 2u : 0u;
        const auto pixel = 8u * capture->pitch + 24u * 4;
        const auto channel = [&](unsigned rgb) {
            return static_cast<unsigned>(capture->pixels[pixel + (rgb == 1 ? 1
                                                                  : rgba   ? rgb
                                                                           : 2 - rgb)]);
        };
        if (!check(page == 0 ? channel(color_channel) > 225 && channel(1) < 30 &&
                                   channel(opposite_channel) < 30
                             : channel(color_channel) < 30 && channel(1) > 225,
                   "trace color+alpha replay corresponds to requested presentation time"))
            return false;
    }
    fixture.assets.clear_supplemental_leases_on_owner();
    std::fprintf(stdout, "NATIVE_VIDEO_WEBP_ALPHA_TRANSPORT_TRACE_PASSED\n");
    return true;
}
} // namespace

int main(int argc, char** argv)
{
    if (argc != 1 && argc != 2) {
        std::fprintf(stderr, "Usage: noveltea_native_video_texture_smoke [traced-media-dir]\n");
        return 2;
    }
    Fixture fixture;
    if (!fixture.platform.initialize({.title = "Native Video GPU Smoke",
                                      .width = 64,
                                      .height = 16,
                                      .resizable = false,
                                      .vsync = false}))
        return 4;
    fixture.assets.mount_directory("project", argc == 2 ? argv[1]
                                                        : std::string(NOVELTEA_SOURCE_DIR) +
                                                              "/tests/fixtures/media");
    fixture.assets.mount_directory("system",
                                   std::string(NOVELTEA_TEST_RUNTIME_ASSET_ROOT) + "/system");
    if (!fixture.assets.configure_async_requests(fixture.executor, fixture.residency))
        return 1;
    const auto handles = fixture.platform.native_window_handles();
    const auto presentation =
        make_presentation_metrics(fixture.platform.surface(), {.reference = {.size = {64, 16}}});
    if (!presentation)
        return 1;
    if (!fixture.renderer.initialize({.native_display = handles.display,
                                      .native_window = handles.window,
                                      .native_window_type = handles.type,
                                      .presentation = presentation.value(),
                                      .vsync = false,
                                      .assets = &fixture.assets}))
        return 1;
#if NOVELTEA_ENABLE_DEVTOOLS
    const auto& gpu = fixture.renderer.device_diagnostics();
    if (!check(!gpu.device.empty(), "renderer device diagnostics are captured"))
        return 1;
    std::fprintf(stdout, "NATIVE_VIDEO_RENDERER device=%s acceleration=%s\n", gpu.device.c_str(),
                 gpu.acceleration.c_str());
#endif
    return (argc == 2 ? run_alpha_trace(fixture, argv[1]) : run(fixture)) ? 0 : 1;
}
