#pragma once

#include "noveltea/audio/audio_system.hpp"
#include "noveltea/ui_runtime.hpp"

#include <vector>

namespace noveltea {

class RuntimeAudioAdapter final : public TypedRuntimeAudioSink {
public:
    RuntimeAudioAdapter(AudioSystem& audio, const RuntimeUiAssetResolver& assets) noexcept
        : m_audio(audio), m_assets(assets)
    {
    }

    [[nodiscard]] core::Result<TypedRuntimeOperationDisposition, core::Diagnostic>
    apply(const core::AudioOperation& operation) override;
    [[nodiscard]] std::vector<core::CompleteAudioInput> take_completions();
    void reset();

private:
    struct ActiveTrack {
        core::compiled::AudioChannel channel;
        AudioTrackId track;
    };

    struct PendingCompletion {
        core::CompleteAudioInput input;
        std::vector<AudioTrackId> tracks;
    };

    AudioSystem& m_audio;
    const RuntimeUiAssetResolver& m_assets;
    std::vector<ActiveTrack> m_active;
    std::vector<PendingCompletion> m_pending;
};

} // namespace noveltea
