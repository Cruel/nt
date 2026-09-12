#pragma once

#include "noveltea/audio/audio_system.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/presentation/runtime_presentation.hpp"
#include "noveltea/runtime_ui_contracts.hpp"

#include <cstdint>
#include <span>
#include <vector>

namespace noveltea {

enum class TypedRuntimeOperationDisposition : std::uint8_t {
    Completed,
    Pending
};

struct RuntimeAudioPreparationFailure {
    core::AudioOperationId operation;
    core::Diagnostic diagnostic;
};

class RuntimeAudioAdapter final {
public:
    RuntimeAudioAdapter(AudioSystem& audio, const RuntimeUiAssetService& assets,
                        assets::AssetManager& typed_assets) noexcept
        : m_audio(audio), m_assets(assets), m_typed_assets(typed_assets)
    {
    }
    ~RuntimeAudioAdapter();

    RuntimeAudioAdapter(const RuntimeAudioAdapter&) = delete;
    RuntimeAudioAdapter& operator=(const RuntimeAudioAdapter&) = delete;
    RuntimeAudioAdapter(RuntimeAudioAdapter&&) = delete;
    RuntimeAudioAdapter& operator=(RuntimeAudioAdapter&&) = delete;

    [[nodiscard]] core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>
    apply(const core::AudioOperation& operation);
    [[nodiscard]] core::Result<void, core::Diagnostic>
    prepare(const core::AudioOperation& operation);
    void poll_preparations();
    [[nodiscard]] bool causal_preparation_pending() const noexcept;
    [[nodiscard]] std::vector<RuntimeAudioPreparationFailure> take_preparation_failures();
    [[nodiscard]] core::Diagnostics take_async_diagnostics();
    void set_mix_settings(core::compiled::AudioMixSettings settings) noexcept;
    void set_gameplay_paused(bool paused) noexcept;
    void cancel_owner(const core::PresentationOwner& owner) noexcept;
    void cancel_inactive_owners(std::span<const core::PresentationOwner> owners) noexcept;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_desired(const std::vector<core::PresentationDesiredAudio>& desired);
    void begin_locale_audio_transition(std::uint64_t generation);
    [[nodiscard]] std::vector<core::CompleteAudioInput> take_completions();
    [[nodiscard]] std::vector<core::AcknowledgeAudioTerminationInput> take_terminations();
    void snap_operation(core::AudioOperationId operation) noexcept;
    void reset(core::PresentationCancellationReason reason =
                   core::PresentationCancellationReason::OwnerEnded) noexcept;

private:
    struct ActiveTrack {
        core::AudioOperationId operation;
        core::compiled::AudioPurpose purpose;
        core::compiled::AudioPausePolicy pause_policy;
        core::PresentationOwner owner;
        core::compiled::AudioCausality causality;
        core::AssetId asset;
        double gain = 1.0;
        double pan = 0.0;
        AudioTrackId track;
        std::string physical_path;
        std::optional<core::AudioOperationId> termination;
        bool locale_suspended = false;
        bool stopping = false;
    };

    struct RealizedDesiredTrack {
        core::PresentationDesiredAudio desired;
        AudioTrackId track;
        std::string physical_path;
        bool locale_suspended = false;
    };

    struct PendingCompletion {
        core::CompleteAudioInput input;
        std::vector<AudioTrackId> tracks;
    };

    struct PendingPreparation {
        core::AudioOperation operation;
        assets::AudioAssetRequest request;
        assets::AssetRequestHandle<assets::AudioAsset> handle;
        std::optional<assets::AssetLease<assets::AudioAsset>> ready_lease;
        bool delivery_observed = false;
    };

    struct PendingLocaleReplacement {
        std::uint64_t generation = 0;
        AudioTrackId track;
        core::AssetId asset;
        std::optional<core::AudioOperationId> operation;
        std::optional<double> normalized_progress;
        assets::AudioAssetRequest request;
        assets::AssetRequestHandle<assets::AudioAsset> handle;
    };

    [[nodiscard]] core::Result<assets::AudioAssetRequest, core::Diagnostic>
    resolve_request(const core::AudioOperation& operation) const;
    [[nodiscard]] core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>
    start_playback(const core::AudioOperation& operation,
                   const assets::AssetLease<assets::AudioAsset>& lease);
    [[nodiscard]] PendingPreparation* find_preparation(core::AudioOperationId operation) noexcept;
    [[nodiscard]] const PendingPreparation*
    find_preparation(core::AudioOperationId operation) const noexcept;
    void poll_locale_replacements();
    void cancel_locale_replacement(const AudioTrackId& track) noexcept;
    void fail_locale_replacement(const PendingLocaleReplacement& replacement,
                                 core::Diagnostic diagnostic);
    [[nodiscard]] float effective_gain(core::compiled::AudioPurpose purpose,
                                       double gain) const noexcept;
    [[nodiscard]] bool should_pause(core::compiled::AudioPausePolicy policy,
                                    const core::PresentationOwner& owner) const noexcept;
    void refresh_mix_and_pause() noexcept;

    AudioSystem& m_audio;
    const RuntimeUiAssetService& m_assets;
    assets::AssetManager& m_typed_assets;
    std::vector<ActiveTrack> m_active;
    std::vector<RealizedDesiredTrack> m_desired;
    std::vector<PendingCompletion> m_pending;
    std::vector<PendingPreparation> m_preparations;
    std::vector<PendingLocaleReplacement> m_locale_replacements;
    std::vector<RuntimeAudioPreparationFailure> m_preparation_failures;
    core::Diagnostics m_async_diagnostics;
    std::vector<core::AcknowledgeAudioTerminationInput> m_terminated;
    core::compiled::AudioMixSettings m_mix_settings;
    bool m_gameplay_paused = false;
    std::uint64_t m_locale_transition_generation = 0;
    std::uint64_t m_next_desired_track = 1;
};

} // namespace noveltea
