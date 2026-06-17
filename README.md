# NovelTea Runtime Skeleton

NovelTea is a native C++20 game/runtime skeleton targeting Linux desktop,
Android, and Web/Emscripten.

Current runtime stack:

- SDL3: platform, window, input, and lifecycle layer.
- bgfx: renderer backend on Linux desktop and Android when found by CMake.
- RmlUi + FreeType: runtime UI layer with a bgfx-backed render interface.
- Dear ImGui: optional dev/debug overlay only. It is controlled by
  `NOVELTEA_ENABLE_DEVTOOLS`.
- AssetManager: backend-neutral logical asset lookup over mounted directory
  roots. It currently reads bytes/text from directories and is intended to gain
  `.ntzip` package sources later.
- miniaudio: dependency available for a future audio backend.
- HarfBuzz: dependency available for future richer text shaping.

The core engine should remain independent from SDL, bgfx, RmlUi, and ImGui.

## Runtime UI / RmlUi

RmlUi is integrated through SDL3 for platform input/system services and bgfx for
rendering. The public `RuntimeUI` facade owns RmlUi initialization, document
loading, resize, frame begin/end, and shutdown; bgfx handles stay private to the
RmlUi bgfx backend.

The current bgfx implementation covers RmlUi's required rendering path:
compiled geometry, 32-bit indices, generated font textures, image textures
loaded through `AssetManager` and bimg, rectangular scissoring, transforms, and
premultiplied-alpha composition. RmlUi textures are uploaded as RGBA8 with RGB
premultiplied by alpha. The blend state uses source `ONE` and destination
`INV_SRC_ALPHA`, matching RmlUi's premultiplied contract.

Supported file image formats are those decoded by the linked bimg decoder for
the current platform, including PNG, JPEG, and TGA in the configured bgfx
package. RmlUi document-relative paths first resolve under `project:/rmlui/`,
while explicit logical paths such as `project:/...` and `system:/...` are
preserved.

RmlUi reserves bgfx views 32 through 63. The allocator resets every RmlUi frame
and assigns sequential views for submitted RmlUi geometry. Game rendering uses
view 0, text lab uses view 2, and debug UI uses its own debug view, so runtime
UI submissions do not reuse those IDs.

Advanced GL3-parity features are not complete yet: stencil clip masks, offscreen
layer compositing, saved layer textures/masks, filters, and compiled gradients
currently report unsupported operations instead of silently succeeding.

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

### Run Scripts

A centralized set of scripts is provided in the `scripts/` directory to build and run the project for different targets:

- **Desktop (Linux)**: `./scripts/run-desktop.sh`
- **Web (Emscripten)**: `./scripts/run-web.sh`
- **Android (Emulator)**: `./scripts/run-android.sh`

#### Desktop (Linux)

```bash
./scripts/run-desktop.sh
```

#### Web / Emscripten

Ensure you have the Emscripten SDK sourced in your environment.

```bash
./scripts/run-web.sh
```

The script will start a local server at <http://localhost:8080>.

#### Android

```bash
./scripts/run-android.sh
```

The Web target uses `emscripten_set_main_loop_arg`; it does not run a blocking
forever loop. The current Web debug preset builds the bgfx path, so the canvas
should show the triangle smoke test and bgfx-backed debug overlay unless bgfx or
devtools are explicitly disabled.

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

### Shader Assets

Shader source stays in `engine/shaders/bgfx/*.sc`. Normal builds do not compile
or include generated C headers. Instead, `shaderc` writes compiled `.bin`
assets under:

```text
build/<preset>/assets/shaders/bgfx/
  linux-glsl/
  android-essl/
  web-essl100/
```

Runtime bgfx code loads built-in programs by logical asset paths such as
`system:/shaders/bgfx/linux-glsl/triangle.vs.bin` through `AssetManager`.
`NOVELTEA_COMPILE_SHADERS=ON` requires `shaderc` from `bgfx[tools]`.
`NOVELTEA_COMPILE_SHADERS=OFF` means use existing compiled shader assets under
the configured build asset directory; it no longer means "use committed shader
headers".

Future runtime packages should use this layout:

```text
assets/
  shaders/bgfx/linux-glsl/
  shaders/bgfx/android-essl/
  shaders/bgfx/web-essl100/
  fonts/
  images/
  audio/
  ui/
  text/
```

Editable project packages may include shader source, but runtime packages need
compiled shader binaries. Universal runtime packages need compiled shader
variants for each supported target. The runtime does not compile shader source.

### ImGui Debug Overlay (bgfx-backed)

When `NOVELTEA_ENABLE_DEVTOOLS=ON` (the default) and both `bgfx` and `imgui`
packages are found, the ImGui debug overlay is rendered through bgfx on a
separate view (250) on top of the scene.  The backend owns:

* GLSL/ESSL shaders for ImGui `ImDrawVert` rendering (`vs_imgui.sc`,
  `fs_imgui.sc`), compiled to runtime-loaded `.bin` shader assets.
* A bgfx program, sampler uniform, and 2D font texture.
* Transient vertex/index buffers for per-frame ImDrawData submission.

The ImGui window displays FPS, frame time, renderer name, viewport size,
backend name, and a trianglsmoke test indicator.  It is movable and
collapsible on desktop and Android.

If `NOVELTEA_ENABLE_DEVTOOLS=OFF`, the stub `ui_debug_stub.cpp` is compiled
and no ImGui code is linked.  Release/player builds can safely disable
devtools without losing the triangle rendering.

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
  The triangle smoke test uses view 0; the ImGui overlay uses view 250.
- `NOVELTEA_ENABLE_DEVTOOLS=ON`: include Dear ImGui dev/debug overlay when the
  package is available.  When both bgfx and ImGui are present, the overlay is
  rendered through bgfx.
- `NOVELTEA_COMPILE_SHADERS=ON`: compile bgfx shader `.sc` sources into build
  asset `.bin` files using `shaderc`.
- `NOVELTEA_COMPILE_SHADERS=OFF`: require those compiled shader assets to
  already exist; generated/committed C headers are not used.
- `NOVELTEA_USE_IMGUI`: deprecated alias; setting it OFF disables devtools.

## Stubbed Or TODO

- Vulkan shader variants for the triangle (currently GLSL/GLES only; desktop
  forces OpenGL).
- miniaudio backend.
- HarfBuzz shaping integration beyond dependency availability.
