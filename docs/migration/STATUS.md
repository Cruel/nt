# Migration Status

## Implemented

- Added an Electron editor engine-preview demonstration:
  - Main process loopback-only HTTP server serving the Emscripten sandbox output from `build/web-debug/apps/sandbox`.
  - Typed preload IPC for preview session/reload only.
  - React iframe preview using a tokened `MessageChannel` handshake.
  - Zustand-backed preview position, running, connection state, selected runtime object, and status message.
  - Emscripten shell bridge translating typed editor commands to exported C functions and C++ events back to the editor.
  - Engine-owned demo triangle position/running state, bgfx model transform submission, and point-in-triangle hit testing.
  - No-op desktop/Android preview bridge implementations.
  - Forge packaging hook for optional `web-release` preview resources under `process.resourcesPath/engine-preview`.

- Split renderer/platform/audio source organization without adding new runtime features:
  - bgfx renderer implementation moved under `engine/src/render/bgfx/`, split into lifecycle, resource RAII, quad batch submission, embedded shader loading, and the current PPM texture proof.
  - SDL platform implementation moved under `engine/src/platform/sdl/`, with public `Platform` state hiding SDL window/event storage behind opaque accessors and a private SDL access header for engine internals.
  - Added backend-neutral placeholder headers for future renderer texture/shader/material/backend seams, platform input/window event seams, and audio backend/system seams.
  - Added `engine/src/audio/miniaudio/miniaudio_backend.cpp` as an organizational placeholder only; no audio smoke behavior was added.
- Added feature flags: `NOVELTEA_ENABLE_RENDER2D`, `NOVELTEA_ENABLE_RMLUI`, `NOVELTEA_ENABLE_TEXT_LAB`; existing bgfx/devtools flags remain.
- Added backend-neutral helper headers for geometry, render commands/resources, assets, and text-run shape.
- Added minimal file loading and SDL-backed diagnostics.
- Added backend-neutral `noveltea::assets::AssetManager` with logical `system:/`, `project:/`, and `cache:/` mounts, directory-backed asset sources, binary/text reads, path traversal rejection, and lookup diagnostics.
  - Shader loaders, text font loading, and RmlUi setup now consume logical asset paths through the mounted roots. The old `noveltea::resolve_asset_path()` helper remains as compatibility for narrow legacy proofs.
- Added bgfx RAII wrappers for texture and program handles.
- Added graceful sandbox smoke-test controls:
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --frames 180`
  - `NOVELTEA_SMOKE_FRAMES=180 ./build/linux-debug/apps/sandbox/noveltea-sandbox`
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`
- Fixed the shutdown abort by removing the process-lifetime `static App` in `apps/sandbox/main.cpp` and explicitly shutting the engine down before process exit. This keeps bgfx shutdown ahead of bx/bgfx static teardown.
- Made `Platform::shutdown()` idempotent so explicit engine shutdown and destructors do not double-call SDL shutdown.
- Extended bgfx renderer with documented view IDs, orthographic 2D setup, alpha-blended colored quads, and a reusable `QuadBatch` / `QuadCommand` path for colored and textured quads with UV rects, per-quad color/alpha, and layer/depth metadata.
- Added a tiny disk texture proof at `apps/sandbox/assets/checker.ppm`, loaded through the asset file layer and converted to a bgfx texture. The procedural checker remains as fallback.
- Added sandbox demo selection and debug overlay status for renderer, size, frame count, frame time, Render2D, texture loading, RuntimeUI/RmlUi, and text lab.
- Added text-lab scaffold status through renderer debug text.
- Added bootstrap and rendering-stack documentation plus local exploration reports.
- Added a staged old NovelTea migration plan.
- Added read-only bootstrap review report at `docs/migration/reports/bootstrap-review.md`.
- **RmlUi/bgfx runtime UI backend**: Full implementation replacing the linked scaffold.
  - `BgfxRenderInterface` subclass of `Rml::RenderInterface` with vertex/index buffer compilation, texture generate/release, scissor support, and orthographic projection using `ViewRuntimeUI` (view ID 1).
  - Minimal `BgfxSystemInterface` with SDL3 high-resolution timer.
  - SDL3 event translation: mouse motion/button/wheel, keyboard key down/up, text input, key modifier state.
  - Window resize propagation to RmlUi context dimensions and render interface.
  - SDL-backed `Rml::FileInterface` so font/document/stylesheet loading can use SDL platform file handling, including Emscripten preloaded files and Android packaged assets.
  - Font loading from logical asset `rmlui/LiberationSans.ttf`.
  - Demo document and stylesheet at logical assets `rmlui/demo.rml` / `rmlui/demo.rcss`.
  - Web links RmlUi through FetchContent, uses Emscripten FreeType, and preloads the sandbox asset tree to `/assets`.
  - Android links RmlUi through FetchContent, builds a minimal FreeType dependency per ABI, and packages the sandbox asset tree under `assets/` in the APK.
  - Panel with heading, text, button, and status box. The button is a visual/input smoke target; no C++ click listener is attached yet.
  - Runtime overlay status reports "rendering" when active.
  - Shutdown order: `Rml::RemoveContext` → `Rml::Shutdown` → interface destruction (before bgfx shutdown via Engine shutdown order).
  - RmlUi bgfx shaders (`vs_rmlui.sc` / `fs_rmlui.sc`) compile to runtime-loaded bgfx shader `.bin` assets.
- Replaced committed/generated bgfx shader headers with runtime-loaded compiled shader asset files:
  - CMake target `noveltea-shaders` writes `${CMAKE_BINARY_DIR}/assets/shaders/bgfx/{linux-glsl,android-essl,web-essl100}/<name>.(vs|fs).bin`.
  - Built-in bgfx programs (`triangle`, `quad`, `text`, `rmlui`, `imgui`) load through private `BgfxShaderLoader` using `AssetManager`; public asset APIs stay backend-neutral.
  - `NOVELTEA_COMPILE_SHADERS=OFF` now requires existing compiled shader assets and fails during configure if they are missing.
  - Intended future `.ntzip` runtime layout is `assets/shaders/bgfx/...`, `fonts/`, `images/`, `audio/`, `ui/`, and `text/`; runtime packages need compiled shader variants and do not compile shader source.

## Verified

Verification results from the current pass:

- Minimal SDF text/font primitive:
  - Added backend-neutral public text/font types: `FontHandle`, `FontDesc`, `TextStyle`, `TextRun`, `TextMetrics`, and `TextBuffer`.
  - Added bgfx-backed SDF text rendering under `engine/src/render/bgfx/text/`, using a small `stb_truetype` SDF atlas path inspired by bgfx `examples/11-fontsdf`.
  - Added text shaders (`vs_text.sc` / `fs_text.sc`) for glsl, essl, and web profiles.
  - Added `Renderer::load_font`, `Renderer::draw_text`, `Renderer::measure_text`, and `Renderer::draw_demo_text`.
  - The sandbox `--demo text` and `--demo all` paths render normal, scaled, colored, outlined, and drop-shadow SDF text using the existing `rmlui/LiberationSans.ttf` asset.
  - SDF quality pass: atlas sampling now uses linear filtering with clamp addressing, SDF bake settings are tunable through `FontDesc`, the default smoke font uses a 96 px source into a 1024x1024 atlas, and `fs_text.sc` uses `fwidth(dist)` with a minimum softness uniform for scale-aware antialiasing while continuing to sample distance from the atlas alpha channel.
  - The text demo now renders plain quality-test samples at 18, 24, 32, 48, and 72 px before a transformed sample and the separate outline/drop-shadow sample.
  - `cmake --preset linux-debug`: passed.
  - `cmake --build --preset linux-debug`: passed.
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo text --frames 180`: passed; SDF text renderer initialized, loaded the font atlas, and exited through normal shutdown.
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`: passed; existing render2d, RmlUi, and ImGui paths still initialized and shut down cleanly.
  - `cmake --preset web-debug`: passed.
  - `cmake --build --preset web-debug`: passed; existing Emscripten SDL3 experimental warnings and bx macro warnings remain.
  - `cd android && ./gradlew --no-daemon :app:assembleDebug -PnovelteaCompileShaders=OFF`: passed; existing Android SDK/AGP/CMake and bx macro warnings remain.

- Electron engine preview slice:
  - `cmake --preset web-debug`: passed.
  - `cmake --build --preset web-debug --target noveltea-sandbox`: passed; generated preview runtime at `build/web-debug/apps/sandbox` (`index.html`, `index.js`, `index.wasm`, `index.data`). Existing Emscripten SDL3 experimental warnings and bx macro warnings remain.
  - `cmake --preset linux-debug`: passed.
  - `cmake --build --preset linux-debug --target noveltea-sandbox`: passed.
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --frames 3`: passed; frame-limited smoke exited through normal shutdown.
  - `cd editor && pnpm install`: passed.
  - `cd editor && pnpm typecheck`: passed.
  - `cd editor && pnpm lint`: passed.
  - `cd editor && pnpm test`: passed, 22 tests.
  - `cd editor && pnpm package`: passed.
  - `cd android && ./gradlew --no-daemon :app:assembleDebug`: passed; existing Android SDK/AGP and third-party CMake warnings remain.
  - `cd editor && timeout 12s pnpm start`: Vite/Electron targets built, but the Electron runtime exited in this container because Chromium reported the GPU process was unusable.

- Renderer/platform/audio layout refactor:
  - `cmake --preset linux-debug`: passed.
  - `cmake --build --preset linux-debug`: passed; existing unused `demo_mode_name` warning remains.
  - `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`: passed; frame-limited smoke exited through normal shutdown.
  - `cmake --preset web-debug`: passed.
  - `cmake --build --preset web-debug`: passed; existing Emscripten SDL3 experimental warnings remain.
  - `cd android && ./gradlew --no-daemon :app:assembleDebug -PnovelteaCompileShaders=OFF`: passed; existing Android SDK/AGP and third-party CMake warnings remain.

- `cmake --preset linux-debug`: passed.
- `cmake --build --preset linux-debug`: passed.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --frames 180`: passed; exited through normal engine shutdown with no `pure virtual method called`.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`: passed; same clean shutdown path.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo rmlui --frames 180`: passed; RmlUi initializes, loads font, loads demo document, renders, and shuts down cleanly with no "still actively referenced" warning.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 3`: passed after asset-root standardization; checker texture, RmlUi font, and RmlUi document all loaded through the shared asset resolver.
- `cmake --preset web-debug`: passed; RmlUi and Emscripten FreeType enabled.
- `cmake --build --preset web-debug`: passed; RmlUi assets preloaded; Emscripten emitted SDL3 experimental warnings.
- `cd android && ./gradlew :app:assembleDebug`: passed; RmlUi/FreeType built for `arm64-v8a`, `armeabi-v7a`, and `x86_64`; Android Gradle plugin warned that compileSdk 35 is newer than the plugin's tested SDK.
- CI SDL dependency fix pass:
  - `source "$EMSDK/emsdk_env.sh" && emcmake cmake --preset web-debug -G Ninja -DNOVELTEA_COMPILE_SHADERS=OFF && cmake --build --preset web-debug`: passed after clearing stale local web CMake generated files.
  - `unzip -p SDL3-devel-3.4.10-android.zip SDL3-3.4.10.aar`: passed; confirmed the release archive stores the AAR at the zip root.
  - `cd android && ./gradlew --no-daemon :app:assembleDebug -PnovelteaCompileShaders=OFF`: passed.
- CI shader/CMake follow-up:
  - Historical note: previous web/android `NOVELTEA_COMPILE_SHADERS=OFF` checks used generated shader headers. Current builds must provide compiled shader `.bin` assets instead.
  - `yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "cmake;3.31.6"`: passed locally.
  - `cd android && ./gradlew --no-daemon :app:assembleDebug -PnovelteaCompileShaders=OFF`: passed with Gradle selecting Android SDK CMake 3.31.6.
- Web clean-checkout ImGui ini cleanup:
  - `source "$EMSDK/emsdk_env.sh" && emcmake cmake --preset web-debug -G Ninja -DNOVELTEA_COMPILE_SHADERS=OFF && cmake --build --preset web-debug`: passed; web no longer preloads or seeds `imgui.ini`, leaving ImGui to create `/persist/imgui.ini` when settings are saved.

## Stubbed Or Deferred

- bimg image loading, high-quality font/glyph rendering, render targets, shader/material/uniform feature work, and an audio/miniaudio smoke test remain deferred. The current pass was source layout only.
- RmlUi file texture loading (`LoadTexture` from image files). Generates correct textures from font glyph bitmaps (`GenerateTexture`), but disk image files (PNG/JPEG) return 0 until a decoder is added (bimg::imageParse or stb_image).
- RmlUi Debugger integration.
- Clip mask, layer stack, filter/shader compilation (advanced RmlUi rendering features).
- bimg/bgfx_utils PNG/JPEG/etc. image texture loading. Current disk texture support is intentionally limited to a tiny ASCII PPM proof so no large external helper tree or decoder was copied.
- Text shaping and rich text features remain deferred. The current primitive is an ASCII/UTF-8 best-effort SDF atlas path with simple line metrics, transient quads, color, outline, and drop shadow only.
- The SDF text pass is still single-channel SDF from `stb_truetype`; small text, complex scripts, kerning/shaping, and high-quality strokes remain future work. HarfBuzz, MSDF/msdfgen, BBCode/TextTypes/ActiveText, and RmlUi text migration were intentionally not added in this slice.
- BBCode/TextTypes/ActiveText migration, per-glyph animation, HarfBuzz shaping, text pagination, hit-testing, and render-target text caching are deferred.
- NovelTea old-engine code migration. Stage G was not started because the text/font gate is not complete.

## Known Risks

- The minimal PPM loader is only a framework proof. The next texture slice should use `bimg::imageParse` through the existing bgfx/bimg targets instead of expanding this ad hoc path.
- Web/Android now fetch RmlUi, and Android also fetches FreeType. Fresh builds need network access or a populated CMake FetchContent cache.
- Nested read-only reference clone `NovelTea` is dirty at `android/gradle/wrapper/gradle-wrapper.properties`; this was observed, not modified.
- RmlUi `LoadTexture` from file returns 0 — document `<img>` tags will not display until a decoder is added.

## Next Recommended Prompt

Add `bimg::imageParse`-based texture loading for `BgfxRenderInterface::LoadTexture` so that RmlUi can load PNG/JPEG images from files. Then begin the NovelTea text-lab migration: port BBCode parsing, style-run semantics, and per-glyph animation data from `NovelTea/` into backend-neutral `nt` text code.
