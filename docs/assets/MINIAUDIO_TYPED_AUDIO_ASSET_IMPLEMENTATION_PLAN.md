# miniaudio Typed Audio Asset Implementation Plan

Date: 2026-06-28

## Purpose

Add audio to NovelTea without coupling the core engine, runtime session, scripting layer, or AssetManager public API to miniaudio. `AssetManager` should expose typed prepared audio asset APIs the same way it now exposes typed font/texture/shader/material APIs. The miniaudio implementation should live behind an audio backend adapter.

The immediate practical goal is to play MP3 assets stored in project assets. The first concrete fixtures are:

```text
apps/sandbox/assets/audio/notification.mp3
apps/sandbox/assets/audio/cello-loop.mp3
```

Runtime logical paths:

```text
project:/audio/notification.mp3
project:/audio/cello-loop.mp3
```

`notification.mp3` is a fire-and-forget sound effect. `cello-loop.mp3` is looping background music. The audio API needs to support both one-shot SFX and managed looping tracks that can be replaced, faded, and layered with other tracks.

## Current State

Existing audio files are only placeholders:

- `engine/include/noveltea/audio/audio_backend.hpp`
  - Defines only `AudioBackendInfo { const char* name = "none"; }`.
- `engine/include/noveltea/audio/audio_system.hpp`
  - Defines a stub `AudioSystem` whose `backend_info()` returns a default value.
- `engine/src/audio/miniaudio/miniaudio_backend.cpp`
  - Contains only a private `AudioBackendInfo{"miniaudio"}` constant.
- `engine/CMakeLists.txt`
  - Already includes `src/audio/miniaudio/miniaudio_backend.cpp` in the engine target.
  - `vcpkg.json` includes `miniaudio` and the installed header exists at `build/linux-debug/vcpkg_installed/x64-linux/include/miniaudio.h`.
- Asset/package support already preserves `audio/`, `music/`, and `sounds/` paths through import/export.
- `apps/sandbox/assets/audio/notification.mp3` has been added as a first SFX fixture.
- `apps/sandbox/assets/audio/cello-loop.mp3` has been added as a first looping BGM fixture.
- `AssetManager` now has the typed prepared-asset pattern for fonts and render assets. Audio should follow that pattern.

miniaudio findings from the installed header:

- MP3 decoding is built in unless `MA_NO_MP3` or `MA_NO_DECODING` is defined.
- `ma_engine` provides high-level playback.
- `ma_sound` is the normal high-level sound instance.
- `ma_decoder_init_memory()` can decode from bytes.
- `ma_resource_manager_register_encoded_data()` can register encoded bytes by name without requiring a real OS file path.
- `ma_resource_manager_data_source_init()` and `ma_sound_init_from_data_source()` can be used for resource-managed sounds.

SDL3 audio findings from the installed header:

- SDL3 audio is centered around `SDL_AudioStream`.
- Playback is usually a stream bound to an opened playback device, or a convenience stream returned by `SDL_OpenAudioDeviceStream()`.
- Audio devices/streams must be resumed explicitly after opening.
- SDL3 streams handle format conversion/resampling and expose gain controls, queued data, callbacks, locking, and bind/unbind operations.
- This reinforces the need for a backend-neutral NovelTea API. A future SDL3 audio backend can implement the same `AudioSystem` SFX/track API using streams, while the initial miniaudio backend implements it with `ma_engine`, `ma_sound`, and its resource manager.
- Do not mix SDL3 audio-device ownership with miniaudio device ownership in the same backend. Use miniaudio as the active backend initially; SDL3 audio should remain a future alternate backend or low-level platform reference.

## Desired Architecture

Core/runtime code must be backend agnostic.

```text
Core/runtime/scripting/UI
  -> AudioSystem / AssetManager typed audio API
      -> AudioBackend interface
          -> MiniaudioBackend implementation
              -> ma_engine / ma_resource_manager / ma_sound
```

`AssetManager` remains the typed prepared-asset facade:

```cpp
assets::AudioAsset audio = assets.load_audio(
    assets::AudioAssetRequest{.path = "project:/audio/demo.mp3", .mode = AudioLoadMode::Stream});
```

Gameplay/runtime systems should not see `ma_engine`, `ma_sound`, miniaudio result codes, or OS file paths.

## Backend-Neutral Public Types

Add engine-level audio handles and requests that do not expose miniaudio:

```cpp
namespace noveltea {

struct AudioClipHandle {
    uint32_t id = 0;
    explicit operator bool() const noexcept { return id != 0; }
};

struct AudioVoiceHandle {
    uint32_t id = 0;
    explicit operator bool() const noexcept { return id != 0; }
};

struct AudioTrackHandle {
    uint32_t id = 0;
    explicit operator bool() const noexcept { return id != 0; }
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
    bool loop = false;
};

struct AudioSfxDesc {
    float volume = 1.0f;
    float pitch = 1.0f;
    uint32_t max_simultaneous = 0; // 0 means backend/default policy.
};

struct AudioTrackDesc {
    AudioTrackId track_id = "bgm";
    AudioBus bus = AudioBus::Music;
    float volume = 1.0f;
    bool loop = true;
    float fade_in_seconds = 0.0f;
    float fade_out_seconds = 0.0f;
    AudioTrackReplaceMode replace_mode = AudioTrackReplaceMode::Replace;
};

} // namespace noveltea
```

Add typed asset records in `engine/include/noveltea/assets/typed_assets.hpp`:

```cpp
struct AudioAssetRequest {
    std::string path;
    AudioLoadMode mode = AudioLoadMode::Auto;
    AudioClipKind kind = AudioClipKind::Auto;
};

struct AudioAsset {
    AudioClipHandle clip;
    std::string path;
    AudioLoadMode mode = AudioLoadMode::Auto;
    AudioClipKind kind = AudioClipKind::Auto;
};

class AudioAssetLoader {
public:
    virtual ~AudioAssetLoader() = default;
    virtual AssetResult<AudioAsset> load_audio(const AudioAssetRequest& request) = 0;
};
```

Add to `AssetManager`:

```cpp
void bind_audio_loader(AudioAssetLoader* loader) const;
AssetResult<AudioAsset> load_audio(const AudioAssetRequest& request) const;
```

This mirrors the font/texture/shader/material pattern.

## Backend-Neutral Audio System API

Replace the stub `AudioSystem` with a frontend service that delegates to an abstract backend:

```cpp
class AudioBackend {
public:
    virtual ~AudioBackend() = default;
    virtual AudioBackendInfo backend_info() const = 0;
    virtual bool initialize(const assets::AssetManager& assets) = 0;
    virtual void shutdown() = 0;
    virtual assets::AssetResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) = 0;
    virtual AudioVoiceHandle play(AudioClipHandle clip, AudioPlaybackDesc desc) = 0;
    virtual void stop(AudioVoiceHandle voice) = 0;
    virtual void set_volume(AudioVoiceHandle voice, float volume) = 0;
};
```

`AudioSystem` should own or reference an `AudioBackend` but expose only neutral types:

```cpp
class AudioSystem final : public assets::AudioAssetLoader {
public:
    explicit AudioSystem(std::unique_ptr<AudioBackend> backend);
    bool initialize(const assets::AssetManager& assets);
    void shutdown();
    AudioBackendInfo backend_info() const;

    assets::AssetResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override;
    AudioVoiceHandle play(AudioClipHandle clip, AudioPlaybackDesc desc = {});
};
```

`Engine` owns `AudioSystem` and binds it to `AssetManager`:

```cpp
m_audio = AudioSystem(make_miniaudio_backend());
m_audio.initialize(m_assets);
m_assets.bind_audio_loader(&m_audio);
```

On shutdown, unbind before destroying:

```cpp
m_assets.bind_audio_loader(nullptr);
m_audio.shutdown();
```

## Miniaudio Backend Strategy

### Library integration

miniaudio is header-only but needs exactly one implementation translation unit:

```cpp
#define MINIAUDIO_IMPLEMENTATION
#include <miniaudio.h>
```

Put this in one implementation file, probably:

```text
engine/src/audio/miniaudio/miniaudio_backend.cpp
```

Add include discovery in CMake if needed:

```cmake
find_path(MINIAUDIO_INCLUDE_DIRS "miniaudio.h")
target_include_directories(engine PRIVATE ${MINIAUDIO_INCLUDE_DIRS})
```

The vcpkg output indicates this is the expected integration style.

### Loading from AssetManager, not OS paths

Do not use `ma_sound_init_from_file()` with a physical path for project assets. That would bypass `AssetManager`, fail on Web/Android packages, and leak backend policy into callers.

Instead:

1. `MiniaudioBackend::load_audio(request)` calls `AssetManager::read_binary(request.path)`.
2. Store the encoded bytes in backend-owned cache storage so the memory stays alive while miniaudio uses it.
3. Register the bytes with the miniaudio resource manager by logical path:

```cpp
ma_resource_manager_register_encoded_data(&resource_manager, path.c_str(), bytes.data(), bytes.size());
```

4. Initialize a resource-managed data source by logical path.
5. Initialize or later instantiate `ma_sound` from that data source.

For a first implementation, it is acceptable to simplify and decode/load synchronously on `load_audio()`, then instantiate `ma_sound` on `play()`. Avoid async until the sync path is tested.

### Clip versus voice

Separate loaded clip identity from playback instance:

- `AudioClipHandle`: cached encoded data / registered resource / clip metadata.
- `AudioVoiceHandle`: one active playing `ma_sound` instance.

One clip may be played multiple times concurrently by creating multiple voices.

### Decode versus stream

Initial policy:

- `AudioLoadMode::Auto`: use stream for MP3/OGG/music-like files; decode for small WAV/sfx later.
- `AudioLoadMode::Stream`: initialize `ma_sound` with stream/resource-manager behavior.
- `AudioLoadMode::Decode`: fully decode for lower-latency SFX.

The first MP3 test can use `Auto` or `Stream`.

## SFX, Track, and Bus Model

The public `AudioSystem` should offer two high-level playback styles.

### Single-fire sound effects

Sound effects are one-shot voices. They should be simple for scripts and UI code:

```cpp
audio.play_sfx("project:/audio/notification.mp3");
audio.play_sfx("project:/audio/notification.mp3", AudioSfxDesc{.volume = 0.8f});
```

Implementation behavior:

- `play_sfx()` loads through `AssetManager::load_audio()` if the clip is not already cached.
- SFX should default to `AudioBus::Sfx`, `AudioClipKind::Sfx`, and non-looping playback.
- SFX voices are fire-and-forget; callers may ignore the returned `AudioVoiceHandle`.
- Backend should clean up finished SFX voices automatically during `AudioSystem::update(dt)`.
- Optional `max_simultaneous` prevents spam for repeated UI sounds.
- `notification.mp3` is the first fixture for this path.

### Managed tracks

Tracks are named logical slots for looping or long-form audio. Replacing one track should not stop unrelated tracks.

Examples:

```cpp
audio.play_track("bgm", "project:/audio/cello-loop.mp3",
                 AudioTrackDesc{.track_id = "bgm", .fade_in_seconds = 1.0f});
audio.play_track("ambience/rain", "project:/audio/rain.mp3",
                 AudioTrackDesc{.track_id = "ambience/rain", .bus = AudioBus::Ambience});
audio.stop_track("bgm", 0.75f);
```

Semantics:

- `track_id` identifies the slot to replace or control. `"bgm"` should be the default BGM slot.
- `AudioTrackReplaceMode::Replace` fades/stops the currently active voice(s) in the same track slot before starting the new clip.
- `AudioTrackReplaceMode::Layer` allows another voice in the same named group without replacing existing voices. This supports simultaneous music layers or stingers.
- Independent track ids can play at the same time, for example `"bgm"`, `"ambience"`, and `"music/layer2"`.
- Track playback defaults to looping and `AudioBus::Music`.
- Track replacement should support `fade_out_seconds` for outgoing voices and `fade_in_seconds` for incoming voices.
- Fades should be managed by `AudioSystem::update(dt)` using neutral voice state, not miniaudio-specific callbacks exposed to core code.
- `cello-loop.mp3` is the first fixture for this path.

### Buses

Buses are logical volume groups. Initial buses:

- `Master`
- `Sfx`
- `Music`
- `Ambience`
- `Voice`

`AudioSystem` should expose neutral bus control:

```cpp
audio.set_bus_volume(AudioBus::Music, 0.7f);
audio.set_bus_volume(AudioBus::Sfx, 1.0f);
```

The miniaudio backend can map buses to `ma_sound_group` objects. A future SDL3 backend can map buses to per-stream or software-mixer gains. Scripts should only see NovelTea bus names, not backend group/stream objects.

## Scripting API Shape

The scripting API should be thin over `AudioSystem` and `AssetManager`, not a separate audio asset path resolver.

Initial Lua-facing API should be path-first:

```lua
audio.play_sfx("project:/audio/notification.mp3", { volume = 0.9 })
audio.play_track("bgm", "project:/audio/cello-loop.mp3", {
  loop = true,
  volume = 0.6,
  fade_in = 1.0,
  fade_out = 1.0,
})
audio.stop_track("bgm", { fade_out = 0.75 })
audio.set_bus_volume("music", 0.8)
```

Later alias support can layer on top of this:

```lua
audio.play_sfx_alias("ui.notification")
audio.play_track_alias("bgm", "music.cello_loop")
```

Scripting constraints:

- Scripts should be allowed to pass logical asset paths directly.
- Alias lookup, once added, should still resolve through project data and then call `AssetManager::load_audio()`.
- Script API should return neutral handles or booleans/errors, never miniaudio objects.
- Runtime session/cutscene controllers should call the same C++ `AudioSystem` API as Lua bindings.
- Audio failures should be non-fatal but visible as runtime diagnostics.

## Implementation Progress

Completed in the first usable audio slice:

- Added backend-neutral public audio handles, buses, clip/load/track enums, and playback descriptors.
- Added typed `AssetManager` audio facade types plus `bind_audio_loader()` and `load_audio()` with fake-loader tests.
- Replaced the stub `AudioSystem` with a backend-agnostic facade that implements `AudioAssetLoader`, forwards primitive playback to `AudioBackend`, and owns high-level SFX, track replacement/layering, bus volume, cleanup, and fade policy.
- Implemented the initial miniaudio backend behind neutral headers with exactly one `MINIAUDIO_IMPLEMENTATION` translation unit. It initializes `ma_resource_manager`/`ma_engine`, maps buses to `ma_sound_group`, loads project assets through `AssetManager::read_binary()`, keeps encoded bytes alive, registers encoded data with miniaudio, and creates voices from resource-manager data sources rather than direct OS file paths.
- Bound audio into `Engine` initialization/shutdown and added sandbox flags: `--audio-sfx project:/audio/notification.mp3` and `--audio-track bgm=project:/audio/cello-loop.mp3`.
- Added cross-platform miniaudio include discovery for desktop, Web/Emscripten, and Android. Web/Android use a fetched miniaudio header instead of the host vcpkg include tree so fetched bgfx headers stay ABI-matched with fetched bgfx libraries.
- Added exported browser/editor audio entry points for user-gesture playback of SFX, tracks, and track stopping.
- Added Lua `audio` bindings for SFX playback, track playback, track stopping, and bus volume. The sandbox RmlUi demo now includes a pitch slider and button that calls `audio.play_sfx("project:/audio/notification.mp3", { pitch = ... })` from Lua.
- Added a generic typed `ResourceAliasRegistry` with JSON manifest parsing for audio, textures, and materials. `AssetManager` can load `project:/resources/aliases.json`, resolve typed audio/texture/material aliases, and Lua can call `audio.play_sfx_alias()` / `audio.play_track_alias()`. The sandbox demo now uses `ui.notification` instead of hard-coding the MP3 path.

Remaining work after this pass:

- Add first-class Web UI/editor controls beyond the sandbox demo that call exported audio functions from a user click/tap, because browser WebAudio playback may be blocked until a user gesture unlocks audio.
- Add stronger diagnostics/telemetry for successful clip load and voice start events.
- Revisit true streaming for registered in-memory project assets. The current miniaudio path deliberately avoids `MA_RESOURCE_MANAGER_DATA_SOURCE_FLAG_STREAM` for registered encoded data because that flag makes miniaudio look for a backing file path; project assets are loaded from `AssetManager` bytes instead.
- Add pause/resume integration and user-facing runtime audio commands/events beyond aliases.

## Implementation Slices

### Slice 1: Neutral audio handles, backend API, and AssetManager audio facade

Likely files:

- `engine/include/noveltea/audio/audio_backend.hpp`
- `engine/include/noveltea/audio/audio_system.hpp`
- `engine/include/noveltea/assets/typed_assets.hpp`
- `engine/include/noveltea/assets/asset_manager.hpp`
- `engine/src/assets/asset_manager.cpp`
- `tests/assets/asset_manager_tests.cpp`

Tasks:

1. Add `AudioClipHandle`, `AudioVoiceHandle`, `AudioTrackHandle`, `AudioTrackId`, `AudioBus`, `AudioClipKind`, `AudioTrackReplaceMode`, `AudioLoadMode`, `AudioPlaybackDesc`, `AudioSfxDesc`, and `AudioTrackDesc` to public audio headers.
2. Add `AudioAssetRequest`, `AudioAsset`, and `AudioAssetLoader` to typed assets.
3. Add `bind_audio_loader()` and `load_audio()` to `AssetManager`.
4. Add fake-loader tests matching the existing typed font/texture/material tests.
5. Ensure `AudioAssetRequest` includes `kind` so SFX and music can choose different default load policies.

Acceptance:

- Core code can reference audio handles without including miniaudio.
- `AssetManager` can route typed audio requests without a backend.
- Tests prove missing-loader diagnostics and forwarding behavior.

### Slice 2: Implement AudioSystem as backend-agnostic facade

Likely files:

- `engine/include/noveltea/audio/audio_system.hpp`
- `engine/src/audio/audio_system.cpp`
- `engine/CMakeLists.txt`

Tasks:

1. Make `AudioSystem` own or receive an `AudioBackend`.
2. Implement `AudioSystem` as an `assets::AudioAssetLoader`.
3. Forward `load_audio`, `play`, `stop`, `set_volume`, SFX, track, and bus operations to the backend.
4. Preserve a no-backend/null-backend mode for tests or disabled audio builds.
5. Add `AudioSystem::update(float dt)` for voice cleanup and neutral fade progression.
6. Add convenience methods: `play_sfx(path, desc)`, `play_track(track_id, path, desc)`, `stop_track(track_id, fade_seconds)`, and `set_bus_volume(bus, volume)`.

Acceptance:

- Engine-facing audio code depends only on `AudioSystem` and neutral handles.
- No miniaudio symbols appear outside the miniaudio backend implementation.

### Slice 3: Implement MiniaudioBackend skeleton

Likely files:

- `engine/include/noveltea/audio/miniaudio_backend.hpp` or private `engine/src/audio/miniaudio/miniaudio_backend.hpp`
- `engine/src/audio/miniaudio/miniaudio_backend.cpp`
- `engine/CMakeLists.txt`

Tasks:

1. Add exactly one `#define MINIAUDIO_IMPLEMENTATION` translation unit.
2. Initialize `ma_engine` and `ma_resource_manager`.
3. Return `AudioBackendInfo{"miniaudio"}`.
4. Create miniaudio sound groups for buses: master, sfx, music, ambience, and voice.
5. Shut down in correct order.
6. Add a smoke/unit test that can initialize and shut down the backend if an audio device is available. Keep the test tolerant of headless CI if device initialization fails.
7. Keep SDL3 audio streams/devices out of this backend. SDL3 audio should be a future alternate backend, not a second device owner inside the miniaudio backend.

Acceptance:

- miniaudio is compiled and hidden behind backend headers.
- Engine can create/shutdown audio without leaking miniaudio types.

### Slice 4: Implement typed MP3 asset loading through AssetManager bytes

Likely files:

- `engine/src/audio/miniaudio/miniaudio_backend.cpp`
- `tests/audio/miniaudio_backend_tests.cpp` or sandbox smoke

Tasks:

1. Implement `MiniaudioBackend::load_audio()`:
   - read bytes from `AssetManager` using logical path;
   - store encoded bytes in backend cache;
   - register encoded data with `ma_resource_manager_register_encoded_data()`;
   - return an `AudioAsset` with `AudioClipHandle` and metadata.
2. Cache repeat loads by logical path and load mode.
3. Report clear errors for missing assets or decode/registration failures.
4. Confirm MP3 is supported by default in the miniaudio header.
5. Use `AudioClipKind::Sfx` for `project:/audio/notification.mp3` and prefer decoded/low-latency policy once decode mode is implemented.
6. Use `AudioClipKind::Music` for `project:/audio/cello-loop.mp3` and prefer streaming policy.

Acceptance:

- An MP3 placed at `apps/sandbox/assets/audio/<name>.mp3` can be loaded as `project:/audio/<name>.mp3`.
- Loading uses AssetManager bytes, not direct file paths.

### Slice 5: Playback API and sandbox demo hook

Likely files:

- `engine/src/audio/miniaudio/miniaudio_backend.cpp`
- `engine/src/engine.cpp`
- `apps/sandbox/main.cpp` if CLI flags are added
- optional runtime project fixture

Tasks:

1. Implement `play(AudioClipHandle, AudioPlaybackDesc)` by creating an active `ma_sound` voice.
2. Implement `play_sfx(path, desc)` as a fire-and-forget convenience path over `AssetManager::load_audio()` plus `play()`.
3. Implement track state: each `AudioTrackId` owns active voices and fading-out voices.
4. Implement `play_track(track_id, path, desc)`:
   - `Replace`: fade/stop current voices for that track id, then start the new clip.
   - `Layer`: start the new clip under the same track id without stopping existing voices.
5. Implement `stop_track(track_id, fade_seconds)`.
6. Implement voice cleanup for finished sounds.
7. Implement `stop()`, `set_volume()`, and bus volume controls.
8. Add a minimal sandbox path to test the provided MP3s:
   - `--audio-sfx project:/audio/notification.mp3`
   - `--audio-track bgm=project:/audio/cello-loop.mp3`
   - optional fade flags later, such as `--audio-fade-in 1.0` / `--audio-fade-out 1.0`.
9. Add `--no-audio` or make failure non-fatal for headless/CI if needed.

Acceptance:

- User can place an MP3 under `apps/sandbox/assets/audio/` and run a sandbox command to hear it.
- Runtime still starts when no audio device is available, with a clear warning.

### Slice 6: Runtime/controller integration

This can wait until the backend and asset path are proven.

Tasks:

1. Add runtime commands/events for BGM/SFX playback.
2. Bind Lua script APIs for:
   - `audio.play_sfx(path, options)`
   - `audio.play_track(track_id, path, options)`
   - `audio.stop_track(track_id, options)`
   - `audio.set_bus_volume(bus, volume)`
3. Ensure Lua APIs call the same `AudioSystem` methods as C++ runtime/cutscene code.
4. Add project schema support for audio aliases if desired.
5. Add pause/resume behavior tied to engine lifecycle.
6. Expose neutral handles only if scripts need them for advanced control; the default script workflow should be path/alias + options.

Acceptance:

- Dialogue/cutscene/runtime can trigger audio without seeing miniaudio.
- Audio assets are resolved through AssetManager.

## Where to Put the MP3

The first test files are already in the recommended location:

```text
apps/sandbox/assets/audio/notification.mp3
apps/sandbox/assets/audio/cello-loop.mp3
```

Runtime logical paths:

```text
project:/audio/notification.mp3
project:/audio/cello-loop.mp3
```

Use `notification.mp3` for `play_sfx()`. Use `cello-loop.mp3` for `play_track("bgm", ...)` with looping enabled.

For future long background music, either `audio/` or `music/` is acceptable:

```text
apps/sandbox/assets/music/<track>.mp3
project:/music/<track>.mp3
```

The package importer/exporter already preserves `audio/`, `music/`, and `sounds/`, so those are all viable.

## Testing Strategy

Focused build/tests:

```sh
cmake --build build/linux-debug --target noveltea_asset_tests -j1
./build/linux-debug/tests/noveltea_asset_tests --reporter compact
```

After backend compile:

```sh
cmake --build build/linux-debug --target noveltea_core_tests noveltea_asset_tests noveltea_ui_tests -j1
./build/linux-debug/tests/noveltea_core_tests --reporter compact
./build/linux-debug/tests/noveltea_asset_tests --reporter compact
./build/linux-debug/tests/noveltea_ui_tests --reporter compact
```

Audio-device-dependent tests should be opt-in or tolerant of failure because CI/headless environments may not expose a working output device.

Sandbox smoke once backend and CLI hooks exist:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox \
  --demo none \
  --runtime-project project:/projects/runtime_phase8.json \
  --audio-sfx project:/audio/notification.mp3 \
  --frames 120 \
  --no-imgui

./build/linux-debug/apps/sandbox/noveltea-sandbox \
  --demo none \
  --runtime-project project:/projects/runtime_phase8.json \
  --audio-track bgm=project:/audio/cello-loop.mp3 \
  --frames 300 \
  --no-imgui
```

## Risks and Constraints

Risk: miniaudio device initialization may fail on CI/headless machines.

Mitigation: audio backend init should fail gracefully or support a null backend fallback; tests that require actual playback should be opt-in.

Risk: `ma_resource_manager_register_encoded_data()` does not copy bytes.

Mitigation: backend cache must own encoded bytes for at least as long as the resource is registered and any sound/voice uses it.

Risk: streaming from memory can hold references into backend caches.

Mitigation: clips must be reference-counted or retained until all voices using them are stopped.

Risk: core engine accidentally includes miniaudio.

Mitigation: keep `#include <miniaudio.h>` only in `engine/src/audio/miniaudio/*`. Public headers expose neutral handles and interfaces only.

Risk: MP3 licensing/platform decode concerns.

Mitigation: miniaudio includes MP3 decode by default in this installed version. Keep decoder backend replaceable through `AudioBackend`.

Risk: track replacement and fades become miniaudio-specific.

Mitigation: store track/fade state in `AudioSystem` using neutral `AudioVoiceHandle` values and per-voice target volume. The backend only needs primitive play/stop/volume operations.

Risk: future SDL3 backend has a stream/callback model instead of miniaudio sound objects.

Mitigation: keep the public API in terms of clips, voices, tracks, and buses. SDL3 can implement voices as `SDL_AudioStream` instances or a software mixer feeding one device stream, because SDL3 audio is centered around streams and explicit device binding/resume.

## Exit Criteria

This plan is complete when:

- `AssetManager` exposes typed audio loading through `load_audio()`.
- Core/runtime code uses only neutral audio handles and `AudioSystem`/`AudioBackend` interfaces.
- miniaudio is hidden in the backend implementation.
- MP3 files under `project:/audio/` or `project:/music/` load through `AssetManager` bytes.
- The sandbox can play `project:/audio/notification.mp3` as a fire-and-forget SFX.
- The sandbox can play `project:/audio/cello-loop.mp3` as a looping `bgm` track.
- Replacing the `bgm` track can fade out the previous voice and fade in the new one.
- Multiple independent tracks can play simultaneously.
- Lua/script bindings expose the same SFX, track, bus, and typed asset APIs without exposing miniaudio or SDL3 objects.
- Audio failures are non-fatal where appropriate.
