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
- Android APK build was attempted on 2026-06-16. Gradle shader staging and native CMake configuration progressed with `BUILD_TESTING=OFF`, but the build did not complete because the x86_64 FetchContent Freetype download from `download.savannah.gnu.org` returned HTTP 502. Emulator runtime smoke remains unverified.
- Nested read-only reference clone `NovelTea` is dirty at `android/gradle/wrapper/gradle-wrapper.properties`; this was observed, not modified.
- RmlUi `LoadTexture` from file returns 0 — document `<img>` tags will not display until a decoder is added.

## Next Recommended Prompt

Add `bimg::imageParse`-based texture loading for `BgfxRenderInterface::LoadTexture` so that RmlUi can load PNG/JPEG images from files. Then begin the NovelTea text-lab migration: port BBCode parsing, style-run semantics, and per-glyph animation data from `NovelTea/` into backend-neutral `nt` text code.

# 2026-06-17 RmlUi bgfx Required-Path Refactor

## Implemented

- Split RmlUi runtime code into focused modules under `engine/src/ui/rmlui/`:
  - `rmlui_file_interface.*`
  - `rmlui_input_sdl3.*`
  - `rmlui_render_interface_bgfx.*`
  - `rmlui_system_interface_sdl3.*`
- Replaced the monolithic `ui_runtime_rmlui.cpp` renderer/platform implementation with a facade that owns initialization, document loading, resize, update, render, and shutdown.
- Added an explicit RmlUi bgfx view range: `ViewRuntimeUIBegin = 32` through `ViewRuntimeUIEnd = 63`.
- Implemented the basic RmlUi 6.2 `RenderInterface` methods in the bgfx backend:
  - Persistent compiled vertex/index buffers.
  - 32-bit RmlUi index support.
  - Packed normalized vertex color layout.
  - Geometry validation and double-release-safe cleanup.
  - `GenerateTexture` for premultiplied RGBA8 font textures.
  - `LoadTexture` through `AssetManager` plus `bimg::imageParse`, normalized to premultiplied RGBA8.
  - Texture dimension reporting and max texture-size checks.
  - Premultiplied alpha blending with source `ONE`, destination `INV_SRC_ALPHA`.
  - Scissor clamping for negative/offscreen rectangles.
  - Projection × transform × translated geometry order matching the GL3 shader semantics.
- Implemented SDL3 system/input coverage for elapsed time, clipboard, cursor selection, RmlUi logging, key/modifier conversion, mouse, wheel, text input, touch-as-pointer, mouse leave, and mouse capture during button drag.
- Changed `RuntimeUI::process_event` to return RmlUi event consumption and stopped consumed input from reaching gameplay click/key handling while preserving quit and resize processing.
- Tightened CMake configuration so `NOVELTEA_ENABLE_RMLUI=ON` requires a bgfx backend instead of compiling bgfx-dependent RmlUi code in a stub-renderer build.
- Linked the bgfx bimg decode targets required by RmlUi image loading.

## Verified

- `cmake --preset linux-debug`: passed.
- `cmake --build --preset linux-debug`: passed.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed, 13/13 tests.
- `cmake --preset web-debug`: passed.
- `cmake --build --preset web-debug`: passed; existing Emscripten SDL3 experimental warning remains.
- `cd android && ./gradlew --no-daemon :app:assembleDebug`: passed; existing Android Gradle plugin/SDK and third-party bgfx/bx warnings remain.
- `xvfb-run -a ./build/linux-debug/apps/sandbox/noveltea-sandbox --demo rmlui --frames 3`: passed; RmlUi initialized, loaded the demo document, rendered for the frame limit, and shut down cleanly.

## Not Complete

This is not GL3 parity and must not be described as production-complete RmlUi rendering yet.

- Non-rectangular clip masks are not implemented.
- Offscreen layers, layer compositing, saved layer textures, saved mask images, MSAA layer resolves, and reusable postprocess targets are not implemented.
- Filters (`opacity`, `blur`, `drop-shadow`, color matrix filters, saved masks) are not implemented.
- Compiled RmlUi shaders and standard gradients are not implemented.
- Visual feature gallery, pixel-readback visual smoke, web browser interaction test, Android emulator interaction test, and CI updates are not implemented.
- Image decode success is compiled and linked through bimg, but no dedicated image-decode unit fixture was added in this slice.

## Next Recommended Prompt

Implement the RmlUi layer stack and stencil clip-mask scheduler on top of the reserved bgfx view range. Keep it GPU-bookkeeping-testable before adding filters and gradients.

# 2026-06-17 RmlUi Foundation Checkpoint

## Implemented

- Corrected engine-facing RmlUi event consumption polarity:
  - RmlUi `true` now maps to `Ignored`.
  - RmlUi `false` now maps to `Consumed`.
  - `RuntimeUI::last_event_consumed()` records the last submitted event result.
- Added `UiEventDisposition` so the polarity is not represented as an ambiguous raw bool internally.
- Expanded SDL3 input/system integration:
  - Mouse coordinates scale through SDL3 window pixel density.
  - Window pixel-size and display-scale events update RmlUi dimensions and density ratio.
  - Mouse wheel uses the RmlUi 2D wheel API for horizontal and vertical deltas.
  - Return and keypad Return submit newline text input after key down.
  - SDL finger events now use real `Rml::Touch` lists with SDL finger IDs and normalized-to-context coordinate conversion.
  - Mouse capture is retained for button drag.
  - Cursor resources are created once, reused, and destroyed.
  - Arrow/default, pointer, text, move, resize, crosshair, unavailable, and `rmlui-scroll*` cursors are mapped.
  - `ActivateKeyboard` / `DeactivateKeyboard` use the actual SDL window and set the SDL3 text-input area from the RmlUi caret.
- Hardened runtime initialization/shutdown:
  - `RuntimeUI::initialize()` now fails if the bgfx RmlUi render interface is invalid.
  - Failed context/renderer initialization clears global RmlUi interfaces before destroying owned interfaces.
  - Shutdown clears global RmlUi interfaces after `Rml::Shutdown()`.
  - Initial context dimensions and density are derived from the SDL drawable/window when available.
- Replaced the one-view-per-geometry allocator with a testable render-pass scheduler:
  - Ordinary geometry for the same framebuffer reuses one sequential bgfx view.
  - Clear, resolve/copy/postprocess/layer/final-composite style boundaries create new passes.
  - Exhaustion returns no pass instead of reusing the final view.
  - Exhaustion is reported once and affected submissions are skipped.
- RmlUi image textures now omit point-filter flags so bgfx uses normal linear filtering.
- Added stricter `bimg::imageParse` output validation for RGBA8, one layer, 2D depth, one mip, and exact data size.

## Verified

- Baseline before changes: `cmake --build --preset linux-debug --target test` passed, 13/13 tests.
- `cmake --build --preset linux-debug`: passed.
- `cmake --build --preset linux-debug --target test`: passed, 18/18 tests.
- `cmake --preset web-debug`: passed.
- `cmake --build --preset web-debug`: passed; existing Emscripten SDL3 experimental and bx macro warnings remain.
- `cd android && ./gradlew :app:assembleDebug`: passed; existing Android SDK/AGP/CMake and bx macro warnings remain.

## Not Complete

This checkpoint does not complete the full requested RmlUi 6.2 advanced bgfx renderer.

# 2026-06-17 RmlUi Advanced Renderer Correctness Pass

## Implemented

- Replaced the malformed fullscreen quad/index-buffer composition path with a dedicated clip-space fullscreen triangle plan and a dedicated bgfx `rmlui_composite` program.
- Added `rmlui_composite` shader assets to the shader manifest and loader for Linux GLSL, Web ESSL 100, and Android ESSL 300 builds.
- Changed layer allocation from append-only pushed handles to a frame-local reusable temporary layer cursor:
  - Slot 0 remains the base layer.
  - `begin_frame()` resets temporary allocation.
  - Maximum nesting depth bounds resource growth.
  - Resize destroys and recreates layer resources safely.
- Removed the unused layer `in_use` flag.
- Stopped falling back to D16 for stencil-capable layers; missing D24S8 now prevents layer creation with a precise renderer error.
- Added per-layer clip-mask enabled/reference state and capped stencil generation before 8-bit overflow.
- Made `PushLayer()` failure return an invalid handle instead of masquerading as the current/base layer.
- Made pushed-layer clear use the current scissor rectangle as the bgfx view rect when scissoring is active.
- Removed `texture_handle_for_layer()` and stopped exposing framebuffer-owned color attachments through the ordinary releasable texture registry.
- Split texture ownership categories for external/generated textures, saved-layer textures, internal layer attachments, and postprocess resources.
- Tightened `ReleaseTexture()` so it only destroys externally/generated or saved-layer owned texture records.
- Made filtered `CompositeLayers()` fail clearly instead of silently rendering an unfiltered result.
- Added same-layer composition routing through a reusable scratch layer to avoid sampling from an attachment while writing to the same framebuffer.
- Added CPU-side planning helpers and tests for fullscreen triangle orientation, layer-pool bounds, stencil planning, Gaussian weights, and color-filter matrices.
- Added real compiled-filter records for standard scalar/color-matrix filter parameters; GPU application remains deferred.

## Verified

- Baseline before this pass: `ctest --test-dir build/linux-debug --output-on-failure` passed, 18/18 tests.
- `cmake --build --preset linux-debug`: passed.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed, 23/23 tests.
- `cmake --preset web-debug`: passed.
- `cmake --build --preset web-debug`: passed; existing Emscripten SDL3 experimental and bx macro warnings remain.
- `cd android && ./gradlew :app:assembleDebug`: passed; existing Android Gradle plugin/SDK, NDK CMake deprecation, and bx macro warnings remain.

## Not Complete

This pass fixes several foundational correctness bugs but still does not complete full RmlUi GL3 parity.

- Parent clip-mask geometry is not replayed into pushed layer stencil attachments yet, so inherited mask state is tracked but not fully raster-replayed.
- Reusable postprocess primary/secondary/tertiary/blend-mask framebuffers are not implemented.
- MSAA layer resources and resolve planning are not implemented.
- `SaveLayerAsTexture()` and `SaveLayerAsMaskImage()` remain unimplemented.
- GPU filter application remains unimplemented despite typed filter records.
- `CompileShader()`, `RenderShader()`, `ReleaseShader()`, and standard gradient rendering remain unimplemented.
- No visual feature gallery, Linux pixel-readback test, browser runtime smoke, or Android emulator smoke was added in this pass.

# 2026-06-17 RmlUi Layer/Postprocess Lifetime Fix

## Implemented

- Fixed same-layer composition pointer invalidation by ensuring scratch allocation cannot resize the layer vector and by reacquiring layer records after scratch target creation.
- Split production resource namespaces:
  - RmlUi layer pool for base and pushed temporary layers.
  - Separate postprocess pool for primary, secondary, tertiary, blend-mask, and scratch targets.
  - Saved texture ownership remains represented separately in texture records, though save APIs are still pending.
- Removed scratch allocation from the ordinary layer handle namespace.
- Made production `BgfxRenderInterface` own and use the same `LayerPoolPlan` and `PostprocessPoolPlan` classes covered by unit tests.
- Changed `PushLayer()` failure to return `LayerPoolPlan::InvalidLayer` (`UINT32_MAX`) instead of `0`, avoiding ambiguity with the valid base layer.
- Refactored layer composition submission into an explicit `CompositeOp` carrying source texture, destination framebuffer, blend mode, scissor state, stencil ref, pass kind, and pass name.
- Corrected same-layer composition sequence:
  - Copy source layer to scratch without destination stencil or destination scissor.
  - Composite scratch back to destination with destination scissor and destination clip metadata.
  - Avoid sampling from the texture owned by the framebuffer being written.
- Removed the global clip-mask-enabled source of truth for normal geometry and composition; submissions now derive stencil use from the destination `LayerRecord`.
- Destroy fullscreen-triangle geometry during normal renderer destruction.
- Kept fullscreen triangle dimension-independent across resize; resize recreates layers/postprocess targets but not the static fullscreen vertex buffer.
- Aligned documented bgfx view IDs with actual submission order: runtime RmlUi uses views 32-63, debug ImGui uses view 250.
- Extended filter records with drop-shadow offset/color storage and added a CPU color-matrix application helper documenting the current row-major convention.

## Verified

- Baseline before this pass: `ctest --test-dir build/linux-debug --output-on-failure` passed, 23/23 tests.
- `cmake --build --preset linux-debug`: passed.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed, 26/26 tests.
- `cmake --preset web-debug`: passed.
- `cmake --build --preset web-debug`: passed; existing Emscripten SDL3 experimental and bx macro warnings remain.
- `cd android && ./gradlew :app:assembleDebug`: passed; existing Android Gradle plugin compileSdk warning and bx macro warnings remain.

## Not Complete

This still is not complete RmlUi 6.2 advanced renderer parity.

- Parent clip-mask geometry is not actually replayed or shared into pushed layer stencil attachments yet.
- Stencil overflow still needs replay/normalization that preserves accumulated intersections.
- Saved layer textures and saved mask images are not implemented.
- GPU postprocess filters are not implemented.
- Gradient shader compilation/rendering is not implemented.
- Visual gallery, Linux readback, headless browser gallery smoke, and Android emulator smoke remain pending.

- `EnableClipMask` and `RenderToClipMask` are still stubs.
- `PushLayer`, `PopLayer`, and `CompositeLayers` are still stubs.
- `SaveLayerAsTexture` and `SaveLayerAsMaskImage` are still stubs.
- `CompileFilter`, `ReleaseFilter`, and all standard filters are still stubs/no-ops.
- `CompileShader`, `RenderShader`, `ReleaseShader`, and gradients are still stubs/no-ops.
- The base offscreen RmlUi layer, final premultiplied composition pass, MSAA layer resources, reusable postprocess targets, saved masks, filter chains, shader pipeline expansion, feature gallery, visual readback tests, and CI interaction tests remain unimplemented.

## Next Recommended Prompt

Implement the bgfx offscreen layer stack and final base-layer composition first, using the new pass scheduler as the ordering primitive. After that, add stencil clip-mask planning and GPU resources before starting filters or gradients.

# 2026-06-17 RmlUi Offscreen Layer Checkpoint

## Implemented

- Added real bgfx layer framebuffer resources to `BgfxRenderInterface`:
  - RGBA8 render-target color texture.
  - Depth/stencil attachment using D24S8 when available, with D16 fallback.
  - Lazy allocation and reuse at the current viewport size.
  - Resize invalidation and safe destruction.
- RmlUi rendering now targets an offscreen base layer instead of drawing ordinary UI geometry directly to the backbuffer.
- `begin_frame()` resets pass/layer/scissor/transform/clip state, ensures the base layer exists, and clears it to transparent black.
- `end_frame()` validates the layer stack and composites the base layer over the game backbuffer using premultiplied alpha.
- Implemented real unfiltered layer operations:
  - `PushLayer`
  - `PopLayer`
  - `CompositeLayers` for `Blend` and `Replace` without filters
- Added bgfx stencil clip-mask rendering for the active layer:
  - `EnableClipMask`
  - `RenderToClipMask(Set)`
  - `RenderToClipMask(SetInverse)`
  - `RenderToClipMask(Intersect)`
  - Normal geometry and layer composition honor the active stencil test.
- Extended the pass scheduler request with the bgfx framebuffer target so allocated views set the correct framebuffer.

## Verified

- `cmake --build --preset linux-debug`: passed.
- `cmake --build --preset linux-debug --target test`: passed, 18/18 tests.
- `xvfb-run -a ./build/linux-debug/apps/sandbox/noveltea-sandbox --demo rmlui --frames 3`: passed; no RmlUi unsupported-operation logs were emitted by the current demo document.
- `cmake --preset web-debug`: passed.
- `cmake --build --preset web-debug`: passed; existing Emscripten SDL3 experimental and bx macro warnings remain.
- `cd android && ./gradlew :app:assembleDebug`: passed; existing Android Gradle plugin/SDK and bx macro warnings remain.

## Not Complete

- Active clip masks are not replayed into newly pushed layers yet. The current implementation logs this exact limitation if RmlUi pushes a layer while a clip mask is active.
- `CompositeLayers` applies no filters yet. If filters are requested, it composites the unfiltered source and logs the limitation.
- `SaveLayerAsTexture` and `SaveLayerAsMaskImage` are still unimplemented.
- `CompileFilter` / `ReleaseFilter` and all standard filters are still unimplemented.
- `CompileShader` / `RenderShader` / `ReleaseShader` and all standard gradients are still unimplemented.
- Layer resources are non-MSAA today; capability-aware 2x MSAA and resolve textures still need to be added.

## Next Recommended Prompt

Add reusable non-MSAA postprocess targets plus a copy/resolve path. Use that to implement `SaveLayerAsTexture`, `SaveLayerAsMaskImage`, and filtered `CompositeLayers` before adding the individual filter shaders.
# 2026-06-16 Asset Architecture

## Implemented

- Replaced mandatory physical asset paths with `AssetBlob`/`AssetReader` results
  and source-local diagnostics.
- Added `SdlPackagedAssetSource`, `MemoryAssetSource`, and a deferred
  `ZipAssetSource` boundary.
- Moved asset mount configuration after SDL/platform initialization.
- Separated read-only runtime/project mounts from cache capability metadata and added a `WritableAssetSource` boundary for future AssetManager write APIs.
- Switched RmlUi to an AssetManager-backed `FileInterface`.
- Replaced the Python shader pipeline with CMake-only shader manifest, compilation, and verification scripts in `cmake/`.
- Added one CMake-owned staged runtime asset tree for desktop/web builds and Gradle-owned staging for Android APK assets.
- Added Catch2 v3 and CTest native tests for asset paths, sources, reader behavior, shader variant resolution, RmlUi file interface, shader verification, and generated-header absence.
- Added a GitHub Actions `shader-assets` job that builds `glsl-120`, `essl-100`, and `essl-300` once and feeds Linux, web, Android, and editor jobs as a downloaded artifact.

## Verified

- `cmake --preset linux-debug`
- `cmake --build --preset linux-debug`
- `ctest --test-dir build/linux-debug --output-on-failure`
- `cmake --preset web-debug`
- `cmake --build --preset web-debug`
- Linux sandbox smoke from the build tree and copied packaged layout with `noveltea-sandbox` plus `assets/`.

## Pending verification

- Full Android APK build after the external Freetype download is available.
- Android emulator launch/log smoke. This pass did not implement or run emulator verification.

## Deferred

- ZIP decompression.
- Metal, HLSL/D3D11, and SPIR-V/Vulkan shader variants.

See `docs/migration/reports/asset-architecture-2026-06-16.md`.
