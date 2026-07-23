#include "host/audio_preview_adapter.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_residency.hpp"
#include "noveltea/audio/audio_backend.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <limits>
#include <memory>
#include <unordered_map>

namespace noveltea::host {
namespace {

class FakeAudioBackend final : public AudioBackend {
public:
    AudioBackendInfo backend_info() const override { return {"preview-test", initialized}; }

    core::DiagnosticResult<void> initialize(const assets::AssetManager&,
                                            const jobs::JobExecutionConfig&) override
    {
        initialized = true;
        return core::DiagnosticResult<void>::success();
    }

    void shutdown() override
    {
        initialized = false;
        active.clear();
    }

    assets::AssetLoadResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override
    {
        return {assets::AudioAsset{.clip = AudioClipHandle{next_clip++},
                                   .path = request.path,
                                   .mode = request.mode,
                                   .kind = request.kind},
                {}};
    }

    std::unique_ptr<assets::AssetPreparationTask<assets::AudioAsset>>
    create_audio_preparation_task(const assets::AssetManager&,
                                  const assets::AudioAssetRequest& request) override
    {
        class Task final : public assets::AssetPreparationTask<assets::AudioAsset> {
        public:
            Task(FakeAudioBackend& owner, assets::AudioAssetRequest request)
                : m_owner(owner), m_request(std::move(request))
            {
            }

            [[nodiscard]] assets::ResidencyCost
            estimated_cost_on_owner() const noexcept override
            {
                return {.audio_bytes = 1};
            }

            [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
            {
                m_ready = !context.cancellation_requested();
                return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
            }

            [[nodiscard]] core::Result<assets::PreparedAsset<assets::AudioAsset>,
                                       core::Diagnostics>
            finalize_on_owner() noexcept override
            {
                if (!m_ready) {
                    return core::Result<assets::PreparedAsset<assets::AudioAsset>,
                                        core::Diagnostics>::failure(
                        {{.code = "test.preview_audio_preparation_canceled",
                          .message = "fake preview audio preparation was canceled"}});
                }
                auto loaded = m_owner.load_audio(m_request);
                if (!loaded) {
                    return core::Result<assets::PreparedAsset<assets::AudioAsset>,
                                        core::Diagnostics>::failure(
                        {{.code = "test.preview_audio_preparation_failed",
                          .message = loaded.error}});
                }
                return core::Result<assets::PreparedAsset<assets::AudioAsset>,
                                    core::Diagnostics>::success(
                    {.asset = std::move(*loaded.value),
                     .cost = {.audio_bytes = 1},
                     .destroy_on_owner = {}});
            }

        private:
            FakeAudioBackend& m_owner;
            assets::AudioAssetRequest m_request;
            bool m_ready = false;
        };

        return std::make_unique<Task>(*this, request);
    }

    AudioVoiceHandle play(AudioClipHandle, const AudioPlaybackDesc&) override
    {
        const AudioVoiceHandle voice{next_voice++};
        active[voice.id] = true;
        return voice;
    }

    void stop(AudioVoiceHandle voice) override { active[voice.id] = false; }
    void set_volume(AudioVoiceHandle, float) override {}
    void set_bus_volume(AudioBus, float) override {}
    void pause() override {}
    void resume() override {}

    bool voice_active(AudioVoiceHandle voice) const override
    {
        const auto found = active.find(voice.id);
        return found != active.end() && found->second;
    }

    AudioBackendStats stats() const override { return {}; }
    void collect_finished_voices() override {}

    bool initialized = false;
    std::uint32_t next_clip = 1;
    std::uint32_t next_voice = 1;
    std::unordered_map<std::uint32_t, bool> active;
};

jobs::InlineJobExecutor& preview_executor()
{
    struct SharedExecutor final {
        ~SharedExecutor()
        {
            executor.begin_shutdown();
            (void)executor.dispatch_owner_completions(
                std::numeric_limits<std::size_t>::max());
        }

        jobs::InlineJobExecutor executor;
    };
    static SharedExecutor shared;
    return shared.executor;
}

std::shared_ptr<assets::AssetResidencyManager> preview_residency()
{
    return std::make_shared<assets::AssetResidencyManager>(assets::ResidencyBudget{
        .source_bytes = 1024 * 1024,
        .prepared_cpu_bytes = 1024 * 1024,
        .gpu_bytes = 1024 * 1024,
        .audio_bytes = 1024 * 1024,
        .temporary_bytes = 1024 * 1024,
    });
}

assets::AssetLease<assets::AudioAsset>
request_audio_lease(assets::AssetManager& assets, jobs::InlineJobExecutor& executor,
                    const std::string& path, AudioClipKind kind)
{
    auto requested = assets.request_audio(
        {.path = path, .mode = AudioLoadMode::Auto, .kind = kind},
        assets::AssetRequestReason::Demand);
    REQUIRE(requested);
    auto handle = std::move(requested).value();
    REQUIRE(executor.run_until_idle(8));
    REQUIRE(handle.state() == assets::AssetRequestState::Ready);
    auto lease = std::move(handle).take_ready();
    REQUIRE(lease);
    return std::move(*lease);
}

TEST_CASE("preview audio track controls cannot replace or stop gameplay track identity")
{
    assets::AssetManager assets;
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    auto& executor = preview_executor();
    REQUIRE(assets.configure_async_requests(executor, preview_residency()));

    REQUIRE(audio.play_track("bgm", request_audio_lease(assets, executor,
                                                        "project:/runtime.ogg",
                                                        AudioClipKind::Music)));
    REQUIRE(audio.track_active("bgm"));

    AudioPreviewAdapter preview(audio, assets);
    REQUIRE(preview.play_track("bgm", "project:/preview.ogg"));
    REQUIRE(preview.track_active("bgm"));
    REQUIRE(executor.run_until_idle(8));
    preview.update();
    REQUIRE(audio.track_active("bgm"));

    preview.stop_track("bgm");
    CHECK_FALSE(preview.track_active("bgm"));
    CHECK(audio.track_active("bgm"));
}

TEST_CASE("preview audio cleanup stops only tooling-owned voices")
{
    assets::AssetManager assets;
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    auto& executor = preview_executor();
    REQUIRE(assets.configure_async_requests(executor, preview_residency()));

    REQUIRE(audio.play_track("ambience", request_audio_lease(assets, executor,
                                                             "project:/runtime-ambience.ogg",
                                                             AudioClipKind::Ambience)));

    AudioPreviewAdapter preview(audio, assets);
    REQUIRE(preview.play_sfx("project:/preview-sfx.ogg"));
    REQUIRE(preview.play_track("ambience", "project:/preview-ambience.ogg"));
    REQUIRE(executor.run_until_idle(16));
    preview.update();
    preview.stop_all();

    CHECK_FALSE(preview.track_active("ambience"));
    CHECK(audio.track_active("ambience"));
}

} // namespace
} // namespace noveltea::host
