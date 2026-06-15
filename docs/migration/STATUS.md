# Migration Status

## Implemented

- Added feature flags: `NOVELTEA_ENABLE_RENDER2D`, `NOVELTEA_ENABLE_RMLUI`, `NOVELTEA_ENABLE_TEXT_LAB`; existing bgfx/devtools flags remain.
- Added backend-neutral helper headers for geometry, render commands/resources, assets, and text-run shape.
- Added minimal file loading and SDL-backed diagnostics.
- Standardized runtime file asset lookup around logical asset IDs resolved through `noveltea::resolve_asset_path()`: desktop resolves under `apps/sandbox/assets`, while Web/Android package and load the same content under `assets`.
  - This intentionally keeps the portable part of old `NovelTea::AssetManager`: stable IDs such as `images/foo.png` or `fonts/bar.ttf` are resolved against a platform-specific asset root. The old templated `loadFromFile()` cache remains reference-only because it is SFML-shaped.
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
  - RmlUi bgfx shaders (`vs_rmlui.sc` / `fs_rmlui.sc`) compiled for glsl/essl/web profiles.

## Verified

Verification results from the current pass:

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
  - `source "$EMSDK/emsdk_env.sh" && emcmake cmake --preset web-debug -G Ninja -DNOVELTEA_COMPILE_SHADERS=OFF`: passed with generated shader headers visible to git.
  - `cmake --build --preset web-debug`: passed.
  - `yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "cmake;3.31.6"`: passed locally.
  - `cd android && ./gradlew --no-daemon :app:assembleDebug -PnovelteaCompileShaders=OFF`: passed with Gradle selecting Android SDK CMake 3.31.6.
- Web clean-checkout ImGui ini cleanup:
  - `source "$EMSDK/emsdk_env.sh" && emcmake cmake --preset web-debug -G Ninja -DNOVELTEA_COMPILE_SHADERS=OFF && cmake --build --preset web-debug`: passed; web no longer preloads or seeds `imgui.ini`, leaving ImGui to create `/persist/imgui.ini` when settings are saved.

## Stubbed Or Deferred

- RmlUi file texture loading (`LoadTexture` from image files). Generates correct textures from font glyph bitmaps (`GenerateTexture`), but disk image files (PNG/JPEG) return 0 until a decoder is added (bimg::imageParse or stb_image).
- RmlUi Debugger integration.
- Clip mask, layer stack, filter/shader compilation (advanced RmlUi rendering features).
- bimg/bgfx_utils PNG/JPEG/etc. image texture loading. Current disk texture support is intentionally limited to a tiny ASCII PPM proof so no large external helper tree or decoder was copied.
- SDF/MSDF font atlas and rich text rendering. The text lab remains an API/status scaffold.
- NovelTea old-engine code migration. Stage G was not started because the text/font gate is not complete.

## Known Risks

- The minimal PPM loader is only a framework proof. The next texture slice should use `bimg::imageParse` through the existing bgfx/bimg targets instead of expanding this ad hoc path.
- Web/Android now fetch RmlUi, and Android also fetches FreeType. Fresh builds need network access or a populated CMake FetchContent cache.
- Nested read-only reference clone `NovelTea` is dirty at `android/gradle/wrapper/gradle-wrapper.properties`; this was observed, not modified.
- RmlUi `LoadTexture` from file returns 0 — document `<img>` tags will not display until a decoder is added.

## Next Recommended Prompt

Add `bimg::imageParse`-based texture loading for `BgfxRenderInterface::LoadTexture` so that RmlUi can load PNG/JPEG images from files. Then begin the NovelTea text-lab migration: port BBCode parsing, style-run semantics, and per-glyph animation data from `NovelTea/` into backend-neutral `nt` text code.
