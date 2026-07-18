#include "host/audio_preview_adapter.hpp"

#include <string>
#include <utility>

namespace noveltea::host {

AudioPreviewAdapter::AudioPreviewAdapter(AudioSystem& audio) noexcept : m_audio(audio) {}

AudioPreviewAdapter::~AudioPreviewAdapter() { stop_all(); }

AudioVoiceHandle AudioPreviewAdapter::play_sfx(const std::string& path, float volume, float pitch)
{
    if (path.empty())
        return {};
    const AudioVoiceHandle voice =
        m_audio.play_sfx(path, AudioSfxDesc{.volume = volume, .pitch = pitch});
    if (voice)
        m_preview_sfx.push_back(voice);
    return voice;
}

AudioTrackHandle AudioPreviewAdapter::play_track(const AudioTrackId& track_id,
                                                 const std::string& path, float volume, bool loop)
{
    if (path.empty())
        return {};
    const auto& preview_id = preview_track_id(track_id);
    return m_audio.play_track(
        preview_id, path, AudioTrackDesc{.track_id = preview_id, .volume = volume, .loop = loop});
}

void AudioPreviewAdapter::stop_track(const AudioTrackId& track_id, float fade_seconds)
{
    const auto found = m_preview_tracks.find(normalize_track_id(track_id));
    if (found != m_preview_tracks.end())
        m_audio.stop_track(found->second, fade_seconds);
}

void AudioPreviewAdapter::stop_all(float fade_seconds)
{
    for (const auto voice : m_preview_sfx)
        m_audio.stop(voice);
    m_preview_sfx.clear();

    for (const auto& [tooling_id, backend_id] : m_preview_tracks) {
        (void)tooling_id;
        m_audio.stop_track(backend_id, fade_seconds);
    }
    m_preview_tracks.clear();
}

bool AudioPreviewAdapter::track_active(const AudioTrackId& track_id) const noexcept
{
    const auto found = m_preview_tracks.find(normalize_track_id(track_id));
    return found != m_preview_tracks.end() && m_audio.track_active(found->second);
}

AudioTrackId AudioPreviewAdapter::normalize_track_id(const AudioTrackId& track_id)
{
    return track_id.empty() ? AudioTrackId{"bgm"} : track_id;
}

const AudioTrackId& AudioPreviewAdapter::preview_track_id(const AudioTrackId& track_id)
{
    const AudioTrackId tooling_id = normalize_track_id(track_id);
    const auto found = m_preview_tracks.find(tooling_id);
    if (found != m_preview_tracks.end())
        return found->second;

    auto [inserted, unused] = m_preview_tracks.emplace(
        tooling_id, "__noveltea_tooling_preview_audio__/" + std::to_string(m_next_track_id++));
    (void)unused;
    return inserted->second;
}

} // namespace noveltea::host
