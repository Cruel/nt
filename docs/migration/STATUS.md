# Migration Status

Last updated: 2026-06-22.

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
- RmlUi bgfx optimization Phase 4 restart: virtual child layers now materialize from accumulated content bounds plus required filter/composite bounds, replay into bounded targets with local scissor/stencil/copy/composite coordinates, and preserve readback correctness. The Linux readback gallery now reports `full_frame_child_layers=0`, `full_frame_passes=2`, `max_child_layer=114x96`, and `max_rt=114x96` at 1280x720.
- RmlUi bgfx optimization Phase 4.5: reusable `rmlui_bgfx` core boundary, NovelTea adapter services, extracted target cache, pass builder, draw context, filter pipeline, layer system, adapter cleanup, and resize/readback regression coverage are implemented.
- RmlUi bgfx optimization Phase 5 restart: transform-driven full-frame fallback is verified closed for normal transformed gallery content. Focused bounds tests lock shader-order translation-before-transform, negative scale, rotation with non-integer DPR, and zero homogeneous output; the readback gallery keeps `unbounded_transform_fallbacks=0`, `full_frame_child_layers=0`, and `max_child_layer=114x96`.
- RmlUi bgfx optimization Phase 6 restart: filtered output now carries conservative composited bounds separately from tighter semantic valid-output bounds. This is intentionally behavior-preserving; per-valid-rect filter compositing is deferred until visual regression coverage is stronger.
- RmlUi bgfx optimization Phase 7 complete: perf logging now classifies pass reasons and reports pass-builder operations vs reused bgfx views. Opacity/color-matrix-only filter chains fold into a composite-filter shader instead of allocating bounded postprocess targets and running copy/ping-pong passes. Same-target non-clear draws and geometry-like draws after clears reuse bgfx views more broadly, and mask-image-only filters bypass one preliminary source copy. Readback-gallery steady state now reports `passes=89`, `views=43`, `color_filter_folds=9`, `pass_filter_copy=2`, `bounded_postprocess_passes=6`, `post_px=21776`, and the established bounded-layer invariants.
- Compatibility flag `--rmlui-base-direct-compat` forces the older offscreen-root compatible path. The no-compat desktop direct-base path remains unsafe for the readback gallery until root-preserving filters/masks are planned before base presentation selection.
- Current runtime ownership and data flow are documented in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

## Active Gaps

- Invalid imported legacy script text should fail as Lua; no JavaScript, Duktape, dukglue, or JS compatibility layer will be added.
- Platform-specific save-slot persistence, runtime save/load screens, and richer autosave UI feedback remain incomplete.
- Phase 8 Lua-evaluated map visibility is explicitly deferred. `noveltea_core` must remain Lua-free, so this needs an engine-layer evaluation/result contract before implementation.
- Shader-backed ActiveText rendering, bgfx/custom-geometry map rendering, and optional map transition animation remain active. Shader/material resolution policy (stubbed) is deferred to a future phase.
- RmlUi child layers are now bounded in the Linux and Web readback gallery smoke paths. Android runtime smoke coverage should still be rerun against the new Phase 4 materialization path.
- RmlUi Phase 7 pass-count and render-target-switch reduction is complete for the current acceptance gates. The next speed target is Phase 8 saved texture/mask-image bounds where profiling or correctness fixtures show remaining waste; redundant layer-clear removal is deferred because child-layer clears are required for transparent blended replay.
- Editor preview/test playback is wired into the Electron workspace through the helper CLI; richer typed editors, branch/story traversal tooling, and real workflow fixtures remain incomplete.
- Editable/source package workflows and real old-project fixture coverage remain incomplete.
- Web browser and Android emulator runtime smoke coverage should be expanded where practical.
- RmlUi renderer documentation now treats the bgfx backend as a reusable renderer core consumed by NovelTea adapters; physical extraction to a separate repository is intentionally deferred.

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

- `ctest --test-dir build/linux-debug -R noveltea_rmlui` passes standard readback and resize-readback capture/verify, including the saved `mask-image` panel. The readback gallery now reports zero full-frame child layers on Linux.
- `cmake --build --preset web-debug` and `node scripts/web-smoke.mjs` pass after completed Phase 7 work; web smoke reports zero full-frame child layers, `max_child_layer=114x96`, `passes=89`, and `views=43`.
- `cmake --build --preset linux-debug`, `cmake --build --preset linux-debug --target format-check`, and the full Linux `ctest --test-dir build/linux-debug --output-on-failure` pass after completed Phase 7 work.
- Latest Linux and Web readback-gallery perf after completed Phase 7 work has the strict bounded structural shape and lower pass/postprocess counts:

  ```text
  [perf] fps=125 passes=89 views=43 view_reuses=46 geom=27 clip=15 gradients=8 pass_geom=27 pass_gradient=8 pass_clip=15 pass_stencil_norm=0 pass_base_clear=1 pass_layer_clear=13 pass_stencil_clear=2 pass_filter_copy=2 pass_filter_opacity=0 pass_filter_color=0 pass_filter_mask=1 pass_filter_blur=4 pass_filter_shadow=1 pass_filter_shadow_comp=1 color_filter_folds=9 pass_layer_scratch=0 pass_layer_comp=12 pass_final_comp=1 pass_save_texture=0 pass_save_mask=1 pass_other_copy=0 pass_other=0 layers=13 full_layers=1 bounded_layers=13 full_frame_child_layers=0 bounded_child_layers=13 unbounded_layer_fallbacks=0 unbounded_no_scissor_fallbacks=0 unbounded_transform_fallbacks=0 unbounded_inverse_clip_fallbacks=0 filters=5 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=980004 copy_px=9216 composite_px=959952 post_px=21776 full_frame_passes=2 bounded_passes=36 full_frame_clear_passes=1 bounded_clear_passes=15 full_frame_composite_passes=1 bounded_composite_passes=15 full_frame_postprocess_passes=0 bounded_postprocess_passes=6 full_frame_postprocess_target_uses=0 bounded_postprocess_target_uses=6 full_frame_postprocess_targets=0 bounded_postprocess_targets=0 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1280x720 max_child_layer=114x96 max_child_rt=114x96 max_rt=96x96 fb=1280x720
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

Resume the RmlUi bgfx optimization plan in Phase 8. The first Phase 8 slice makes saved mask images copy valid content bounds when those are tighter than the materialized layer. Continue by auditing saved texture/mask-image ownership, release lifetime, and feedback-loop protection while preserving all RmlUi feature semantics. Do not start direct-base tuning or physical repository extraction until saved texture/mask-image behavior is documented and verified.
