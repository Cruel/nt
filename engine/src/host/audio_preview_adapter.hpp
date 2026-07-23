#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/audio/audio_system.hpp"
#include "noveltea/core/diagnostic.hpp"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea::host {

class AudioPreviewAdapter final {
public:
    AudioPreviewAdapter(AudioSystem& audio, assets::AssetManager& assets) noexcept;
    ~AudioPreviewAdapter();

    AudioPreviewAdapter(const AudioPreviewAdapter&) = delete;
    AudioPreviewAdapter& operator=(const AudioPreviewAdapter&) = delete;

    [[nodiscard]] AudioVoiceHandle play_sfx(const std::string& path, float volume = 1.0f,
                                            float pitch = 1.0f);
    [[nodiscard]] AudioTrackHandle play_track(const AudioTrackId& track_id, const std::string& path,
                                              float volume = 1.0f, bool loop = true);
    void stop_track(const AudioTrackId& track_id, float fade_seconds = 0.0f);
    void stop_all(float fade_seconds = 0.0f);
    [[nodiscard]] bool track_active(const AudioTrackId& track_id) const noexcept;
    void update();
    [[nodiscard]] core::Diagnostics take_diagnostics();

private:
    struct PendingSfx {
        assets::AssetRequestHandle<assets::AudioAsset> request;
        AudioPlaybackDesc playback;
        std::string path;
    };

    struct PendingTrack {
        assets::AssetRequestHandle<assets::AudioAsset> request;
        AudioTrackId tooling_id;
        AudioTrackId backend_id;
        AudioTrackDesc playback;
        std::string path;
    };

    [[nodiscard]] static AudioTrackId normalize_track_id(const AudioTrackId& track_id);
    [[nodiscard]] const AudioTrackId& preview_track_id(const AudioTrackId& track_id);
    void append_request_diagnostics(const std::string& operation, const std::string& path,
                                    core::Diagnostics diagnostics);

    AudioSystem& m_audio;
    assets::AssetManager& m_assets;
    std::unordered_map<AudioTrackId, AudioTrackId> m_preview_tracks;
    std::vector<AudioVoiceHandle> m_preview_sfx;
    std::vector<PendingSfx> m_pending_sfx;
    std::vector<PendingTrack> m_pending_tracks;
    core::Diagnostics m_diagnostics;
    std::uint32_t m_next_request_token = 1;
    std::uint64_t m_next_track_id = 1;
};

} // namespace noveltea::host
