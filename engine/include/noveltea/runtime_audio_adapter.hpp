#pragma once

#include "noveltea/audio/audio_system.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/presentation/runtime_presentation.hpp"
#include "noveltea/runtime_ui_contracts.hpp"

#include <cstdint>
#include <vector>

namespace noveltea {

enum class TypedRuntimeOperationDisposition : std::uint8_t {
    Completed,
    Pending
};

class RuntimeAudioAdapter final {
public:
    RuntimeAudioAdapter(AudioSystem& audio, const RuntimeUiAssetService& assets,
                        const assets::AssetManager& typed_assets) noexcept
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
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_desired(const std::vector<core::PresentationDesiredAudio>& desired);
    [[nodiscard]] std::vector<core::CompleteAudioInput> take_completions();
    [[nodiscard]] std::vector<core::AcknowledgeAudioTerminationInput> take_terminations();
    void snap_operation(core::AudioOperationId operation) noexcept;
    void reset(core::PresentationCancellationReason reason =
                   core::PresentationCancellationReason::OwnerEnded) noexcept;

private:
    struct ActiveTrack {
        core::AudioOperationId operation;
        core::compiled::AudioChannel channel;
        AudioTrackId track;
        std::optional<core::AudioOperationId> termination;
    };

    struct RealizedDesiredTrack {
        core::PresentationDesiredAudio desired;
        AudioTrackId track;
    };

    struct PendingCompletion {
        core::CompleteAudioInput input;
        std::vector<AudioTrackId> tracks;
    };

    AudioSystem& m_audio;
    const RuntimeUiAssetService& m_assets;
    const assets::AssetManager& m_typed_assets;
    std::vector<ActiveTrack> m_active;
    std::vector<RealizedDesiredTrack> m_desired;
    std::vector<PendingCompletion> m_pending;
    std::vector<core::AcknowledgeAudioTerminationInput> m_terminated;
    std::uint64_t m_next_desired_track = 1;
};

} // namespace noveltea
