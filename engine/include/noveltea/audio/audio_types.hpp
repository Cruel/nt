#pragma once

#include <cstdint>
#include <string>

namespace noveltea {

struct AudioClipHandle {
    uint32_t id = 0;
    [[nodiscard]] explicit operator bool() const noexcept { return id != 0; }
    [[nodiscard]] friend bool operator==(AudioClipHandle, AudioClipHandle) = default;
};

struct AudioVoiceHandle {
    uint32_t id = 0;
    [[nodiscard]] explicit operator bool() const noexcept { return id != 0; }
    [[nodiscard]] friend bool operator==(AudioVoiceHandle, AudioVoiceHandle) = default;
};

struct AudioTrackHandle {
    uint32_t id = 0;
    [[nodiscard]] explicit operator bool() const noexcept { return id != 0; }
    [[nodiscard]] friend bool operator==(AudioTrackHandle, AudioTrackHandle) = default;
};

using AudioTrackId = std::string;

enum class AudioBus {
    Master,
    Sfx,
    Music,
    Ambience,
    Voice,
};

enum class AudioClipKind {
    Auto,
    Sfx,
    Music,
    Ambience,
    Voice,
};

enum class AudioTrackReplaceMode {
    Replace,
    Layer,
};

enum class AudioLoadMode {
    Auto,
    Decode,
    Stream,
};

struct AudioPlaybackDesc {
    AudioBus bus = AudioBus::Sfx;
    float volume = 1.0f;
    float pitch = 1.0f;
    bool loop = false;
};

struct AudioSfxDesc {
    float volume = 1.0f;
    float pitch = 1.0f;
    uint32_t max_simultaneous = 0;
};

struct AudioTrackDesc {
    AudioTrackId track_id = "bgm";
    AudioBus bus = AudioBus::Music;
    float volume = 1.0f;
    float pitch = 1.0f;
    bool loop = true;
    float fade_in_seconds = 0.0f;
    float fade_out_seconds = 0.0f;
    AudioTrackReplaceMode replace_mode = AudioTrackReplaceMode::Replace;
};

} // namespace noveltea
