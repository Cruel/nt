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

AudioBus audio_bus(core::compiled::AudioPurpose purpose) noexcept
{
    switch (purpose) {
    case core::compiled::AudioPurpose::SoundEffect:
        return AudioBus::Sfx;
    case core::compiled::AudioPurpose::Music:
        return AudioBus::Music;
    case core::compiled::AudioPurpose::Voice:
        return AudioBus::Voice;
    case core::compiled::AudioPurpose::Ambience:
        return AudioBus::Ambience;
    case core::compiled::AudioPurpose::UiSound:
        return AudioBus::Sfx;
    }
    return AudioBus::Sfx;
}

AudioClipKind audio_kind(core::compiled::AudioPurpose purpose) noexcept
{
    switch (purpose) {
    case core::compiled::AudioPurpose::SoundEffect:
        return AudioClipKind::Sfx;
    case core::compiled::AudioPurpose::Music:
        return AudioClipKind::Music;
    case core::compiled::AudioPurpose::Voice:
        return AudioClipKind::Voice;
    case core::compiled::AudioPurpose::Ambience:
        return AudioClipKind::Ambience;
    case core::compiled::AudioPurpose::UiSound:
        return AudioClipKind::Sfx;
    }
    return AudioClipKind::Auto;
}

std::string purpose_name(core::compiled::AudioPurpose purpose)
{
    switch (purpose) {
    case core::compiled::AudioPurpose::SoundEffect:
        return "sound-effect";
    case core::compiled::AudioPurpose::Music:
        return "music";
    case core::compiled::AudioPurpose::Voice:
        return "voice";
    case core::compiled::AudioPurpose::Ambience:
        return "ambience";
    case core::compiled::AudioPurpose::UiSound:
        return "ui-sound";
    }
    return "invalid";
}

AudioTrackId operation_track_id(const core::AudioOperation& operation)
{
    return "noveltea.runtime." + purpose_name(operation.purpose) + "." +
           std::to_string(operation.id.number());
}

bool desired_key_equal(const core::PresentationDesiredAudio& left,
                       const core::PresentationDesiredAudio& right) noexcept
{
    return left.instance == right.instance && left.owner == right.owner;
}

bool desired_playback_equal(const core::PresentationDesiredAudio& left,
                            const core::PresentationDesiredAudio& right) noexcept
{
    return desired_key_equal(left, right) && left.purpose == right.purpose &&
           left.asset == right.asset;
}

float seconds(std::chrono::milliseconds duration) noexcept
{
    return static_cast<float>(duration.count()) / 1000.0F;
}

} // namespace

RuntimeAudioAdapter::~RuntimeAudioAdapter() { reset(); }

void RuntimeAudioAdapter::set_mix_settings(core::compiled::AudioMixSettings settings) noexcept
{
    m_mix_settings = std::move(settings);
    refresh_mix_and_pause();
}

void RuntimeAudioAdapter::set_gameplay_paused(bool paused) noexcept
{
    if (m_gameplay_paused == paused)
        return;
    m_gameplay_paused = paused;
    refresh_mix_and_pause();
}

float RuntimeAudioAdapter::effective_gain(core::compiled::AudioPurpose purpose,
                                          double gain) const noexcept
{
    const core::compiled::AudioPurposeMixSettings* mix = nullptr;
    switch (purpose) {
    case core::compiled::AudioPurpose::Music:
        mix = &m_mix_settings.music;
        break;
    case core::compiled::AudioPurpose::Ambience:
        mix = &m_mix_settings.ambience;
        break;
    case core::compiled::AudioPurpose::Voice:
        mix = &m_mix_settings.voice;
        break;
    case core::compiled::AudioPurpose::SoundEffect:
        mix = &m_mix_settings.sound_effect;
        break;
    case core::compiled::AudioPurpose::UiSound:
        mix = &m_mix_settings.ui_sound;
        break;
    }
    if (mix == nullptr || mix->muted)
        return 0.0F;
    double result = gain * mix->volume;
    const bool voice_active =
        std::any_of(m_active.begin(), m_active.end(), [&](const ActiveTrack& active) {
            return active.purpose == core::compiled::AudioPurpose::Voice &&
                   m_audio.track_active(active.track);
        });
    if (voice_active && m_mix_settings.voice_ducking.enabled) {
        if (purpose == core::compiled::AudioPurpose::Music)
            result *= m_mix_settings.voice_ducking.music_gain;
        else if (purpose == core::compiled::AudioPurpose::Ambience)
            result *= m_mix_settings.voice_ducking.ambience_gain;
    }
    return static_cast<float>(std::clamp(result, 0.0, 1.0));
}

bool RuntimeAudioAdapter::should_pause(core::compiled::AudioPausePolicy policy,
                                       const core::PresentationOwner& owner) const noexcept
{
    if (!m_gameplay_paused || policy == core::compiled::AudioPausePolicy::Unscaled)
        return false;
    if (policy == core::compiled::AudioPausePolicy::Gameplay)
        return true;
    return core::presentation_authority(owner) == core::PresentationAuthority::Gameplay;
}

void RuntimeAudioAdapter::refresh_mix_and_pause() noexcept
{
    for (const auto& active : m_active) {
        m_audio.set_track_volume(active.track, effective_gain(active.purpose, active.gain));
        m_audio.set_track_paused(active.track, should_pause(active.pause_policy, active.owner));
    }
    for (const auto& desired : m_desired) {
        m_audio.set_track_volume(desired.track,
                                 effective_gain(desired.desired.purpose, desired.desired.gain));
        m_audio.set_track_paused(desired.track,
                                 should_pause(desired.desired.pause_policy, desired.desired.owner));
    }
}

void RuntimeAudioAdapter::cancel_owner(const core::PresentationOwner& owner) noexcept
{
    std::erase_if(m_preparations, [&](auto& preparation) {
        if (!preparation.operation.audio_owner || *preparation.operation.audio_owner != owner)
            return false;
        if (!preparation.ready_lease)
            preparation.handle.cancel();
        return true;
    });
    std::vector<core::AudioOperationId> cancelled;
    for (const auto& active : m_active) {
        if (active.owner != owner)
            continue;
        m_audio.stop_track(active.track);
        cancelled.push_back(active.operation);
    }
    std::erase_if(m_active, [&](const ActiveTrack& active) { return active.owner == owner; });
    std::erase_if(m_pending, [&](const PendingCompletion& pending) {
        if (std::find(cancelled.begin(), cancelled.end(), pending.input.operation) ==
            cancelled.end())
            return false;
        for (const auto& track : pending.tracks)
            m_audio.stop_track(track);
        return true;
    });
    for (const auto& desired : m_desired) {
        if (desired.desired.owner == owner)
            m_audio.stop_track(desired.track);
    }
    std::erase_if(m_desired, [&](const RealizedDesiredTrack& desired) {
        return desired.desired.owner == owner;
    });
    refresh_mix_and_pause();
}

void RuntimeAudioAdapter::cancel_inactive_owners(
    std::span<const core::PresentationOwner> owners) noexcept
{
    std::vector<core::PresentationOwner> stale;
    const auto collect = [&](const core::PresentationOwner& owner) {
        if (std::find(owners.begin(), owners.end(), owner) == owners.end() &&
            std::find(stale.begin(), stale.end(), owner) == stale.end())
            stale.push_back(owner);
    };
    for (const auto& active : m_active)
        collect(active.owner);
    for (const auto& desired : m_desired)
        collect(desired.desired.owner);
    for (const auto& owner : stale)
        cancel_owner(owner);
}

core::Result<assets::AudioAssetRequest, core::Diagnostic>
RuntimeAudioAdapter::resolve_request(const core::AudioOperation& operation) const
{
    using Result = core::Result<assets::AudioAssetRequest, core::Diagnostic>;
    if (!operation.asset) {
        return Result::failure(audio_error("runtime_audio.asset_required",
                                           "Typed audio playback requires an Asset ID"));
    }
    const auto path = m_assets.resolve(*operation.asset);
    if (!path) {
        return Result::failure(
            audio_error("runtime_audio.asset_unavailable", "Typed audio Asset cannot be resolved"));
    }
    return Result::success(assets::AudioAssetRequest{
        .path = *path, .mode = AudioLoadMode::Auto, .kind = audio_kind(operation.purpose)});
}

RuntimeAudioAdapter::PendingPreparation*
RuntimeAudioAdapter::find_preparation(core::AudioOperationId operation) noexcept
{
    const auto found =
        std::find_if(m_preparations.begin(), m_preparations.end(),
                     [&](const auto& candidate) { return candidate.operation.id == operation; });
    return found == m_preparations.end() ? nullptr : &*found;
}

const RuntimeAudioAdapter::PendingPreparation*
RuntimeAudioAdapter::find_preparation(core::AudioOperationId operation) const noexcept
{
    const auto found =
        std::find_if(m_preparations.begin(), m_preparations.end(),
                     [&](const auto& candidate) { return candidate.operation.id == operation; });
    return found == m_preparations.end() ? nullptr : &*found;
}

core::Result<void, core::Diagnostic>
RuntimeAudioAdapter::prepare(const core::AudioOperation& operation)
{
    using Result = core::Result<void, core::Diagnostic>;
    const bool playing = operation.action == core::compiled::AudioAction::Play ||
                         operation.action == core::compiled::AudioAction::FadeIn;
    if (!playing)
        return Result::success();

    if (find_preparation(operation.id) != nullptr)
        return Result::success();
    auto request = resolve_request(operation);
    if (!request)
        return Result::failure(std::move(request).error());
    if (m_typed_assets.leased_audio_on_owner(*request.value_if()) != nullptr)
        return Result::success();

    auto submitted =
        m_typed_assets.request_audio(*request.value_if(), assets::AssetRequestReason::Demand);
    if (!submitted)
        return Result::failure(std::move(submitted).error());
    m_preparations.push_back(PendingPreparation{.operation = operation,
                                                .request = *request.value_if(),
                                                .handle = std::move(*submitted.value_if()),
                                                .ready_lease = std::nullopt,
                                                .delivery_observed = false});
    return Result::success();
}

core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>
RuntimeAudioAdapter::start_playback(const core::AudioOperation& operation,
                                    const assets::AssetLease<assets::AudioAsset>& lease)
{
    using Result = core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>;
    if (!operation.audio_owner)
        return Result::failure(audio_error("runtime_audio.owner_required",
                                           "Transient audio playback requires an Owner"));
    const auto track = operation_track_id(operation);
    AudioTrackDesc desc{.track_id = track,
                        .bus = audio_bus(operation.purpose),
                        .volume = effective_gain(operation.purpose, operation.gain),
                        .pitch = 1.0F,
                        .pan = static_cast<float>(operation.pan),
                        .loop = false,
                        .fade_in_seconds = operation.action == core::compiled::AudioAction::FadeIn
                                               ? seconds(operation.fade)
                                               : 0.0F,
                        .fade_out_seconds = 0.0F,
                        .replace_mode = AudioTrackReplaceMode::Replace};
    if (!m_audio.play_track(track, lease, desc)) {
        return Result::failure(audio_error("runtime_audio.play_failed",
                                           "Audio backend could not start typed playback"));
    }
    const bool report_termination =
        operation.causality == core::compiled::AudioCausality::Causal && !operation.completion;
    m_active.push_back(ActiveTrack{
        operation.id, operation.purpose, operation.pause_policy, *operation.audio_owner,
        operation.gain, track,
        report_termination ? std::optional<core::AudioOperationId>{operation.id} : std::nullopt});
    m_audio.set_track_paused(track, should_pause(operation.pause_policy, *operation.audio_owner));
    refresh_mix_and_pause();

    if (!operation.completion_owner || !operation.completion || !m_audio.track_active(track))
        return Result::success(TypedRuntimeOperationDisposition::Completed);

    m_pending.push_back(PendingCompletion{
        core::CompleteAudioInput{operation.id, *operation.completion_owner, *operation.completion},
        {track}});
    return Result::success(TypedRuntimeOperationDisposition::Pending);
}

core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>
RuntimeAudioAdapter::apply(const core::AudioOperation& operation)
{
    using Result = core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>;
    if (operation.purpose > core::compiled::AudioPurpose::UiSound ||
        operation.pause_policy > core::compiled::AudioPausePolicy::Unscaled ||
        !operation.audio_owner || operation.action > core::compiled::AudioAction::FadeOut ||
        operation.fade.count() < 0 || !std::isfinite(operation.gain) || operation.gain < 0.0 ||
        operation.gain > 1.0 || !std::isfinite(operation.pan) || operation.pan < -1.0 ||
        operation.pan > 1.0 ||
        operation.completion_owner.has_value() != operation.completion.has_value()) {
        return Result::failure(audio_error("runtime_audio.invalid_operation",
                                           "Typed audio operation contains invalid state"));
    }

    const bool playing = operation.action == core::compiled::AudioAction::Play ||
                         operation.action == core::compiled::AudioAction::FadeIn;
    if (playing) {
        auto request = resolve_request(operation);
        if (!request)
            return Result::failure(std::move(request).error());

        const assets::AssetLease<assets::AudioAsset>* lease =
            m_typed_assets.leased_audio_on_owner(*request.value_if());
        std::optional<assets::AssetLease<assets::AudioAsset>> prepared_lease;
        auto* preparation = find_preparation(operation.id);
        if (lease == nullptr && preparation != nullptr && preparation->ready_lease) {
            prepared_lease = *preparation->ready_lease;
            lease = &*prepared_lease;
        }
        if (lease == nullptr && preparation == nullptr) {
            auto submitted = prepare(operation);
            if (!submitted)
                return Result::failure(std::move(submitted).error());
            poll_preparations();
            preparation = find_preparation(operation.id);
            if (preparation != nullptr && preparation->ready_lease) {
                prepared_lease = *preparation->ready_lease;
                lease = &*prepared_lease;
            }
        }
        if (lease == nullptr) {
            if (preparation != nullptr)
                preparation->delivery_observed = true;
            if (operation.causality == core::compiled::AudioCausality::Disposable)
                return Result::success(TypedRuntimeOperationDisposition::Completed);
            return Result::failure(audio_error(
                "runtime_audio.preparation_pending",
                "Causal audio operation was delivered before its demand lease became ready"));
        }

        auto started = start_playback(operation, *lease);
        std::erase_if(m_preparations,
                      [&](const auto& value) { return value.operation.id == operation.id; });
        return started;
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
                    else if constexpr (std::is_same_v<T, core::AudioPurposeOperationTarget>)
                        return active.purpose == target.purpose && active.owner == target.owner;
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

        if (!operation.completion_owner || !operation.completion || stopped_tracks.empty())
            return Result::success(TypedRuntimeOperationDisposition::Completed);

        const bool any_active =
            std::any_of(stopped_tracks.begin(), stopped_tracks.end(),
                        [this](const AudioTrackId& track) { return m_audio.track_active(track); });
        if (!any_active)
            return Result::success(TypedRuntimeOperationDisposition::Completed);

        m_pending.push_back(
            PendingCompletion{core::CompleteAudioInput{operation.id, *operation.completion_owner,
                                                       *operation.completion},
                              std::move(stopped_tracks)});
        return Result::success(TypedRuntimeOperationDisposition::Pending);
    }
}

void RuntimeAudioAdapter::poll_preparations()
{
    for (auto current = m_preparations.begin(); current != m_preparations.end();) {
        if (!current->ready_lease) {
            const auto state = current->handle.state();
            if (state == assets::AssetRequestState::Pending) {
                ++current;
                continue;
            }
            if (state == assets::AssetRequestState::Ready) {
                auto lease = std::move(current->handle).take_ready();
                if (lease) {
                    current->ready_lease = std::move(*lease);
                } else {
                    const auto diagnostic = audio_error(
                        "runtime_audio.prepared_lease_missing",
                        "Ready audio demand request could not transfer its reservation lease");
                    if (current->operation.causality == core::compiled::AudioCausality::Disposable)
                        m_async_diagnostics.push_back(diagnostic);
                    else
                        m_preparation_failures.push_back({current->operation.id, diagnostic});
                    current = m_preparations.erase(current);
                    continue;
                }
            } else {
                auto diagnostics = current->handle.diagnostics();
                auto diagnostic = diagnostics.empty()
                                      ? audio_error("runtime_audio.asset_preparation_failed",
                                                    "Asynchronous audio demand request failed")
                                      : std::move(diagnostics.front());
                if (current->operation.causality == core::compiled::AudioCausality::Disposable) {
                    diagnostic.message = "Cosmetic audio was dropped: " + diagnostic.message;
                    m_async_diagnostics.push_back(std::move(diagnostic));
                } else {
                    m_preparation_failures.push_back(
                        {current->operation.id, std::move(diagnostic)});
                }
                current = m_preparations.erase(current);
                continue;
            }
        }

        if (current->operation.causality == core::compiled::AudioCausality::Disposable &&
            current->delivery_observed && current->ready_lease) {
            auto started = start_playback(current->operation, *current->ready_lease);
            if (!started) {
                auto diagnostic = std::move(started).error();
                diagnostic.message = "Cosmetic audio was dropped: " + diagnostic.message;
                m_async_diagnostics.push_back(std::move(diagnostic));
            }
            current = m_preparations.erase(current);
            continue;
        }
        ++current;
    }
}

bool RuntimeAudioAdapter::causal_preparation_pending() const noexcept
{
    return std::any_of(m_preparations.begin(), m_preparations.end(), [](const auto& preparation) {
        return preparation.operation.causality == core::compiled::AudioCausality::Causal &&
               !preparation.ready_lease;
    });
}

std::vector<RuntimeAudioPreparationFailure> RuntimeAudioAdapter::take_preparation_failures()
{
    auto failures = std::move(m_preparation_failures);
    m_preparation_failures.clear();
    return failures;
}

core::Diagnostics RuntimeAudioAdapter::take_async_diagnostics()
{
    auto diagnostics = std::move(m_async_diagnostics);
    m_async_diagnostics.clear();
    return diagnostics;
}

core::Result<void, core::Diagnostics>
RuntimeAudioAdapter::reconcile_desired(const std::vector<core::PresentationDesiredAudio>& desired)
{
    struct PendingStart {
        core::PresentationDesiredAudio desired;
        assets::AssetLease<assets::AudioAsset> lease;
        AudioTrackId track;
    };
    std::vector<PendingStart> starts;
    for (const auto& candidate : desired) {
        const auto current = std::find_if(m_desired.begin(), m_desired.end(),
                                          [&candidate](const RealizedDesiredTrack& value) {
                                              return desired_key_equal(value.desired, candidate);
                                          });
        if (current != m_desired.end() && desired_playback_equal(current->desired, candidate))
            continue;
        const auto path = m_assets.resolve(candidate.asset);
        if (!path)
            return core::Result<void, core::Diagnostics>::failure(
                {audio_error("runtime_audio.desired_asset_unavailable",
                             "Desired audio Asset cannot be resolved")});
        const assets::AudioAssetRequest request{
            .path = *path, .mode = AudioLoadMode::Auto, .kind = audio_kind(candidate.purpose)};
        const auto* published = m_typed_assets.leased_audio_on_owner(request);
        if (published == nullptr) {
            return core::Result<void, core::Diagnostics>::failure(
                {audio_error("runtime_audio.desired_lease_missing",
                             "Mandatory desired-audio lease is not resident; publication must "
                             "remain pending or fail")});
        }
        starts.push_back(PendingStart{candidate, *published,
                                      "noveltea.runtime.desired." + candidate.instance.text() +
                                          "." + std::to_string(m_next_desired_track++)});
    }

    std::vector<AudioTrackId> started_tracks;
    for (const auto& start : starts) {
        AudioTrackDesc desc{.track_id = start.track,
                            .bus = audio_bus(start.desired.purpose),
                            .volume = effective_gain(start.desired.purpose, start.desired.gain),
                            .pitch = 1.0F,
                            .pan = static_cast<float>(start.desired.pan),
                            .loop = true,
                            .fade_in_seconds = seconds(start.desired.fade_in),
                            .fade_out_seconds = seconds(start.desired.fade_out),
                            .replace_mode = AudioTrackReplaceMode::Replace};
        const bool started = static_cast<bool>(m_audio.play_track(start.track, start.lease, desc));
        if (!started) {
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
        if (target == desired.end() || !desired_playback_equal(current.desired, *target))
            m_audio.stop_track(current.track, seconds(current.desired.fade_out));
    }

    std::vector<RealizedDesiredTrack> realized;
    realized.reserve(desired.size());
    for (const auto& candidate : desired) {
        const auto current = std::find_if(
            m_desired.begin(), m_desired.end(), [&candidate](const RealizedDesiredTrack& value) {
                return desired_playback_equal(value.desired, candidate);
            });
        if (current != m_desired.end()) {
            m_audio.set_track_pan(current->track, static_cast<float>(candidate.pan));
            realized.push_back(RealizedDesiredTrack{candidate, current->track});
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
    refresh_mix_and_pause();
    return core::Result<void, core::Diagnostics>::success();
}

std::vector<core::CompleteAudioInput> RuntimeAudioAdapter::take_completions()
{
    std::vector<core::CompleteAudioInput> completed;
    const auto active_before = m_active.size();
    std::erase_if(m_active, [this](const ActiveTrack& active) {
        if (m_audio.track_active(active.track))
            return false;
        if (active.termination)
            m_terminated.push_back(core::AcknowledgeAudioTerminationInput{*active.termination});
        return true;
    });
    if (m_active.size() != active_before)
        refresh_mix_and_pause();
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
    std::erase_if(m_preparations, [&](auto& preparation) {
        if (preparation.operation.id != operation)
            return false;
        if (!preparation.ready_lease)
            preparation.handle.cancel();
        if (preparation.operation.causality == core::compiled::AudioCausality::Disposable) {
            m_async_diagnostics.push_back(
                audio_error("runtime_audio.cosmetic_request_obsolete",
                            "Cosmetic audio demand became obsolete before playback"));
        }
        return true;
    });
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
    for (auto& preparation : m_preparations) {
        if (!preparation.ready_lease)
            preparation.handle.cancel();
    }
    m_preparations.clear();
    m_preparation_failures.clear();
    m_async_diagnostics.clear();
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
