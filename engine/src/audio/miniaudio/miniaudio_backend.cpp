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

template<class T> assets::AssetResult<T> fail(std::string message)
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
    ~MiniaudioBackend() override { shutdown(); }

    AudioBackendInfo backend_info() const override
    {
        return AudioBackendInfo{.name = "miniaudio", .available = m_initialized};
    }

    bool initialize(const assets::AssetManager& assets) override
    {
        shutdown();
        m_assets = &assets;

        ma_resource_manager_config resource_config = ma_resource_manager_config_init();
        ma_result result = ma_resource_manager_init(&resource_config, &m_resource_manager);
        if (result != MA_SUCCESS) {
            std::fprintf(stderr, "[audio:miniaudio] resource manager init failed: %s (%d)\n",
                         ma_error_name(result), result);
            return false;
        }
        m_resource_manager_initialized = true;

        ma_engine_config engine_config = ma_engine_config_init();
        engine_config.pResourceManager = &m_resource_manager;
        result = ma_engine_init(&engine_config, &m_engine);
        if (result != MA_SUCCESS) {
            std::fprintf(stderr, "[audio:miniaudio] engine init failed: %s (%d)\n",
                         ma_error_name(result), result);
            shutdown();
            return false;
        }
        m_engine_initialized = true;

        m_initialized = true;
        init_groups();
        std::fprintf(stderr, "[audio:miniaudio] initialized\n");
        return true;
    }

    void shutdown() override
    {
        for (auto& [id, voice] : m_voices) {
            (void)id;
            if (voice) {
                ma_sound_uninit(&voice->sound);
                ma_resource_manager_data_source_uninit(&voice->data_source);
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
        m_assets = nullptr;
        m_clips.clear();
        m_clip_lookup.clear();
        m_next_clip_id = 1;
        m_next_voice_id = 1;
        m_pause_depth = 0;
    }

    assets::AssetResult<assets::AudioAsset>
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
            const Clip& clip = m_clips.at(it->second.id);
            return {
                assets::AudioAsset{
                    .clip = it->second, .path = clip.path, .mode = clip.mode, .kind = clip.kind},
                {}};
        }

        auto blob = m_assets->read_binary(request.path);
        if (!blob) {
            return fail<assets::AudioAsset>("failed to read audio asset '" + request.path +
                                            "': " + blob.error);
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
            return fail<assets::AudioAsset>("miniaudio failed to register encoded data for '" +
                                            request.path + "': " + ma_error_name(result));
        }

        AudioClipHandle handle = clip.handle;
        m_clips.emplace(handle.id, std::move(clip));
        m_clip_lookup.emplace(key, handle);
        const Clip& stored = m_clips.at(handle.id);
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
        ma_uint32 source_flags =
            flags_for(clip.mode, clip.kind) | MA_RESOURCE_MANAGER_DATA_SOURCE_FLAG_WAIT_INIT;
        ma_result result = ma_resource_manager_data_source_init(
            &m_resource_manager, clip.path.c_str(), source_flags, nullptr, &voice->data_source);
        if (result != MA_SUCCESS) {
            std::fprintf(stderr, "[audio:miniaudio] data source init failed for '%s': %s (%d)\n",
                         clip.path.c_str(), ma_error_name(result), result);
            return {};
        }
        voice->data_source_initialized = true;

        ma_sound_group* group = group_for(desc.bus);
        result = ma_sound_init_from_data_source(
            &m_engine, &voice->data_source, MA_SOUND_FLAG_NO_SPATIALIZATION, group, &voice->sound);
        if (result != MA_SUCCESS) {
            std::fprintf(stderr, "[audio:miniaudio] sound init failed for '%s': %s (%d)\n",
                         clip.path.c_str(), ma_error_name(result), result);
            ma_resource_manager_data_source_uninit(&voice->data_source);
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
            std::fprintf(stderr, "[audio:miniaudio] sound start failed for '%s': %s (%d)\n",
                         clip.path.c_str(), ma_error_name(result), result);
            ma_sound_uninit(&voice->sound);
            ma_resource_manager_data_source_uninit(&voice->data_source);
            return {};
        }

        const AudioVoiceHandle handle{m_next_voice_id++};
        m_voices.emplace(handle.id, std::move(voice));
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

    void collect_finished_voices() override
    {
        for (auto it = m_voices.begin(); it != m_voices.end();) {
            if (!it->second || ma_sound_at_end(&it->second->sound) == MA_TRUE ||
                ma_sound_is_playing(&it->second->sound) == MA_FALSE) {
                if (it->second) {
                    ma_sound_uninit(&it->second->sound);
                    ma_resource_manager_data_source_uninit(&it->second->data_source);
                }
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
        ma_sound sound{};
        AudioClipHandle clip;
        std::string path;
        bool data_source_initialized = false;
        bool sound_initialized = false;
    };

    struct Group {
        ma_sound_group group{};
        bool initialized = false;
    };

    void init_groups()
    {
        init_group(AudioBus::Sfx, nullptr);
        init_group(AudioBus::Music, nullptr);
        init_group(AudioBus::Ambience, nullptr);
        init_group(AudioBus::Voice, nullptr);
    }

    void init_group(AudioBus bus, ma_sound_group* parent)
    {
        Group& group = m_groups[index_for(bus)];
        ma_result result =
            ma_sound_group_init(&m_engine, MA_SOUND_FLAG_NO_SPATIALIZATION, parent, &group.group);
        if (result != MA_SUCCESS) {
            std::fprintf(stderr, "[audio:miniaudio] sound group init failed: %s (%d)\n",
                         ma_error_name(result), result);
            group.initialized = false;
            return;
        }
        group.initialized = true;
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
    ma_resource_manager m_resource_manager{};
    ma_engine m_engine{};
    bool m_resource_manager_initialized = false;
    bool m_engine_initialized = false;
    bool m_initialized = false;
    uint32_t m_next_clip_id = 1;
    uint32_t m_next_voice_id = 1;
    uint32_t m_pause_depth = 0;
    std::unordered_map<uint32_t, Clip> m_clips;
    std::unordered_map<std::string, AudioClipHandle> m_clip_lookup;
    std::unordered_map<uint32_t, std::unique_ptr<Voice>> m_voices;
    Group m_groups[4]{};
};

} // namespace

std::unique_ptr<AudioBackend> make_miniaudio_backend()
{
    return std::make_unique<MiniaudioBackend>();
}

} // namespace noveltea
