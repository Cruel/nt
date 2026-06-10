# NovelTea — Cross-Platform Engine Skeleton

Minimal cross-platform C++20 skeleton for a game/engine prototype targeting
**Linux desktop**, **Android**, and **Web (Emscripten)**.

## Prerequisites

### Ubuntu / WSL2

```bash
sudo apt update
sudo apt install build-essential cmake ninja-build git python3
```

### vcpkg (Linux desktop builds)

Install vcpkg and set `VCPKG_ROOT`:

```bash
git clone https://github.com/microsoft/vcpkg.git ~/dev/vcpkg
~/dev/vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=~/dev/vcpkg
# Add to ~/.bashrc or ~/.zshrc:
# echo 'export VCPKG_ROOT=~/dev/vcpkg' >> ~/.bashrc
```

### Emscripten (Web builds)

```bash
# Clone the SDK
git clone https://github.com/emscripten-core/emsdk.git ~/dev/emsdk
cd ~/dev/emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
export EMSDK=~/dev/emsdk
# Add to shell rc:
# echo 'source ~/dev/emsdk/emsdk_env.sh' >> ~/.bashrc
```

Verify: `emcmake --version`

### Android SDK/NDK

Verify `$ANDROID_HOME` points to your Android SDK:

```bash
echo $ANDROID_HOME
ls $ANDROID_HOME/ndk/  # should list installed NDK versions
```

If not set:
```bash
export ANDROID_HOME=~/Android/Sdk
# or
export ANDROID_HOME=/usr/lib/android-sdk
```

The NDK is detected from `$ANDROID_HOME/ndk/<version>/`.

## Build & Run

### Linux Desktop

```bash
cmake --preset linux-debug
cmake --build --preset linux-debug
./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Press **Escape** or close the window to quit.

### Android APK

```bash
cd android
./gradlew assembleDebug
```

The APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`.

Install it:
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

> **Note:** The Android build currently uses a **stub renderer** (no bgfx).
> See [Known Limitations](#known-limitations) below.

### Web (Emscripten)

```bash
emcmake cmake --preset web-debug
cmake --build --preset web-debug
```

Output files are in `build/web-debug/apps/sandbox/`. Serve locally:

```bash
python3 -m http.server --directory build/web-debug/apps/sandbox/ 8080
```

Then open http://localhost:8080 in a browser.

> **Note:** The Web build also uses a **stub renderer** (no bgfx).
> See [Known Limitations](#known-limitations) below.

## Project Structure

```
.
├── CMakeLists.txt              # Root CMake — orchestrator
├── CMakePresets.json           # Build presets (linux, web)
├── vcpkg.json                  # vcpkg manifest (Linux deps)
├── cmake/
│   ├── helpers.cmake           # Utility functions
│   └── toolchains/
│       ├── android.cmake       # NDK toolchain reference
│       └── emscripten.cmake    # Emscripten toolchain
├── engine/
│   ├── CMakeLists.txt          # Engine library build
│   ├── include/noveltea/       # Public API
│   │   ├── app.hpp             # Application entry point
│   │   ├── engine.hpp          # Core loop: init → update → render
│   │   ├── platform.hpp        # Windowing / input abstraction
│   │   ├── renderer.hpp        # Rendering abstraction
│   │   └── ui_debug.hpp        # Debug overlay abstraction
│   └── src/
│       ├── app.cpp
│       ├── engine.cpp
│       ├── platform_sdl.cpp    # SDL3 platform implementation
│       ├── renderer_bgfx.cpp   # bgfx renderer (desktop)
│       ├── renderer_stub.cpp   # Stub renderer (Android, Web)
│       └── ui_debug_imgui.cpp  # Dear ImGui overlay (desktop)
├── apps/
│   └── sandbox/
│       ├── CMakeLists.txt
│       └── main.cpp
├── android/                    # Android Gradle project
│   ├── settings.gradle
│   ├── build.gradle
│   └── app/
│       ├── build.gradle
│       └── src/main/
│           ├── AndroidManifest.xml
│           └── java/com/example/noveltea/MainActivity.java
├── web/                        # Web assets
│   ├── index.html
│   └── shell.html
└── third_party/README.md       # Dependency notes
```

## Architecture

The engine loop is structured as:

```
initialize()
  ├── Platform::initialize()    — SDL window, input
  ├── Renderer::initialize()    — bgfx (or stub)
  └── DebugUI::initialize()     — Dear ImGui (or disabled)

run() [each frame]
  ├── Platform::poll_events()   — SDL event queue
  ├── update(dt)                — game logic (empty in skeleton)
  └── render()
       ├── DebugUI::begin_frame()
       ├── Renderer::begin_frame()
       ├── bgfx debug overlay
       ├── DebugUI::end_frame()
       └── Renderer::end_frame()  → bgfx::frame()

shutdown() — reverse order
```

### Key design decisions

- **No game logic in platform code.** SDL specifics stay in `platform_sdl.cpp`.
- **No global state** except where SDL/bgfx require it (managed internally).
- **Platform-specific code** is compiled conditionally; core engine headers are
  target-agnostic.
- **ImGui is dev tooling only**, not the primary game UI.
- **Stub renderer** used where bgfx isn't yet built (Android, Web).

## Known Limitations

1. **bgfx rendering is Linux-only.** The CMake build detects bgfx via vcpkg.
   Android and Web targets fall back to `renderer_stub.cpp` (no-op).
   - *To fix:* Cross-compile bgfx for Android NDK and Emscripten, then
     `find_package(bgfx)` will enable the real renderer.

2. **Dear ImGui input works; rendering is placeholder.**
   The `ImGui_ImplSDL3` input backend is active for desktop, but ImGui draw
   data is not yet rendered via bgfx (needs custom shaders compiled with
   `shaderc` from the bgfx tools).
   - *Workaround:* Engine debug overlay uses `bgfx::dbgTextPrintf` for now.

3. **Android needs SDL3 Java source.**
   `MainActivity` extends `org.libsdl.app.SDLActivity`. The SDL3 source
   (or AAR) must be available in the project. A common approach is to add
   SDL3 as a Git submodule under `android/app/src/main/java/org/`.
   See [SDL3 Android docs](https://wiki.libsdl.org/SDL3/README/android).

4. **Emscripten needs `-sUSE_SDL=3` flag** (already in CMakeLists.txt).
   bgfx for Emscripten requires a custom build; not yet configured.

5. **RmlUi is declared in vcpkg.json but not yet integrated** into the engine
   loop. The headers and libraries are available for desktop; integration
   setup will be done in a future pass.

## Next Steps

- Integrate bgfx shader pipeline for full ImGui rendering.
- Cross-compile bgfx for Android NDK.
- Cross-compile bgfx for Emscripten (WebGL backend).
- Wire SDL3 Java source into the Android Gradle module.
- Integrate RmlUi with a shared renderer path (bgfx + custom shaders).
- Add miniaudio for audio playback.
