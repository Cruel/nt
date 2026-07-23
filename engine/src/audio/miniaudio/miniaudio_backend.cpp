#include "noveltea/audio/audio_backend.hpp"

#include "noveltea/assets/asset_manager.hpp"

#define MINIAUDIO_IMPLEMENTATION
#include <miniaudio.h>

#include <algorithm>
#include <cstdio>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace noveltea {
namespace {

template<class T> assets::AssetLoadResult<T> fail(std::string message)
{
    return {std::nullopt, std::move(message)};
}

const char* ma_error_name(ma_result result)
{
    switch (result) {
    case MA_SUCCESS:
        return "success";
    case MA_ERROR:
        return "generic error";
    case MA_INVALID_ARGS:
        return "invalid arguments";
    case MA_INVALID_OPERATION:
        return "invalid operation";
    case MA_INVALID_FILE:
        return "invalid file";
    case MA_DOES_NOT_EXIST:
        return "does not exist";
    case MA_OUT_OF_MEMORY:
        return "out of memory";
    case MA_DEVICE_NOT_INITIALIZED:
        return "device not initialized";
    case MA_DEVICE_NOT_STARTED:
        return "device not started";
    case MA_FORMAT_NOT_SUPPORTED:
        return "format not supported";
    default:
        return "miniaudio error";
    }
}

core::Diagnostic initialization_failure(std::string code, std::string operation, ma_result result)
{
    return core::Diagnostic{
        .code = std::move(code),
        .message = std::move(operation) + ": " + ma_error_name(result) + " (" +
                   std::to_string(result) + ")",
        .severity = core::ErrorSeverity::Fatal,
    };
}

ma_uint32 flags_for(AudioLoadMode mode, AudioClipKind kind)
{
    ma_uint32 flags = MA_SOUND_FLAG_NO_SPATIALIZATION;
    if (mode == AudioLoadMode::Decode ||
        (mode == AudioLoadMode::Auto && kind == AudioClipKind::Sfx)) {
        flags |= MA_SOUND_FLAG_DECODE;
    }
    return flags;
}

AudioLoadMode resolved_mode(AudioLoadMode mode, AudioClipKind kind)
{
    if (mode != AudioLoadMode::Auto)
        return mode;
    return kind == AudioClipKind::Sfx ? AudioLoadMode::Decode : AudioLoadMode::Stream;
}

class MiniaudioBackend final : public AudioBackend {
public:
    explicit MiniaudioBackend(MiniaudioBackendConfig config) : m_config(config) {}
    ~MiniaudioBackend() override { shutdown(); }

    AudioBackendInfo backend_info() const override
    {
        return AudioBackendInfo{
            .name = "miniaudio",
            .available = m_initialized,
            .resource_manager_job_thread_count = m_resource_manager_job_thread_count,
            .resource_manager_no_threading = m_resource_manager_no_threading,
        };
    }

    core::DiagnosticResult<void> initialize(const assets::AssetManager& assets,
                                            const jobs::JobExecutionConfig& job_execution) override
    {
        shutdown();
        m_assets = &assets;

        ma_resource_manager_config resource_config = ma_resource_manager_config_init();
        if (job_execution.mode == jobs::JobExecutionMode::Threaded) {
            if (job_execution.worker_count == 0) {
                m_assets = nullptr;
                return core::DiagnosticResult<void>::failure(core::Diagnostic{
                    .code = "audio.invalid_job_execution_config",
                    .message = "Threaded audio initialization requires a non-zero NovelTea worker "
                               "count.",
                    .severity = core::ErrorSeverity::Fatal,
                });
            }
            resource_config.jobThreadCount = NOVELTEA_MINIAUDIO_RESOURCE_MANAGER_JOB_THREAD_COUNT;
        } else {
            if (job_execution.worker_count != 0) {
                m_assets = nullptr;
                return core::DiagnosticResult<void>::failure(core::Diagnostic{
                    .code = "audio.invalid_job_execution_config",
                    .message = "Non-threaded audio initialization requires a zero NovelTea worker "
                               "count.",
                    .severity = core::ErrorSeverity::Fatal,
                });
            }
            resource_config.jobThreadCount = 0;
            resource_config.flags |= MA_RESOURCE_MANAGER_FLAG_NO_THREADING;
        }
        m_resource_manager_job_thread_count = resource_config.jobThreadCount;
        m_resource_manager_no_threading =
            (resource_config.flags & MA_RESOURCE_MANAGER_FLAG_NO_THREADING) != 0;

        ma_result result = ma_resource_manager_init(&resource_config, &m_resource_manager);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            m_assets = nullptr;
            return core::DiagnosticResult<void>::failure(
                initialization_failure("audio.resource_manager_initialization_failed",
                                       "Miniaudio resource manager initialization failed", result));
        }
        m_resource_manager_initialized = true;

        ma_engine_config engine_config = ma_engine_config_init();
        engine_config.pResourceManager = &m_resource_manager;
        engine_config.noDevice = m_config.enable_device ? MA_FALSE : MA_TRUE;
        if (!m_config.enable_device) {
            engine_config.channels = 2;
            engine_config.sampleRate = 48'000;
        }
        result = ma_engine_init(&engine_config, &m_engine);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            auto diagnostic =
                initialization_failure("audio.engine_initialization_failed",
                                       "Miniaudio engine initialization failed", result);
            shutdown();
            return core::DiagnosticResult<void>::failure(std::move(diagnostic));
        }
        m_engine_initialized = true;

        if (auto groups = init_groups(); !groups) {
            auto diagnostic = std::move(groups.error());
            shutdown();
            return core::DiagnosticResult<void>::failure(std::move(diagnostic));
        }
        m_initialized = true;
        std::fprintf(stderr, "[audio:miniaudio] initialized\n");
        return core::DiagnosticResult<void>::success();
    }

    void shutdown() override
    {
        for (auto& [id, voice] : m_voices) {
            (void)id;
            if (voice) {
                cleanup_voice_source(*voice);
            }
        }
        m_voices.clear();

        for (auto& group : m_groups) {
            if (group.initialized) {
                ma_sound_group_uninit(&group.group);
                group.initialized = false;
            }
        }

        if (m_engine_initialized) {
            ma_engine_uninit(&m_engine);
            m_engine_initialized = false;
        }
        if (m_resource_manager_initialized) {
            ma_resource_manager_uninit(&m_resource_manager);
            m_resource_manager_initialized = false;
        }
        m_initialized = false;
        m_resource_manager_job_thread_count = 0;
        m_resource_manager_no_threading = true;
        m_assets = nullptr;
        m_clips.clear();
        m_clip_lookup.clear();
        m_next_clip_id = 1;
        m_next_voice_id = 1;
        m_pause_depth = 0;
        m_stats = {};
    }

    assets::AssetLoadResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override
    {
        if (!m_initialized || !m_assets) {
            return fail<assets::AudioAsset>("miniaudio backend is not initialized");
        }
        if (request.path.empty()) {
            return fail<assets::AudioAsset>("audio asset path is empty");
        }

        const std::string key = request.path + "|" +
                                std::to_string(static_cast<int>(request.mode)) + "|" +
                                std::to_string(static_cast<int>(request.kind));
        if (auto it = m_clip_lookup.find(key); it != m_clip_lookup.end()) {
            const auto clip_it = m_clips.find(it->second.id);
            if (clip_it == m_clips.end())
                return fail<assets::AudioAsset>("audio clip lookup referenced a missing clip");
            const Clip& clip = clip_it->second;
            return {
                assets::AudioAsset{
                    .clip = it->second, .path = clip.path, .mode = clip.mode, .kind = clip.kind},
                {}};
        }

        auto blob = m_assets->read_binary(request.path);
        if (!blob) {
            return fail<assets::AudioAsset>("failed to read audio asset '" + request.path +
                                            "': " + blob.error.message);
        }
        if (blob.value->bytes.empty()) {
            return fail<assets::AudioAsset>("audio asset is empty: " + request.path);
        }

        Clip clip;
        clip.handle = AudioClipHandle{m_next_clip_id++};
        clip.path = request.path;
        clip.mode = resolved_mode(request.mode, request.kind);
        clip.kind = request.kind;
        clip.bytes = std::move(blob.value->bytes);

        ma_result result = ma_resource_manager_register_encoded_data(
            &m_resource_manager, clip.path.c_str(), clip.bytes.data(), clip.bytes.size());
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            return fail<assets::AudioAsset>("miniaudio failed to register encoded data for '" +
                                            request.path + "': " + ma_error_name(result));
        }

        AudioClipHandle handle = clip.handle;
        m_clips.emplace(handle.id, std::move(clip));
        m_clip_lookup.emplace(key, handle);
        const auto stored_it = m_clips.find(handle.id);
        if (stored_it == m_clips.end())
            return fail<assets::AudioAsset>("audio clip insertion failed");
        const Clip& stored = stored_it->second;
        ++m_stats.clips_loaded;
        std::fprintf(stderr,
                     "[audio:miniaudio] loaded clip id=%u path='%s' bytes=%zu mode=%d kind=%d\n",
                     handle.id, stored.path.c_str(), stored.bytes.size(),
                     static_cast<int>(stored.mode), static_cast<int>(stored.kind));
        return {assets::AudioAsset{
                    .clip = handle, .path = stored.path, .mode = stored.mode, .kind = stored.kind},
                {}};
    }

    AudioVoiceHandle play(AudioClipHandle clip_handle, const AudioPlaybackDesc& desc) override
    {
        if (!m_initialized || !clip_handle)
            return {};
        auto clip_it = m_clips.find(clip_handle.id);
        if (clip_it == m_clips.end()) {
            std::fprintf(stderr, "[audio:miniaudio] unknown clip handle: %u\n", clip_handle.id);
            return {};
        }
        const Clip& clip = clip_it->second;

        auto voice = std::make_unique<Voice>();
        ma_sound_group* group = group_for(desc.bus);
        ma_result result = MA_SUCCESS;
        if (clip.mode == AudioLoadMode::Stream) {
            result = ma_decoder_init_memory(clip.bytes.data(), clip.bytes.size(), nullptr,
                                            &voice->decoder);
            if (result != MA_SUCCESS) {
                ++m_stats.backend_errors;
                std::fprintf(stderr,
                             "[audio:miniaudio] memory stream init failed for '%s': %s (%d)\n",
                             clip.path.c_str(), ma_error_name(result), result);
                return {};
            }
            voice->decoder_initialized = true;
            result = ma_sound_init_from_data_source(
                &m_engine, &voice->decoder, MA_SOUND_FLAG_NO_SPATIALIZATION, group, &voice->sound);
        } else {
            ma_uint32 source_flags =
                flags_for(clip.mode, clip.kind) | MA_RESOURCE_MANAGER_DATA_SOURCE_FLAG_WAIT_INIT;
            result = ma_resource_manager_data_source_init(
                &m_resource_manager, clip.path.c_str(), source_flags, nullptr, &voice->data_source);
            if (result != MA_SUCCESS) {
                ++m_stats.backend_errors;
                std::fprintf(stderr,
                             "[audio:miniaudio] data source init failed for '%s': %s (%d)\n",
                             clip.path.c_str(), ma_error_name(result), result);
                return {};
            }
            voice->data_source_initialized = true;
            result = ma_sound_init_from_data_source(&m_engine, &voice->data_source,
                                                    MA_SOUND_FLAG_NO_SPATIALIZATION, group,
                                                    &voice->sound);
        }
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            std::fprintf(stderr, "[audio:miniaudio] sound init failed for '%s': %s (%d)\n",
                         clip.path.c_str(), ma_error_name(result), result);
            cleanup_voice_source(*voice);
            return {};
        }
        voice->sound_initialized = true;
        voice->clip = clip_handle;
        voice->path = clip.path;
        ma_sound_set_volume(&voice->sound, desc.volume);
        ma_sound_set_pitch(&voice->sound, desc.pitch > 0.0f ? desc.pitch : 1.0f);
        ma_sound_set_looping(&voice->sound, desc.loop ? MA_TRUE : MA_FALSE);

        result = ma_sound_start(&voice->sound);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            std::fprintf(stderr, "[audio:miniaudio] sound start failed for '%s': %s (%d)\n",
                         clip.path.c_str(), ma_error_name(result), result);
            cleanup_voice_source(*voice);
            return {};
        }

        const AudioVoiceHandle handle{m_next_voice_id++};
        m_voices.emplace(handle.id, std::move(voice));
        ++m_stats.voices_started;
        std::fprintf(stderr,
                     "[audio:miniaudio] started voice id=%u clip=%u path='%s' bus=%d volume=%.3f "
                     "pitch=%.3f loop=%d\n",
                     handle.id, clip_handle.id, clip.path.c_str(), static_cast<int>(desc.bus),
                     desc.volume, desc.pitch, desc.loop ? 1 : 0);
        return handle;
    }

    void stop(AudioVoiceHandle voice) override
    {
        auto it = m_voices.find(voice.id);
        if (it != m_voices.end() && it->second) {
            ma_sound_stop(&it->second->sound);
        }
    }

    void set_volume(AudioVoiceHandle voice, float volume) override
    {
        auto it = m_voices.find(voice.id);
        if (it != m_voices.end() && it->second) {
            ma_sound_set_volume(&it->second->sound, volume);
        }
    }

    void set_bus_volume(AudioBus bus, float volume) override
    {
        if (bus == AudioBus::Master) {
            ma_engine_set_volume(&m_engine, volume);
            return;
        }
        ma_sound_group* group = group_for(bus);
        if (group) {
            ma_sound_group_set_volume(group, volume);
        }
    }

    void pause() override
    {
        if (!m_initialized)
            return;
        ++m_pause_depth;
        if (m_pause_depth == 1) {
            const ma_result result = ma_engine_stop(&m_engine);
            if (result != MA_SUCCESS) {
                ++m_stats.backend_errors;
                std::fprintf(stderr, "[audio:miniaudio] pause failed: %s (%d)\n",
                             ma_error_name(result), result);
            } else {
                std::fprintf(stderr, "[audio:miniaudio] paused\n");
            }
        }
    }

    void resume() override
    {
        if (!m_initialized || m_pause_depth == 0)
            return;
        --m_pause_depth;
        if (m_pause_depth == 0) {
            const ma_result result = ma_engine_start(&m_engine);
            if (result != MA_SUCCESS) {
                ++m_stats.backend_errors;
                std::fprintf(stderr, "[audio:miniaudio] resume failed: %s (%d)\n",
                             ma_error_name(result), result);
            } else {
                std::fprintf(stderr, "[audio:miniaudio] resumed\n");
            }
        }
    }

    bool voice_active(AudioVoiceHandle voice) const override
    {
        auto it = m_voices.find(voice.id);
        if (it == m_voices.end() || !it->second)
            return false;
        return ma_sound_is_playing(&it->second->sound) == MA_TRUE &&
               ma_sound_at_end(&it->second->sound) == MA_FALSE;
    }

    AudioBackendStats stats() const override
    {
        AudioBackendStats snapshot = m_stats;
        snapshot.voices_active = static_cast<uint32_t>(m_voices.size());
        return snapshot;
    }

    void collect_finished_voices() override
    {
        for (auto it = m_voices.begin(); it != m_voices.end();) {
            if (!it->second || ma_sound_at_end(&it->second->sound) == MA_TRUE ||
                ma_sound_is_playing(&it->second->sound) == MA_FALSE) {
                if (it->second) {
                    cleanup_voice_source(*it->second);
                }
                ++m_stats.voices_finished;
                it = m_voices.erase(it);
            } else {
                ++it;
            }
        }
    }

private:
    struct Clip {
        AudioClipHandle handle;
        std::string path;
        AudioLoadMode mode = AudioLoadMode::Auto;
        AudioClipKind kind = AudioClipKind::Auto;
        assets::AssetBytes bytes;
    };

    struct Voice {
        ma_resource_manager_data_source data_source{};
        ma_decoder decoder{};
        ma_sound sound{};
        AudioClipHandle clip;
        std::string path;
        bool data_source_initialized = false;
        bool decoder_initialized = false;
        bool sound_initialized = false;
    };

    void cleanup_voice_source(Voice& voice)
    {
        if (voice.sound_initialized) {
            ma_sound_uninit(&voice.sound);
            voice.sound_initialized = false;
        }
        if (voice.data_source_initialized) {
            ma_resource_manager_data_source_uninit(&voice.data_source);
            voice.data_source_initialized = false;
        }
        if (voice.decoder_initialized) {
            ma_decoder_uninit(&voice.decoder);
            voice.decoder_initialized = false;
        }
    }

    struct Group {
        ma_sound_group group{};
        bool initialized = false;
    };

    core::DiagnosticResult<void> init_groups()
    {
        for (const AudioBus bus :
             {AudioBus::Sfx, AudioBus::Music, AudioBus::Ambience, AudioBus::Voice}) {
            if (auto initialized = init_group(bus, nullptr); !initialized)
                return initialized;
        }
        return core::DiagnosticResult<void>::success();
    }

    core::DiagnosticResult<void> init_group(AudioBus bus, ma_sound_group* parent)
    {
        Group& group = m_groups[index_for(bus)];
        ma_result result =
            ma_sound_group_init(&m_engine, MA_SOUND_FLAG_NO_SPATIALIZATION, parent, &group.group);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            group.initialized = false;
            return core::DiagnosticResult<void>::failure(
                initialization_failure("audio.sound_group_initialization_failed",
                                       "Miniaudio sound group initialization failed", result));
        }
        group.initialized = true;
        return core::DiagnosticResult<void>::success();
    }

    static std::size_t index_for(AudioBus bus)
    {
        switch (bus) {
        case AudioBus::Sfx:
            return 0;
        case AudioBus::Music:
            return 1;
        case AudioBus::Ambience:
            return 2;
        case AudioBus::Voice:
            return 3;
        case AudioBus::Master:
            return 0;
        }
        return 0;
    }

    ma_sound_group* group_for(AudioBus bus)
    {
        if (bus == AudioBus::Master)
            return nullptr;
        Group& group = m_groups[index_for(bus)];
        return group.initialized ? &group.group : nullptr;
    }

    const assets::AssetManager* m_assets = nullptr;
    MiniaudioBackendConfig m_config{};
    ma_resource_manager m_resource_manager{};
    ma_engine m_engine{};
    bool m_resource_manager_initialized = false;
    bool m_engine_initialized = false;
    bool m_initialized = false;
    std::uint32_t m_resource_manager_job_thread_count = 0;
    bool m_resource_manager_no_threading = true;
    uint32_t m_next_clip_id = 1;
    uint32_t m_next_voice_id = 1;
    uint32_t m_pause_depth = 0;
    AudioBackendStats m_stats{};
    std::unordered_map<uint32_t, Clip> m_clips;
    std::unordered_map<std::string, AudioClipHandle> m_clip_lookup;
    std::unordered_map<uint32_t, std::unique_ptr<Voice>> m_voices;
    Group m_groups[4]{};
};

} // namespace

std::unique_ptr<AudioBackend> make_miniaudio_backend(MiniaudioBackendConfig config)
{
    return std::make_unique<MiniaudioBackend>(config);
}

} // namespace noveltea
