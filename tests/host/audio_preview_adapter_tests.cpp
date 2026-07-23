#include "host/audio_preview_adapter.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/audio/audio_backend.hpp"

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
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

    assets::AssetResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override
    {
        return {assets::AudioAsset{.clip = AudioClipHandle{next_clip++},
                                   .path = request.path,
                                   .mode = request.mode,
                                   .kind = request.kind},
                {}};
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

TEST_CASE("preview audio track controls cannot replace or stop gameplay track identity")
{
    assets::AssetManager assets;
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);

    REQUIRE(audio.play_track("bgm", "project:/runtime.ogg"));
    REQUIRE(audio.track_active("bgm"));

    AudioPreviewAdapter preview(audio);
    REQUIRE(preview.play_track("bgm", "project:/preview.ogg"));
    REQUIRE(preview.track_active("bgm"));
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

    REQUIRE(audio.play_track("ambience", "project:/runtime-ambience.ogg"));

    AudioPreviewAdapter preview(audio);
    REQUIRE(preview.play_sfx("project:/preview-sfx.ogg"));
    REQUIRE(preview.play_track("ambience", "project:/preview-ambience.ogg"));
    preview.stop_all();

    CHECK_FALSE(preview.track_active("ambience"));
    CHECK(audio.track_active("ambience"));
}

} // namespace
} // namespace noveltea::host
