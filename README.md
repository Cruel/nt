# NovelTea Runtime Skeleton

NovelTea is a native C++20 game/runtime skeleton targeting Linux desktop,
Android, and Web/Emscripten.

Current runtime stack:

- SDL3: platform, window, input, and lifecycle layer.
- bgfx: renderer backend on Linux desktop when found by CMake.
- RmlUi + FreeType: runtime UI layer. This pass wires an engine-owned scaffold;
  the bgfx-backed RmlUi renderer is still TODO.
- Dear ImGui: optional dev/debug overlay only. It is controlled by
  `NOVELTEA_ENABLE_DEVTOOLS`.
- miniaudio: dependency available for a future audio backend.
- HarfBuzz: dependency available for future richer text shaping.

The core engine should remain independent from SDL, bgfx, RmlUi, and ImGui.

## Build And Run

### Linux Desktop

```bash
cmake --preset linux-debug
cmake --build --preset linux-debug
SDL_VIDEODRIVER=x11 ./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Expected result: an SDL window opens, bgfx clears the screen, bgfx debug text
shows the renderer name and current size, resize updates the viewport, Escape
quits, and closing the window quits.

For WSL2/X11, use `SDL_VIDEODRIVER=x11`. If it is not set on Linux, the
platform layer sets SDL's video driver hint to `x11` before `SDL_Init()`.

Release build:

```bash
cmake --preset linux-release
cmake --build --preset linux-release
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
forever loop. bgfx is intentionally disabled for Web in this pass, so the page
and console report that the renderer is stubbed.

### Android

```bash
cd android
./gradlew assembleDebug
```

The Android sandbox target is a shared native library named
`libnoveltea-sandbox.so`. `AndroidManifest.xml` and
`MainActivity.getLibraries()` both reference `noveltea-sandbox`.

Android uses the stub renderer in this pass. The Gradle project still needs an
SDL3 Android runtime source/AAR that provides `org.libsdl.app.SDLActivity` and
the `SDL3` native library. Until that is wired locally, the APK build may fail
at Java or native dependency resolution.

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
- Android bgfx renderer and complete SDL3 Android runtime packaging.
- Web bgfx/WebGL renderer. The Web sandbox currently uses a visible shell plus
  console/page status with the stub renderer.
- miniaudio backend.
- HarfBuzz shaping integration beyond dependency availability.
