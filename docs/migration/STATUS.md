# Migration Status

Last updated: 2026-06-21.

## Completed Foundation

- Portable SDL3/bgfx runtime baseline for Linux, Web, and Android.
- RmlUi runtime UI integration and Dear ImGui developer/debug separation.
- Backend-neutral core migration for legacy project data, typed domain models, validation, save/settings/profile documents, runtime sessions/controllers, runtime view-state adapter, editor preview/tooling APIs, and reduced compatibility fixtures.
- Phase 1 runtime input/output contract around `RuntimeSessionHost`, including structured runtime diagnostics and shared headless/editor/RmlUi input routing.
- Phase 2 Lua runtime execution bridge. Runtime script requests can be executed through the engine-layer Lua executor while `noveltea_core` stays Lua-free.
- Save-backed Lua mutation APIs for global properties, entity property overrides, object locations, text logs, notifications, and timers.
- Phase 3 backend-neutral save policy: save-slot abstraction, in-memory slot store, manual save/load/autosave host APIs, save snapshots, save-backed object placement, and editor preview save loading.
- Legacy `game` JSON import and read-only legacy package import.
- Backend-neutral rich-text semantics and engine-owned Unicode text implementation.
- Lua runtime foundation. Lua is the only runtime scripting target.
- Phase 4 RmlUi runtime UI baseline: project/theme/system template override policy, centralized `RuntimeUiDocumentBinder`, `RuntimeUiTemplateResolver`, system fallback RML/RCSS files, hardened document reload lifecycle with input listener reattachment, and updated runtime UI docs.
- Phase 5 RmlUi custom component foundation: `nt-active-text`, `nt-map-view`, and `nt-text-log` register as C++-backed runtime UI elements with deterministic fallback binding from `RuntimeUIViewState`.
- Phase 6 tween integration: `twink` is resolved as an external package or pinned FetchContent fallback, `TweenService` owns engine-side tween instances, and RuntimeUI uses it for deterministic ActiveText reveal progress.
- Phase 7 ActiveText: runtime view state preserves `RichTextDocument` data, the engine builds deterministic per-glyph ActiveText frames with reveal/effect state, and `nt-active-text` renders fallback RML with object/style/effect/shader metadata, page-break prompts, and semantic shader stubs.
- Phase 8 MapView v1: runtime view state exposes typed map rooms/connections, derives current-room and direct-path click targets from `ProjectModel`/runtime state, editor preview can inspect map state, and `nt-map-view` renders deterministic RmlUi fallback DOM with current-room highlighting.
- Phase 9 TextLog v1: runtime view state exposes structured text-log entries with rich-text snapshots, speaker/source/category metadata, deterministic sequence ids, save-loaded string restoration, and structured `TextLogEntry` output payloads; `nt-text-log` renders deterministic RmlUi fallback markup.
- Phase 10 Object, Inventory, and Action Presentation: runtime view state tracks selected/available room and inventory objects, predicts action enabled/disabled state from current selection, exposes clearable selection through RmlUi/editor preview, and reports invalid selection/action diagnostics.
- Phase 11 Runtime Renderer and Asset Presentation v1: runtime view state exposes cover/background/room/object image slots, resolves visual metadata from room/object properties into logical project asset paths, validates missing visual assets in the RmlUi layer, and renders visuals through the existing RmlUi/bgfx texture path. Renderer layer system: 4-layer `GameLayer` enum (Background, Main, Foreground, UIOverlay) each dispatched to its own bgfx view. Scissor/clip stack: `push_scissor`/`pop_scissor` on Renderer with per-draw-call application. Frame timing: wall-clock delta drives ActiveText reveal progress in `RuntimeUI::begin_frame`. Material/shader resolution: deferred stubs in `render/material.hpp` (material registry) and `render/shader.hpp` (Shader class).
- Phase 12 Editor Preview and Recorded Test Playback: `RuntimePlaybackSession` runs backend-neutral recorded specs from JSON or project `tests`, drives `RuntimeSessionHost` through shared `RuntimeInput`, supports fixed-delta deterministic steps, captures outputs/diagnostics, evaluates assertions, exports JSON reports, and exposes a Lua-free hook callback for engine-layer setup/check execution.
- Phase 13 Package Writing and Export: `ProjectPackageWriter` exports ZIP-based `.ntpkg` runtime packages with legacy-compatible entries, additive `manifest.json` metadata, per-entry checksums, safe asset-path filtering, compiled shader variant inclusion, editor-facing export hooks, and manifest-aware sandbox smoke package staging.
- Phase 14 Editor Integration V1: Electron now talks to a CMake-built `noveltea-editor-tool` helper for project load/import, validation, raw entity edits, playback test listing/running, and package export. The TanStack workspace uses project-derived entity/test trees, raw JSON inspection, validation diagnostics, playback/export timeline entries, and runtime-named preview controls over the existing iframe MessageChannel.
- Phase 15 RmlUi bgfx optimization Phase 2: child layers now use bounded framebuffer allocation driven by active scissor or explicit fallback to full-frame bounds, with per-layer orthographic projection and selection-policy tests covering bounded, parent-clamped, and fallback cases.
- Phase 16 RmlUi bgfx optimization Phase 3: rectangle-aware compositing now carries explicit source and destination rectangles through bounded layer composites, scratch copies, saved mask copies, and the final base-layer composite.
- Phase 17 RmlUi bgfx optimization Phase 4/5: postprocess scratch/filter targets allocate to explicit requested bounds instead of defaulting to full-frame size, bounded layer filters reuse exact-dimension ping-pong targets, and perf counters/logging report actual postprocess target sizes plus bounded-vs-full-frame layer allocation. The saved `mask-image` readback assertion passes with bounded child-layer selection restored, and the remaining bounded filter pipeline acceptance checks have now been rerun together.
- Phase 18 RmlUi bgfx optimization Phase 7: clip-mask and stencil work now derives from bounded layer/scissor intersections, stencil clears and normalization no longer default to full-layer work areas, conservative clip replay skips empty bounded work, and focused bounds/planning tests cover the new clip behavior.
- Phase 19 RmlUi bgfx optimization Phase 8: no-op filter elimination now skips neutral filter passes, `blur(<0.5)` short-circuits before postprocess allocation, and consecutive color-matrix filters are reduced before hitting the bounded filter pipeline.
- Phase 20 RmlUi bgfx optimization Phase 9: base presentation now has a conservative direct-to-backbuffer policy for safe non-WebGL frames, retains the offscreen root fallback, records direct/offscreen/fallback perf counters, and rejects root-preserving operations when direct presentation is active.
- RmlUi bgfx optimization Phase 0 restart: headless Chromium/Playwright smoke now rejects the current full-frame renderer shape instead of accepting it as a baseline. Perf logging distinguishes root vs child layers, fallback reasons, per-pass full-frame work, and postprocess target uses even when render targets are reused with `rt_alloc=0`.
- RmlUi bgfx optimization Phase 1 restart: compiled geometry now stores CPU-side local AABBs and shared transform/DPR helpers derive conservative framebuffer bounds for geometry and shader draws.
- RmlUi bgfx optimization Phase 2 restart: child layers are now virtual at `PushLayer()`, draw/gradient/clip-mask commands record the render state needed for replay, and layer textures are materialized only when `CompositeLayers()`, `SaveLayerAsTexture()`, or `SaveLayerAsMaskImage()` needs them. Nested virtual layers keep provisional non-GPU bounds so saved mask-image correctness survives until content-bound accumulation replaces those provisional bounds. Reused layer slots now destroy previous-frame materialized resources before becoming virtual again, preventing interactive readback-gallery runs from exhausting bgfx framebuffers after the first few frames.
- Compatibility flag `--rmlui-base-direct-compat` forces the older offscreen-root compatible path. The no-compat desktop direct-base path remains unsafe for the readback gallery until root-preserving filters/masks are planned before base presentation selection.
- Current runtime ownership and data flow are documented in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

## Active Gaps

- Invalid imported legacy script text should fail as Lua; no JavaScript, Duktape, dukglue, or JS compatibility layer will be added.
- Platform-specific save-slot persistence, runtime save/load screens, and richer autosave UI feedback remain incomplete.
- Phase 8 Lua-evaluated map visibility is explicitly deferred. `noveltea_core` must remain Lua-free, so this needs an engine-layer evaluation/result contract before implementation.
- Shader-backed ActiveText rendering, bgfx/custom-geometry map rendering, and optional map transition animation remain active. Shader/material resolution policy (stubbed) is deferred to a future phase.
- RmlUi saved `mask-image` passes Linux readback, but the renderer is not yet performant: the readback gallery still has `full_frame_child_layers=12`, `unbounded_no_scissor_fallbacks=12`, `full_frame_postprocess_target_uses=24`, and `max_child_layer=1280x720` in the web smoke.
- RmlUi child layers now record virtually, but materialization still uses provisional scissor/parent bounds rather than accumulated content bounds. Most advanced layers can still materialize full-frame until Phase 3 unions recorded geometry/shader bounds and Phase 4 allocates from those accumulated bounds.
- Editor preview/test playback is wired into the Electron workspace through the helper CLI; richer typed editors, branch/story traversal tooling, and real workflow fixtures remain incomplete.
- Editable/source package workflows and real old-project fixture coverage remain incomplete.
- Web browser and Android emulator runtime smoke coverage should be expanded where practical.
- RmlUi renderer documentation is current, but transform-bound derivation and the remaining full-frame fallback cases are still conservative implementation limits rather than doc gaps.

## Current Verification Commands

Latest RmlUi bgfx implementation — use these commands to verify:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset linux-debug --target format-check
```

Known current verification note:

- `ctest --test-dir build/linux-debug -R 'noveltea_rmlui_readback_(capture|verify)' --output-on-failure` passes after virtual child-layer recording and on-demand materialization, including the saved `mask-image` panel. The capture now runs 40 frames so previous-frame virtual-layer resource leaks are visible. The strict web-smoke structural gate is still expected to fail until recorded content bounds drive materialization sizes.
- `cmake --build --preset linux-debug --target noveltea_ui_tests` and `./build/linux-debug/tests/noveltea_ui_tests "*RmlUi*"` pass after the Phase 8 filter simplification update.
- `cmake --build --preset web-debug --target engine` passes after the Phase 7 clip/stencil bounds update.
- Latest web-smoke perf baseline from the readback gallery intentionally fails the strict structural gate. Manual browser runs can report different raw pixel totals because the canvas/framebuffer size follows the browser viewport and DPR; the important Phase 2 regression signal is that steady-state virtual-layer materialization now balances `layer_alloc=13` with `layer_destroy=13`:

  ```text
  [perf] fps=1 passes=121 geom=27 clip=15 gradients=8 layers=13 full_layers=13 bounded_layers=1 full_frame_child_layers=12 bounded_child_layers=1 unbounded_layer_fallbacks=12 unbounded_no_scissor_fallbacks=12 unbounded_transform_fallbacks=1 unbounded_inverse_clip_fallbacks=0 filters=14 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=24901632 copy_px=9216 composite_px=23961600 post_px=13824000 full_frame_passes=66 bounded_passes=4 full_frame_clear_passes=27 bounded_clear_passes=2 full_frame_composite_passes=24 bounded_composite_passes=2 full_frame_postprocess_passes=15 bounded_postprocess_passes=0 full_frame_postprocess_target_uses=24 bounded_postprocess_target_uses=0 full_frame_postprocess_targets=0 bounded_postprocess_targets=0 rt_alloc=0 rt_destroy=0 layer_alloc=13 layer_destroy=13 max_layer=1280x720 max_child_layer=1280x720 max_child_rt=1280x720 max_rt=1280x720 fb=1280x720
  ```

Use the smallest relevant subset for a docs-only or narrow code change:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
```

Run the sandbox when runtime loop, UI, input, or rendering behavior changes:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Run Android when platform, CMake, shader, asset packaging, JNI, or Gradle behavior changes:

```sh
cd android
./gradlew :app:assembleDebug
```

For documentation-only cleanup, a targeted `rg` check for stale active-doc instructions is sufficient.

Latest Phase 13 targeted verification completed:

```sh
cmake --build --preset linux-debug --target noveltea_core_tests
./build/linux-debug/tests/noveltea_core_tests "*Package*"
./build/linux-debug/tests/noveltea_core_tests
```

Latest Phase 14 targeted verification completed:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug --target noveltea_core_tests noveltea-editor-tool
./build/linux-debug/tests/noveltea_core_tests "*Editor*"
ctest --test-dir build/linux-debug -R "editor_tool" --output-on-failure
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
cd editor
pnpm typecheck
pnpm test
pnpm lint
pnpm engine:preview:build
cd ../android
./gradlew :app:assembleDebug
```

Latest Phase 13 full verification completed:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset linux-debug --target format-check
cd android
./gradlew :app:assembleDebug
```

## Next Implementation Task

Implement Phase 3 from [`docs/rendering/RMLUI_BGFX_OPTIMIZATION_PLAN.md`](../rendering/RMLUI_BGFX_OPTIMIZATION_PLAN.md): accumulate conservative content bounds from recorded virtual-layer geometry, shader, scissor, transform, and clip-mask commands. Do not move to pass folding or direct-base presentation until the strict web smoke counters prove that child layers and postprocess targets are no longer full-frame for the readback gallery.
