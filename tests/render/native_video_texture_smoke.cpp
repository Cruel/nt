#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/assets/prepared_video_texture.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"
#include "noveltea/world_presentation.hpp"

#include <array>
#include <cstdio>
#include <limits>
#include <set>

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
} // namespace

int main()
{
    Fixture fixture;
    if (!fixture.platform.initialize({.title = "Native Video GPU Smoke",
                                      .width = 64,
                                      .height = 16,
                                      .resizable = false,
                                      .vsync = false}))
        return 4;
    fixture.assets.mount_directory("project",
                                   std::string(NOVELTEA_SOURCE_DIR) + "/tests/fixtures/media");
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
    return run(fixture) ? 0 : 1;
}
