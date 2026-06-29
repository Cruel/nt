#pragma once

#include "noveltea/assets/typed_assets.hpp"
#include "noveltea/audio/audio_types.hpp"

#include <memory>

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea {

struct AudioBackendInfo {
    const char* name = "none";
    bool available = false;
};

class AudioBackend {
public:
    virtual ~AudioBackend() = default;

    [[nodiscard]] virtual AudioBackendInfo backend_info() const = 0;
    virtual bool initialize(const assets::AssetManager& assets) = 0;
    virtual void shutdown() = 0;

    [[nodiscard]] virtual assets::AssetResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) = 0;

    [[nodiscard]] virtual AudioVoiceHandle play(AudioClipHandle clip,
                                                const AudioPlaybackDesc& desc) = 0;
    virtual void stop(AudioVoiceHandle voice) = 0;
    virtual void set_volume(AudioVoiceHandle voice, float volume) = 0;
    virtual void set_bus_volume(AudioBus bus, float volume) = 0;
    virtual void pause() = 0;
    virtual void resume() = 0;
    [[nodiscard]] virtual bool voice_active(AudioVoiceHandle voice) const = 0;
    virtual void collect_finished_voices() = 0;
};

[[nodiscard]] std::unique_ptr<AudioBackend> make_miniaudio_backend();

} // namespace noveltea
