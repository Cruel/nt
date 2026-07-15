#pragma once

#include "noveltea/audio/audio_system.hpp"
#include "noveltea/ui_runtime.hpp"

#include <vector>

namespace noveltea {

class RuntimeAudioAdapter final {
public:
    RuntimeAudioAdapter(AudioSystem& audio, const RuntimeUiAssetResolver& assets) noexcept
        : m_audio(audio), m_assets(assets)
    {
    }

    [[nodiscard]] core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>
    apply(const core::AudioOperation& operation);
    [[nodiscard]] std::vector<core::CompleteAudioInput> take_completions();
    [[nodiscard]] std::vector<core::AcknowledgeAudioTerminationInput> take_terminations();
    void reset(core::PresentationCancellationReason reason =
                   core::PresentationCancellationReason::OwnerEnded) noexcept;

private:
    struct ActiveTrack {
        core::compiled::AudioChannel channel;
        AudioTrackId track;
        std::optional<core::AudioOperationId> termination;
    };

    struct PendingCompletion {
        core::CompleteAudioInput input;
        std::vector<AudioTrackId> tracks;
    };

    AudioSystem& m_audio;
    const RuntimeUiAssetResolver& m_assets;
    std::vector<ActiveTrack> m_active;
    std::vector<PendingCompletion> m_pending;
    std::vector<core::AcknowledgeAudioTerminationInput> m_terminated;
};

} // namespace noveltea
