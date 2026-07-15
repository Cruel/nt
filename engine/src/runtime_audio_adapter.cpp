#include "noveltea/runtime_audio_adapter.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>
#include <utility>

namespace noveltea {
namespace {

core::Diagnostic audio_error(std::string code, std::string message)
{
    return core::Diagnostic{.code = std::move(code), .message = std::move(message)};
}

AudioBus audio_bus(core::compiled::AudioChannel channel) noexcept
{
    switch (channel) {
    case core::compiled::AudioChannel::SoundEffect:
        return AudioBus::Sfx;
    case core::compiled::AudioChannel::Music:
        return AudioBus::Music;
    case core::compiled::AudioChannel::Voice:
        return AudioBus::Voice;
    case core::compiled::AudioChannel::Ambient:
        return AudioBus::Ambience;
    }
    return AudioBus::Sfx;
}

std::string channel_name(core::compiled::AudioChannel channel)
{
    switch (channel) {
    case core::compiled::AudioChannel::SoundEffect:
        return "sound-effect";
    case core::compiled::AudioChannel::Music:
        return "music";
    case core::compiled::AudioChannel::Voice:
        return "voice";
    case core::compiled::AudioChannel::Ambient:
        return "ambient";
    }
    return "invalid";
}

AudioTrackId operation_track_id(const core::AudioOperation& operation)
{
    return "noveltea.runtime." + channel_name(operation.channel) + "." +
           std::to_string(operation.id.number());
}

float seconds(std::chrono::milliseconds duration) noexcept
{
    return static_cast<float>(duration.count()) / 1000.0F;
}

} // namespace

core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>
RuntimeAudioAdapter::apply(const core::AudioOperation& operation)
{
    using Result = core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>;
    if (operation.channel > core::compiled::AudioChannel::Ambient ||
        operation.action > core::compiled::AudioAction::FadeOut || operation.fade.count() < 0 ||
        !std::isfinite(operation.volume) || operation.volume < 0.0 || operation.volume > 1.0 ||
        operation.owner.has_value() != operation.completion.has_value()) {
        return Result::failure(audio_error("runtime_audio.invalid_operation",
                                           "Typed audio operation contains invalid state"));
    }

    const bool playing = operation.action == core::compiled::AudioAction::Play ||
                         operation.action == core::compiled::AudioAction::FadeIn;
    if (playing) {
        if (!operation.asset) {
            return Result::failure(audio_error("runtime_audio.asset_required",
                                               "Typed audio playback requires an Asset ID"));
        }
        const auto path = m_assets.resolve(*operation.asset);
        if (!path) {
            return Result::failure(audio_error("runtime_audio.asset_unavailable",
                                               "Typed audio Asset cannot be resolved"));
        }
        const auto track = operation_track_id(operation);
        AudioTrackDesc desc{.track_id = track,
                            .bus = audio_bus(operation.channel),
                            .volume = static_cast<float>(operation.volume),
                            .pitch = 1.0F,
                            .loop = operation.loop,
                            .fade_in_seconds =
                                operation.action == core::compiled::AudioAction::FadeIn
                                    ? seconds(operation.fade)
                                    : 0.0F,
                            .fade_out_seconds = 0.0F,
                            .replace_mode = AudioTrackReplaceMode::Replace};
        if (!m_audio.play_track(track, *path, desc)) {
            return Result::failure(audio_error("runtime_audio.play_failed",
                                               "Audio backend could not start typed playback"));
        }
        const bool report_termination =
            !operation.completion &&
            (operation.channel == core::compiled::AudioChannel::Voice ||
             operation.channel == core::compiled::AudioChannel::SoundEffect);
        m_active.push_back(ActiveTrack{operation.channel, track,
                                       report_termination
                                           ? std::optional<core::AudioOperationId>{operation.id}
                                           : std::nullopt});

        if (!operation.owner || !operation.completion || !m_audio.track_active(track))
            return Result::success(TypedRuntimeOperationDisposition::Completed);

        m_pending.push_back(PendingCompletion{
            core::CompleteAudioInput{operation.id, *operation.owner, *operation.completion},
            {track}});
        return Result::success(TypedRuntimeOperationDisposition::Pending);
    } else {
        if (operation.asset) {
            return Result::failure(audio_error("runtime_audio.unexpected_asset",
                                               "Typed audio stop must not include an Asset ID"));
        }
        std::vector<AudioTrackId> stopped_tracks;
        for (const auto& active : m_active) {
            if (active.channel != operation.channel)
                continue;
            stopped_tracks.push_back(active.track);
            m_audio.stop_track(active.track,
                               operation.action == core::compiled::AudioAction::FadeOut
                                   ? seconds(operation.fade)
                                   : 0.0F);
        }

        if (!operation.owner || !operation.completion || stopped_tracks.empty())
            return Result::success(TypedRuntimeOperationDisposition::Completed);

        const bool any_active =
            std::any_of(stopped_tracks.begin(), stopped_tracks.end(),
                        [this](const AudioTrackId& track) { return m_audio.track_active(track); });
        if (!any_active)
            return Result::success(TypedRuntimeOperationDisposition::Completed);

        m_pending.push_back(PendingCompletion{
            core::CompleteAudioInput{operation.id, *operation.owner, *operation.completion},
            std::move(stopped_tracks)});
        return Result::success(TypedRuntimeOperationDisposition::Pending);
    }
}

std::vector<core::CompleteAudioInput> RuntimeAudioAdapter::take_completions()
{
    std::vector<core::CompleteAudioInput> completed;
    std::erase_if(m_active, [this](const ActiveTrack& active) {
        if (m_audio.track_active(active.track))
            return false;
        if (active.termination)
            m_terminated.push_back(core::AcknowledgeAudioTerminationInput{*active.termination});
        return true;
    });
    for (auto pending = m_pending.begin(); pending != m_pending.end();) {
        const bool any_active =
            std::any_of(pending->tracks.begin(), pending->tracks.end(),
                        [this](const AudioTrackId& track) { return m_audio.track_active(track); });
        if (any_active) {
            ++pending;
            continue;
        }
        completed.push_back(pending->input);
        pending = m_pending.erase(pending);
    }
    return completed;
}

std::vector<core::AcknowledgeAudioTerminationInput> RuntimeAudioAdapter::take_terminations()
{
    auto terminated = std::move(m_terminated);
    m_terminated.clear();
    return terminated;
}

void RuntimeAudioAdapter::reset()
{
    m_pending.clear();
    m_terminated.clear();
    for (const auto& active : m_active)
        m_audio.stop_track(active.track);
    m_active.clear();
}

} // namespace noveltea
