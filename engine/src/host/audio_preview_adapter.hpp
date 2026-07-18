#pragma once

#include "noveltea/audio/audio_system.hpp"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea::host {

class AudioPreviewAdapter final {
public:
    explicit AudioPreviewAdapter(AudioSystem& audio) noexcept;
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

private:
    [[nodiscard]] static AudioTrackId normalize_track_id(const AudioTrackId& track_id);
    [[nodiscard]] const AudioTrackId& preview_track_id(const AudioTrackId& track_id);

    AudioSystem& m_audio;
    std::unordered_map<AudioTrackId, AudioTrackId> m_preview_tracks;
    std::vector<AudioVoiceHandle> m_preview_sfx;
    std::uint64_t m_next_track_id = 1;
};

} // namespace noveltea::host
