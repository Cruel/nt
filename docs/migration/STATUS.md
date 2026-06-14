# Migration Status

## Implemented

- Added feature flags: `NOVELTEA_ENABLE_RENDER2D`, `NOVELTEA_ENABLE_RMLUI`, `NOVELTEA_ENABLE_TEXT_LAB`; existing bgfx/devtools flags remain.
- Added backend-neutral helper headers for geometry, render commands/resources, assets, and text-run shape.
- Added minimal file loading and SDL-backed diagnostics.
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

## Verified

Verification results from the current pass:

- `cmake --preset linux-debug`: passed.
- `cmake --build --preset linux-debug`: passed.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --frames 180`: passed; exited through normal engine shutdown with no `pure virtual method called`.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`: passed; same clean shutdown path.
- `cmake --preset web-debug`: passed; RmlUi scaffold-only on Web.
- `cmake --build --preset web-debug`: passed; Emscripten emitted SDL3 experimental warnings.
- `cd android && ./gradlew :app:assembleDebug`: passed; Android Gradle plugin warned that compileSdk 35 is newer than the plugin's tested SDK.

## Stubbed Or Deferred

- Full RmlUi bgfx backend, SDL3 event translation, document loading, stylesheet loading, font loading, texture callbacks, and debugger integration. RmlUi links on Linux but remains a scaffold.
- bimg/bgfx_utils PNG/JPEG/etc. image texture loading. Current disk texture support is intentionally limited to a tiny ASCII PPM proof so no large external helper tree or decoder was copied.
- SDF/MSDF font atlas and rich text rendering. The text lab remains an API/status scaffold.
- NovelTea old-engine code migration. Stage G was not started because the RmlUi and text/font gates are not complete.

## Known Risks

- The minimal PPM loader is only a framework proof. The next texture slice should use `bimg::imageParse` through the existing bgfx/bimg targets instead of expanding this ad hoc path.
- RmlUi package availability varies by platform; Web/Android remain scaffold-only in this slice.
- Existing Web/Android bgfx/imgui fetch paths may need local cache or network outside this task's local reference restriction.
- Nested read-only reference clone `NovelTea` is dirty at `android/gradle/wrapper/gradle-wrapper.properties`; this was observed, not modified.

## Next Recommended Prompt

Implement the real RmlUi/bgfx runtime UI backend for `noveltea::RuntimeUI` using the local `refs/RmlUi` and `refs/rmlui-bgfx` references, then add a minimal `.rml`/`.rcss` demo document and SDL3 input translation. Do not start old NovelTea migration until the RmlUi and text/font gates are either complete or explicitly re-scoped.
