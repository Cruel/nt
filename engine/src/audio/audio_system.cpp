#include "noveltea/audio/audio_system.hpp"

#include "noveltea/assets/asset_manager.hpp"

#include <algorithm>
#include <cstdio>
#include <utility>

namespace noveltea {
namespace {

float clamp_volume(float value)
{
    if (value < 0.0f)
        return 0.0f;
    if (value > 1.0f)
        return 1.0f;
    return value;
}

template<class T> assets::AssetLoadResult<T> fail(std::string message)
{
    return {std::nullopt, std::move(message)};
}

} // namespace

std::unique_ptr<assets::AssetPreparationTask<assets::AudioAsset>>
AudioBackend::create_audio_preparation_task(const assets::AssetManager&,
                                            const assets::AudioAssetRequest&)
{
    return {};
}

AudioSystem::AudioSystem() = default;
AudioSystem::AudioSystem(std::unique_ptr<AudioBackend> backend) : m_backend(std::move(backend)) {}
AudioSystem::~AudioSystem() { shutdown(); }
AudioSystem::AudioSystem(AudioSystem&&) noexcept = default;
AudioSystem& AudioSystem::operator=(AudioSystem&&) noexcept = default;

void AudioSystem::set_backend(std::unique_ptr<AudioBackend> backend)
{
    shutdown();
    m_backend = std::move(backend);
}

core::DiagnosticResult<void> AudioSystem::initialize(const assets::AssetManager& assets,
                                                     const jobs::JobExecutionConfig& job_execution)
{
    shutdown();
    m_assets = &assets;
    if (!m_backend) {
        m_assets = nullptr;
        return core::DiagnosticResult<void>::failure(core::Diagnostic{
            .code = "audio.backend_missing",
            .message = "No audio backend is configured.",
            .severity = core::ErrorSeverity::Fatal,
        });
    }
    auto initialized = m_backend->initialize(assets, job_execution);
    if (!initialized) {
        m_assets = nullptr;
        return initialized;
    }
    m_initialized = true;
    return core::DiagnosticResult<void>::success();
}

void AudioSystem::shutdown()
{
    m_sfx_voices.clear();
    m_tracks.clear();
    m_voice_leases.clear();
    if (m_backend) {
        m_backend->shutdown();
    }
    m_assets = nullptr;
    m_initialized = false;
    m_paused = false;
}

AudioBackendInfo AudioSystem::backend_info() const
{
    if (!m_backend)
        return {};
    return m_backend->backend_info();
}

AudioBackendStats AudioSystem::backend_stats() const
{
    if (!m_backend)
        return {};
    return m_backend->stats();
}

assets::AssetLoadResult<assets::AudioAsset>
AudioSystem::load_audio(const assets::AudioAssetRequest& request)
{
    if (!m_backend || !m_initialized) {
        return fail<assets::AudioAsset>("audio backend is not initialized");
    }
    return m_backend->load_audio(request);
}

std::unique_ptr<assets::AssetPreparationTask<assets::AudioAsset>>
AudioSystem::create_audio_preparation_task(const assets::AudioAssetRequest& request)
{
    if (!m_backend || !m_initialized || m_assets == nullptr)
        return {};
    return m_backend->create_audio_preparation_task(*m_assets, request);
}

AudioVoiceHandle AudioSystem::play_clip(AudioClipHandle clip, AudioPlaybackDesc desc)
{
    if (!m_backend || !m_initialized || m_paused || !clip)
        return {};
    desc.volume = clamp_volume(desc.volume);
    return m_backend->play(clip, desc);
}

AudioVoiceHandle AudioSystem::play(assets::AssetLease<assets::AudioAsset> asset,
                                   AudioPlaybackDesc desc)
{
    if (!asset)
        return {};
    asset.mark_used_on_owner();
    const auto clip = asset->clip;
    const auto voice = play_clip(clip, desc);
    if (voice)
        m_voice_leases.emplace(voice.id, std::move(asset));
    return voice;
}

void AudioSystem::stop(AudioVoiceHandle voice)
{
    if (m_backend && m_initialized && voice) {
        m_backend->stop(voice);
    }
}

void AudioSystem::set_volume(AudioVoiceHandle voice, float volume)
{
    if (m_backend && m_initialized && voice) {
        m_backend->set_volume(voice, clamp_volume(volume));
    }
}

void AudioSystem::set_bus_volume(AudioBus bus, float volume)
{
    if (m_backend && m_initialized) {
        m_backend->set_bus_volume(bus, clamp_volume(volume));
    }
}

void AudioSystem::pause()
{
    if (m_backend && m_initialized && !m_paused) {
        m_backend->pause();
        m_paused = true;
    }
}

void AudioSystem::resume()
{
    if (m_backend && m_initialized && m_paused) {
        m_backend->resume();
        m_paused = false;
    }
}

AudioTrackHandle AudioSystem::play_track(const AudioTrackId& track_id,
                                         assets::AssetLease<assets::AudioAsset> asset,
                                         AudioTrackDesc desc)
{
    if (!asset)
        return {};

    AudioTrackId id = track_id.empty() ? desc.track_id : track_id;
    if (id.empty())
        id = "bgm";
    desc.track_id = id;

    auto& voices = m_tracks[id];
    if (desc.replace_mode == AudioTrackReplaceMode::Replace) {
        for (auto& voice : voices)
            fade_voice(voice, 0.0f, desc.fade_out_seconds, true);
    }

    const std::string path = asset->path;
    AudioPlaybackDesc playback;
    playback.bus = desc.bus;
    playback.volume = desc.fade_in_seconds > 0.0f ? 0.0f : clamp_volume(desc.volume);
    playback.pitch = desc.pitch;
    playback.loop = desc.loop;
    const AudioVoiceHandle voice = play(std::move(asset), playback);
    if (!voice)
        return {};

    ManagedVoice managed{.voice = voice,
                         .path = path,
                         .base_volume = clamp_volume(desc.volume),
                         .current_volume = playback.volume,
                         .fade_from = playback.volume,
                         .fade_to = clamp_volume(desc.volume)};
    if (desc.fade_in_seconds > 0.0f)
        fade_voice(managed, managed.base_volume, desc.fade_in_seconds, false);
    voices.push_back(std::move(managed));
    return AudioTrackHandle{m_next_track_handle++};
}

void AudioSystem::stop_track(const AudioTrackId& track_id, float fade_seconds)
{
    auto it = m_tracks.find(track_id.empty() ? AudioTrackId{"bgm"} : track_id);
    if (it == m_tracks.end())
        return;
    for (auto& voice : it->second) {
        fade_voice(voice, 0.0f, fade_seconds, true);
    }
}

bool AudioSystem::track_active(const AudioTrackId& track_id) const noexcept
{
    if (!m_backend || !m_initialized)
        return false;
    const auto found = m_tracks.find(track_id.empty() ? AudioTrackId{"bgm"} : track_id);
    if (found == m_tracks.end())
        return false;
    return std::any_of(
        found->second.begin(), found->second.end(),
        [this](const ManagedVoice& voice) { return m_backend->voice_active(voice.voice); });
}

void AudioSystem::update(float dt)
{
    if (dt < 0.0f)
        dt = 0.0f;

    auto update_voice = [&](ManagedVoice& voice) {
        if (voice.fade_duration > 0.0f) {
            voice.fade_elapsed = std::min(voice.fade_duration, voice.fade_elapsed + dt);
            const float t = voice.fade_elapsed / voice.fade_duration;
            voice.current_volume = voice.fade_from + (voice.fade_to - voice.fade_from) * t;
            set_volume(voice.voice, voice.current_volume);
            if (voice.fade_elapsed >= voice.fade_duration) {
                voice.fade_duration = 0.0f;
                voice.current_volume = voice.fade_to;
                set_volume(voice.voice, voice.current_volume);
                if (voice.stop_after_fade) {
                    stop(voice.voice);
                }
            }
        }
    };

    for (auto& voice : m_sfx_voices) {
        update_voice(voice);
    }
    for (auto& [id, voices] : m_tracks) {
        (void)id;
        for (auto& voice : voices) {
            update_voice(voice);
        }
    }
    cleanup_inactive();
    if (m_backend && m_initialized) {
        m_backend->collect_finished_voices();
    }
}

void AudioSystem::fade_voice(ManagedVoice& voice, float target, float seconds, bool stop_after_fade)
{
    target = clamp_volume(target);
    if (seconds <= 0.0f) {
        voice.fade_duration = 0.0f;
        voice.current_volume = target;
        set_volume(voice.voice, target);
        if (stop_after_fade) {
            stop(voice.voice);
        }
        voice.stop_after_fade = stop_after_fade;
        return;
    }
    voice.fade_from = voice.current_volume;
    voice.fade_to = target;
    voice.fade_elapsed = 0.0f;
    voice.fade_duration = seconds;
    voice.stop_after_fade = stop_after_fade;
}

void AudioSystem::cleanup_inactive()
{
    if (!m_backend || !m_initialized) {
        m_sfx_voices.clear();
        m_tracks.clear();
        m_voice_leases.clear();
        return;
    }

    auto active = [&](const ManagedVoice& voice) { return m_backend->voice_active(voice.voice); };
    m_sfx_voices.erase(std::remove_if(m_sfx_voices.begin(), m_sfx_voices.end(),
                                      [&](const ManagedVoice& voice) { return !active(voice); }),
                       m_sfx_voices.end());

    for (auto track_it = m_tracks.begin(); track_it != m_tracks.end();) {
        auto& voices = track_it->second;
        voices.erase(std::remove_if(voices.begin(), voices.end(),
                                    [&](const ManagedVoice& voice) { return !active(voice); }),
                     voices.end());
        if (voices.empty()) {
            track_it = m_tracks.erase(track_it);
        } else {
            ++track_it;
        }
    }

    for (auto lease_it = m_voice_leases.begin(); lease_it != m_voice_leases.end();) {
        if (!m_backend->voice_active(AudioVoiceHandle{lease_it->first}))
            lease_it = m_voice_leases.erase(lease_it);
        else
            ++lease_it;
    }
}

} // namespace noveltea
