#include "host/audio_preview_adapter.hpp"

#include <algorithm>
#include <string>
#include <utility>

namespace noveltea::host {

AudioPreviewAdapter::AudioPreviewAdapter(AudioSystem& audio, assets::AssetManager& assets) noexcept
    : m_audio(audio), m_assets(assets)
{
}

AudioPreviewAdapter::~AudioPreviewAdapter() { stop_all(); }

AudioVoiceHandle AudioPreviewAdapter::play_sfx(const std::string& path, float volume, float pitch)
{
    if (path.empty())
        return {};
    auto requested = m_assets.request_audio(
        {.path = path, .mode = AudioLoadMode::Auto, .kind = AudioClipKind::Sfx},
        assets::AssetRequestReason::Demand);
    if (!requested) {
        auto diagnostic = std::move(requested).error();
        diagnostic.message =
            "Editor-preview SFX request failed for '" + path + "': " + diagnostic.message;
        m_diagnostics.push_back(std::move(diagnostic));
        return {};
    }

    AudioPlaybackDesc playback{
        .bus = AudioBus::Sfx, .volume = volume, .pitch = pitch, .loop = false};
    m_pending_sfx.push_back(
        {.request = std::move(*requested.value_if()), .playback = playback, .path = path});
    const std::uint32_t token = m_next_request_token++;
    if (m_next_request_token == 0)
        m_next_request_token = 1;
    return AudioVoiceHandle{token};
}

AudioTrackHandle AudioPreviewAdapter::play_track(const AudioTrackId& track_id,
                                                 const std::string& path, float volume, bool loop)
{
    if (path.empty())
        return {};
    const AudioTrackId tooling_id = normalize_track_id(track_id);
    const AudioTrackId backend_id = preview_track_id(tooling_id);
    auto requested = m_assets.request_audio(
        {.path = path, .mode = AudioLoadMode::Auto, .kind = AudioClipKind::Music},
        assets::AssetRequestReason::Demand);
    if (!requested) {
        auto diagnostic = std::move(requested).error();
        diagnostic.message =
            "Editor-preview track request failed for '" + path + "': " + diagnostic.message;
        m_diagnostics.push_back(std::move(diagnostic));
        return {};
    }

    AudioTrackDesc playback{.track_id = backend_id, .volume = volume, .loop = loop};
    m_pending_tracks.push_back({.request = std::move(*requested.value_if()),
                                .tooling_id = tooling_id,
                                .backend_id = backend_id,
                                .playback = playback,
                                .path = path});
    const std::uint32_t token = m_next_request_token++;
    if (m_next_request_token == 0)
        m_next_request_token = 1;
    return AudioTrackHandle{token};
}

void AudioPreviewAdapter::stop_track(const AudioTrackId& track_id, float fade_seconds)
{
    const auto tooling_id = normalize_track_id(track_id);
    std::erase_if(m_pending_tracks, [&](PendingTrack& pending) {
        if (pending.tooling_id != tooling_id)
            return false;
        pending.request.cancel();
        return true;
    });
    const auto found = m_preview_tracks.find(tooling_id);
    if (found != m_preview_tracks.end())
        m_audio.stop_track(found->second, fade_seconds);
}

void AudioPreviewAdapter::stop_all(float fade_seconds)
{
    for (const auto voice : m_preview_sfx)
        m_audio.stop(voice);
    m_preview_sfx.clear();
    for (auto& pending : m_pending_sfx)
        pending.request.cancel();
    m_pending_sfx.clear();
    for (auto& pending : m_pending_tracks)
        pending.request.cancel();
    m_pending_tracks.clear();

    for (const auto& [tooling_id, backend_id] : m_preview_tracks) {
        (void)tooling_id;
        m_audio.stop_track(backend_id, fade_seconds);
    }
    m_preview_tracks.clear();
}

bool AudioPreviewAdapter::track_active(const AudioTrackId& track_id) const noexcept
{
    const auto tooling_id = normalize_track_id(track_id);
    if (std::any_of(
            m_pending_tracks.begin(), m_pending_tracks.end(),
            [&](const PendingTrack& pending) { return pending.tooling_id == tooling_id; })) {
        return true;
    }
    const auto found = m_preview_tracks.find(tooling_id);
    return found != m_preview_tracks.end() && m_audio.track_active(found->second);
}

void AudioPreviewAdapter::update()
{
    for (auto pending = m_pending_sfx.begin(); pending != m_pending_sfx.end();) {
        const auto state = pending->request.state();
        if (state == assets::AssetRequestState::Pending) {
            ++pending;
            continue;
        }
        if (state == assets::AssetRequestState::Ready) {
            auto lease = std::move(pending->request).take_ready();
            if (lease) {
                const auto voice = m_audio.play(std::move(*lease), pending->playback);
                if (voice)
                    m_preview_sfx.push_back(voice);
                else
                    m_diagnostics.push_back(
                        {.code = "preview_audio.sfx_play_failed",
                         .message = "Audio backend could not start editor-preview SFX '" +
                                    pending->path + "'"});
            }
        } else {
            append_request_diagnostics("SFX", pending->path, pending->request.diagnostics());
        }
        pending = m_pending_sfx.erase(pending);
    }

    for (auto pending = m_pending_tracks.begin(); pending != m_pending_tracks.end();) {
        const auto state = pending->request.state();
        if (state == assets::AssetRequestState::Pending) {
            ++pending;
            continue;
        }
        if (state == assets::AssetRequestState::Ready) {
            auto lease = std::move(pending->request).take_ready();
            if (!lease ||
                !m_audio.play_track(pending->backend_id, std::move(*lease), pending->playback)) {
                m_diagnostics.push_back(
                    {.code = "preview_audio.track_play_failed",
                     .message = "Audio backend could not start editor-preview track '" +
                                pending->path + "'"});
            }
        } else {
            append_request_diagnostics("track", pending->path, pending->request.diagnostics());
        }
        pending = m_pending_tracks.erase(pending);
    }
}

core::Diagnostics AudioPreviewAdapter::take_diagnostics()
{
    auto diagnostics = std::move(m_diagnostics);
    m_diagnostics.clear();
    return diagnostics;
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

void AudioPreviewAdapter::append_request_diagnostics(const std::string& operation,
                                                     const std::string& path,
                                                     core::Diagnostics diagnostics)
{
    if (diagnostics.empty()) {
        diagnostics.push_back(
            {.code = "preview_audio.request_failed",
             .message = "Editor-preview " + operation + " request failed for '" + path + "'"});
    }
    for (auto& diagnostic : diagnostics) {
        diagnostic.message =
            "Editor-preview " + operation + " request for '" + path + "': " + diagnostic.message;
        m_diagnostics.push_back(std::move(diagnostic));
    }
}

} // namespace noveltea::host
