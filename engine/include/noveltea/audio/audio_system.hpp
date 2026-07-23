#pragma once

#include "noveltea/audio/audio_backend.hpp"

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea {

class AudioSystem final : public assets::AudioAssetLoader {
public:
    AudioSystem();
    explicit AudioSystem(std::unique_ptr<AudioBackend> backend);
    ~AudioSystem() override;

    AudioSystem(const AudioSystem&) = delete;
    AudioSystem& operator=(const AudioSystem&) = delete;
    AudioSystem(AudioSystem&&) noexcept;
    AudioSystem& operator=(AudioSystem&&) noexcept;

    void set_backend(std::unique_ptr<AudioBackend> backend);
    [[nodiscard]] core::DiagnosticResult<void>
    initialize(const assets::AssetManager& assets,
               const jobs::JobExecutionConfig& job_execution = {});
    void shutdown();
    [[nodiscard]] AudioBackendInfo backend_info() const;
    [[nodiscard]] AudioBackendStats backend_stats() const;

    [[nodiscard]] assets::AssetLoadResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override;

    [[nodiscard]] AudioVoiceHandle play(AudioClipHandle clip, AudioPlaybackDesc desc = {});
    void stop(AudioVoiceHandle voice);
    void set_volume(AudioVoiceHandle voice, float volume);
    void set_bus_volume(AudioBus bus, float volume);
    void pause();
    void resume();
    [[nodiscard]] bool paused() const noexcept { return m_paused; }

    [[nodiscard]] AudioVoiceHandle play_sfx(const std::string& path, AudioSfxDesc desc = {});
    [[nodiscard]] AudioVoiceHandle play_sfx_alias(const std::string& alias, AudioSfxDesc desc = {});
    [[nodiscard]] AudioTrackHandle play_track(const AudioTrackId& track_id, const std::string& path,
                                              AudioTrackDesc desc = {});
    [[nodiscard]] AudioTrackHandle play_track_alias(const AudioTrackId& track_id,
                                                    const std::string& alias,
                                                    AudioTrackDesc desc = {});
    void stop_track(const AudioTrackId& track_id, float fade_seconds = 0.0f);
    [[nodiscard]] bool track_active(const AudioTrackId& track_id) const noexcept;

    void update(float dt);

private:
    struct ManagedVoice {
        AudioVoiceHandle voice;
        std::string path;
        float base_volume = 1.0f;
        float current_volume = 1.0f;
        float fade_from = 1.0f;
        float fade_to = 1.0f;
        float fade_elapsed = 0.0f;
        float fade_duration = 0.0f;
        bool stop_after_fade = false;
        bool sfx = false;
    };

    void fade_voice(ManagedVoice& voice, float target, float seconds, bool stop_after_fade);
    void cleanup_inactive();

    std::unique_ptr<AudioBackend> m_backend;
    const assets::AssetManager* m_assets = nullptr;
    bool m_initialized = false;
    bool m_paused = false;
    uint32_t m_next_track_handle = 1;
    std::vector<ManagedVoice> m_sfx_voices;
    std::unordered_map<AudioTrackId, std::vector<ManagedVoice>> m_tracks;
};

} // namespace noveltea
