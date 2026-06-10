# NovelTea Runtime Skeleton

NovelTea is a native C++20 game/runtime skeleton targeting Linux desktop,
Android, and Web/Emscripten.

Current runtime stack:

- SDL3: platform, window, input, and lifecycle layer.
- bgfx: renderer backend on Linux desktop and Android when found by CMake.
- RmlUi + FreeType: runtime UI layer. This pass wires an engine-owned scaffold;
  the bgfx-backed RmlUi renderer is still TODO.
- Dear ImGui: optional dev/debug overlay only. It is controlled by
  `NOVELTEA_ENABLE_DEVTOOLS`.
- miniaudio: dependency available for a future audio backend.
- HarfBuzz: dependency available for future richer text shaping.

The core engine should remain independent from SDL, bgfx, RmlUi, and ImGui.

## Visual Smoke Test — Colored Triangle

The first real geometry rendering test is a colored triangle drawn every frame
on view 0. The triangle uses vertex/index buffers with per-vertex colors (red
top, green bottom-left, blue bottom-right) against the existing blue/purple
clear color.

`bgfx::dbgTextPrintf()` (the debug overlay text) is **not** a reliable
cross-platform rendering proof — it works on desktop OpenGL but may not appear
on all backends/platforms.  Always verify rendering with the triangle.

### Linux Desktop

```bash
cmake --preset linux-debug
cmake --build --preset linux-debug
SDL_VIDEODRIVER=x11 ./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Expected result:
- An SDL window opens with the blue/purple clear color.
- A red-green-blue triangle is visible in the center.
- Debug text (renderer name, size, etc.) may also appear on desktop.
- Resize updates the viewport.
- Escape or closing the window quits.

For WSL2/X11, use `SDL_VIDEODRIVER=x11`. If it is not set on Linux, the
platform layer sets SDL's video driver hint to `x11` before `SDL_Init()`.

Release build:

```bash
cmake --preset linux-release
cmake --build --preset linux-release
```

### Android

Android uses an SDL3 Android Archive (AAR) for the SDL Java activity classes and
native library, integrated via Prefab. The app native library is built from
source through CMake externalNativeBuild.

#### Prerequisites

Download the SDL3 AAR and place it at:

```
android/app/libs/SDL3-3.4.10.aar
```

The AAR provides `org.libsdl.app.SDLActivity` (Java) and `libSDL3.so` (native)
through Android Prefab.

You can obtain the AAR from the official SDL releases or build it yourself from
the SDL source tree. See <https://github.com/libsdl-org/SDL/releases>.

#### Build

```bash
cd android
./gradlew assembleDebug
```

The APK packages the following native libraries for each ABI:

| Library | Role |
|---|---|
| `libSDL3.so` | SDL3 runtime (shared, from AAR via Prefab) |
| `libnoveltea-sandbox.so` | App native library (shared, CMake target `noveltea-sandbox`) |

Current ABI targets: `arm64-v8a`, `armeabi-v7a`, `x86_64`.

Expected result:
- App launches.
- Blue/purple clear color appears.
- Red-green-blue triangle is visible in the center.
- No reliance on top-left debug text for visual proof.
- No shader-loading crashes.

Verify packaged native libraries:

```bash
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep -E 'lib.*/lib(SDL3|noveltea-sandbox)\.so'
```

Troubleshoot with the emulator smoke-test script:

```bash
cd android
bash run-emulator-debug.sh
```

Check adb logcat for engine/renderer/shader diagnostics:

```bash
adb logcat | grep -iE 'noveltea|renderer|bgfx|shader|triangle|AndroidRuntime|fatal|crash'
```

### Web / Emscripten

```bash
source ~/dev/emsdk/emsdk_env.sh
emcmake cmake --preset web-debug
cmake --build --preset web-debug
python3 -m http.server --directory build/web-debug/apps/sandbox 8080
```

Open <http://localhost:8080>.

The Web target uses `emscripten_set_main_loop_arg`; it does not run a blocking
forever loop. bgfx is currently disabled for Web in this pass, so the page and
console report that the renderer is stubbed. The triangle will not appear on
Web until bgfx is enabled for Emscripten.

## Layout

```text
engine/
  include/noveltea/
    app.hpp             # cross-platform app wrapper
    engine.hpp          # initialize/tick/shutdown runtime lifecycle
    platform.hpp        # SDL-owned platform abstraction
    renderer.hpp        # renderer abstraction
    ui_runtime.hpp      # RmlUi runtime UI scaffold
    ui_debug.hpp        # optional ImGui devtools abstraction
  src/
    app.cpp
    engine.cpp
    platform_sdl.cpp
    renderer_bgfx.cpp
    renderer_stub.cpp
    ui_runtime_rmlui.cpp
    ui_debug_imgui.cpp
    ui_debug_stub.cpp
apps/sandbox/
android/
web/
```

The tree is still named `engine/`; it now separates the platform, renderer,
runtime UI, and devtools responsibilities in code and build selection without a
large directory move.

## Runtime Flow

The engine exposes:

```text
initialize()
tick()
shutdown()
```

Desktop uses `Engine::run()` as a normal loop around `tick()`. Web registers
`tick()` with Emscripten.

Per-frame event order:

```text
SDL event -> DebugUI/ImGui -> RuntimeUI/RmlUi scaffold -> game/platform handling
```

Window resize events update the platform size, call `Renderer::resize(width,
height)`, and notify the runtime UI scaffold. Escape and window close request
quit through the platform abstraction.

## Build Options

- `NOVELTEA_ENABLE_BGFX=ON`: use bgfx when available for supported targets.
  Android and Web force the stub renderer in this pass.
- `NOVELTEA_ENABLE_DEVTOOLS=ON`: include Dear ImGui dev/debug overlay when the
  package is available.
- `NOVELTEA_USE_IMGUI`: deprecated alias; setting it OFF disables devtools.

## Stubbed Or TODO

- RmlUi renderer backend, SDL input translation, document loading, and text
  rendering.
- Dear ImGui rendering through bgfx. Current ImGui integration is input/state
  only; bgfx debug text is the visible desktop overlay.
- Web bgfx/WebGL renderer. The Web sandbox currently uses a visible shell plus
  console/page status with the stub renderer.
- Vulkan shader variants for the triangle (currently GLSL/GLES only; desktop
  forces OpenGL).
- miniaudio backend.
- HarfBuzz shaping integration beyond dependency availability.
- Shader auto-compilation at build time on all platforms (compiled `.h` headers
  are checked in as a fallback; see `engine/CMakeLists.txt` custom commands).
