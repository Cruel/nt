#pragma once

#include "noveltea/assets/typed_assets.hpp"
#include "noveltea/audio/audio_types.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/jobs/job_types.hpp"

#include <cstdint>
#include <memory>

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea {

struct AudioBackendInfo {
    const char* name = "none";
    bool available = false;
    std::uint32_t resource_manager_job_thread_count = 0;
    bool resource_manager_no_threading = true;
};

struct AudioBackendStats {
    uint32_t clips_loaded = 0;
    uint32_t voices_started = 0;
    uint32_t voices_active = 0;
    uint32_t voices_finished = 0;
    uint32_t backend_errors = 0;
};

class AudioBackend {
public:
    virtual ~AudioBackend() = default;

    [[nodiscard]] virtual AudioBackendInfo backend_info() const = 0;
    [[nodiscard]] virtual core::DiagnosticResult<void>
    initialize(const assets::AssetManager& assets,
               const jobs::JobExecutionConfig& job_execution) = 0;
    virtual void shutdown() = 0;

    [[nodiscard]] virtual assets::AssetLoadResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) = 0;

    [[nodiscard]] virtual AudioVoiceHandle play(AudioClipHandle clip,
                                                const AudioPlaybackDesc& desc) = 0;
    virtual void stop(AudioVoiceHandle voice) = 0;
    virtual void set_volume(AudioVoiceHandle voice, float volume) = 0;
    virtual void set_bus_volume(AudioBus bus, float volume) = 0;
    virtual void pause() = 0;
    virtual void resume() = 0;
    [[nodiscard]] virtual bool voice_active(AudioVoiceHandle voice) const = 0;
    [[nodiscard]] virtual AudioBackendStats stats() const = 0;
    virtual void collect_finished_voices() = 0;
};

struct MiniaudioBackendConfig {
    bool enable_device = true;
};

[[nodiscard]] std::unique_ptr<AudioBackend>
make_miniaudio_backend(MiniaudioBackendConfig config = {});

} // namespace noveltea
