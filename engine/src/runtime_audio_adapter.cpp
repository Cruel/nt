#include "noveltea/runtime_audio_adapter.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>
#include <type_traits>
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

bool desired_key_equal(const core::PresentationDesiredAudio& left,
                       const core::PresentationDesiredAudio& right) noexcept
{
    return left.instance == right.instance && left.owner == right.owner;
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
            (!operation.loop || operation.channel == core::compiled::AudioChannel::Voice ||
             operation.channel == core::compiled::AudioChannel::SoundEffect);
        m_active.push_back(ActiveTrack{operation.id, operation.channel, track,
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
        const auto matches_transient = [&operation](const ActiveTrack& active) {
            return std::visit(
                [&](const auto& target) {
                    using T = std::decay_t<decltype(target)>;
                    if constexpr (std::is_same_v<T, core::AudioPlaybackOperationTarget>)
                        return active.operation == target.operation;
                    else if constexpr (std::is_same_v<T, core::AudioBusOperationTarget>)
                        return active.channel == target.bus;
                    else
                        return false;
                },
                operation.target);
        };
        for (const auto& active : m_active) {
            if (!matches_transient(active))
                continue;
            stopped_tracks.push_back(active.track);
            m_audio.stop_track(active.track,
                               operation.action == core::compiled::AudioAction::FadeOut
                                   ? seconds(operation.fade)
                                   : 0.0F);
        }
        const auto matches_desired = [&operation](const RealizedDesiredTrack& desired) {
            const auto* target = std::get_if<core::DesiredAudioOperationTarget>(&operation.target);
            return target != nullptr && desired.desired.instance == target->instance &&
                   desired.desired.owner == target->owner;
        };
        for (const auto& desired : m_desired) {
            const bool matches = matches_desired(desired);
            if (!matches)
                continue;
            stopped_tracks.push_back(desired.track);
            m_audio.stop_track(desired.track,
                               operation.action == core::compiled::AudioAction::FadeOut
                                   ? seconds(operation.fade)
                                   : 0.0F);
        }
        std::erase_if(m_desired, matches_desired);

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

core::Result<void, core::Diagnostics>
RuntimeAudioAdapter::reconcile_desired(const std::vector<core::PresentationDesiredAudio>& desired)
{
    struct PendingStart {
        core::PresentationDesiredAudio desired;
        std::string path;
        AudioTrackId track;
    };
    std::vector<PendingStart> starts;
    for (const auto& candidate : desired) {
        const auto current = std::find_if(m_desired.begin(), m_desired.end(),
                                          [&candidate](const RealizedDesiredTrack& value) {
                                              return desired_key_equal(value.desired, candidate);
                                          });
        if (current != m_desired.end() && current->desired == candidate)
            continue;
        const auto path = m_assets.resolve(candidate.asset);
        if (!path)
            return core::Result<void, core::Diagnostics>::failure(
                {audio_error("runtime_audio.desired_asset_unavailable",
                             "Desired audio Asset cannot be resolved")});
        starts.push_back(PendingStart{candidate, *path,
                                      "noveltea.runtime.desired." + candidate.instance.text() +
                                          "." + std::to_string(m_next_desired_track++)});
    }

    std::vector<AudioTrackId> started_tracks;
    for (const auto& start : starts) {
        AudioTrackDesc desc{.track_id = start.track,
                            .bus = audio_bus(start.desired.bus),
                            .volume = static_cast<float>(start.desired.volume),
                            .pitch = 1.0F,
                            .loop = true,
                            .fade_in_seconds = seconds(start.desired.fade_in),
                            .fade_out_seconds = seconds(start.desired.fade_out),
                            .replace_mode = AudioTrackReplaceMode::Replace};
        if (!m_audio.play_track(start.track, start.path, desc)) {
            for (const auto& track : started_tracks)
                m_audio.stop_track(track);
            return core::Result<void, core::Diagnostics>::failure(
                {audio_error("runtime_audio.desired_play_failed",
                             "Audio backend could not realize desired looping playback")});
        }
        started_tracks.push_back(start.track);
    }

    for (const auto& current : m_desired) {
        const auto target = std::find_if(desired.begin(), desired.end(),
                                         [&current](const core::PresentationDesiredAudio& value) {
                                             return desired_key_equal(current.desired, value);
                                         });
        if (target == desired.end() || *target != current.desired)
            m_audio.stop_track(current.track, seconds(current.desired.fade_out));
    }

    std::vector<RealizedDesiredTrack> realized;
    realized.reserve(desired.size());
    for (const auto& candidate : desired) {
        const auto current = std::find_if(
            m_desired.begin(), m_desired.end(), [&candidate](const RealizedDesiredTrack& value) {
                return desired_key_equal(value.desired, candidate) && value.desired == candidate;
            });
        if (current != m_desired.end()) {
            realized.push_back(*current);
            continue;
        }
        const auto started =
            std::find_if(starts.begin(), starts.end(), [&candidate](const PendingStart& value) {
                return desired_key_equal(value.desired, candidate);
            });
        if (started != starts.end())
            realized.push_back(RealizedDesiredTrack{candidate, started->track});
    }
    m_desired = std::move(realized);
    return core::Result<void, core::Diagnostics>::success();
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

void RuntimeAudioAdapter::snap_operation(core::AudioOperationId operation) noexcept
{
    for (const auto& active : m_active) {
        if (active.operation == operation || active.termination == operation)
            m_audio.stop_track(active.track);
    }
    for (const auto& pending : m_pending) {
        if (pending.input.operation != operation)
            continue;
        for (const auto& track : pending.tracks)
            m_audio.stop_track(track);
    }
}

void RuntimeAudioAdapter::reset(
    [[maybe_unused]] core::PresentationCancellationReason reason) noexcept
{
    m_pending.clear();
    m_terminated.clear();
    for (const auto& active : m_active)
        m_audio.stop_track(active.track);
    m_active.clear();
    for (const auto& desired : m_desired)
        m_audio.stop_track(desired.track);
    m_desired.clear();
}

} // namespace noveltea
