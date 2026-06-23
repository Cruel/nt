# RmlUi bgfx Status

Status values: NOT STARTED, IMPLEMENTED, NOT VERIFIED, VERIFIED, FAILED BASELINE.

Current status: Phases 0 through 6a of [`RMLUI_BGFX_OPTIMIZATION_PLAN.md`](RMLUI_BGFX_OPTIMIZATION_PLAN.md) are implemented and verified on the Linux debug test suite. Phase 4.5 Stage 0 through Stage 7 are also implemented and verified, completing the Phase 4.5 in-repo reusable-boundary and subsystem split. Phase 7 is complete for the current acceptance gates with pass-reason diagnostics, a behavior-preserving color-only filter composite fast path, broader same-target non-clear and post-clear geometry-like view reuse, and a mask-image-only direct source path. The renderer now has a staged reusable `rmlui_bgfx` core target with generic surface, view-range, shader, texture, diagnostics, and perf-log provider interfaces, while NovelTea-specific AssetManager, shader-loader, view-id, surface, and logging behavior lives behind an adapter. Shared renderer-private records live in reusable-core type headers, texture source-region plumbing uses an explicit `TextureRegion`, `BgfxTargetCache` owns child-layer and postprocess render-target resources plus their pool metadata, `BgfxPassBuilder` owns pass scheduling plus bgfx view setup, `BgfxDrawContext` owns bgfx draw-state binding/submission, `BgfxFilterPipeline` owns filter-chain resolution, expansion, bounded postprocess target acquisition, filter execution, and color-only filter folding metadata, and `BgfxLayerSystem` owns active-layer/stack state, virtual child layer slot initialization, materialization orchestration, composite-layer orchestration, and save-layer orchestration. The RmlUi-facing adapter has been cleaned up by removing the obsolete in-file filter pipeline fallback and stale helper paths after subsystem extraction. The Linux test suite now includes a resize/readback regression path that drives the gallery through `1280x720,1423x1869,1280x720` before verification. The filter pipeline now reports both conservative composited output bounds and tighter semantic valid-output bounds, preserving the established readback-gallery image while making allocation bounds and content bounds explicit for later work.

## Current Performance Truth

The readback gallery remains functionally correct on Linux. After Phase 4, child layers are no longer materialized full-frame in the representative Linux readback gallery run. Phase 7 folds color-only opacity/color-matrix filter chains into the final layer composite shader, avoids one mask-image-only source-copy pass, and reduces bgfx view churn by reusing compatible same-target views while preserving conservative fallback paths for blur and drop-shadow filters.

Representative steady-state Linux perf after completed Phase 7 work at 1280x720:

```text
[perf] fps=125 passes=89 views=43 view_reuses=46 geom=27 clip=15 gradients=8 pass_geom=27 pass_gradient=8 pass_clip=15 pass_stencil_norm=0 pass_base_clear=1 pass_layer_clear=13 pass_stencil_clear=2 pass_filter_copy=2 pass_filter_opacity=0 pass_filter_color=0 pass_filter_mask=1 pass_filter_blur=4 pass_filter_shadow=1 pass_filter_shadow_comp=1 color_filter_folds=9 pass_layer_scratch=0 pass_layer_comp=12 pass_final_comp=1 pass_save_texture=0 pass_save_mask=1 pass_other_copy=0 pass_other=0 layers=13 full_layers=1 bounded_layers=13 full_frame_child_layers=0 bounded_child_layers=13 unbounded_layer_fallbacks=0 unbounded_no_scissor_fallbacks=0 unbounded_transform_fallbacks=0 unbounded_inverse_clip_fallbacks=0 filters=5 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=980004 copy_px=9216 composite_px=959952 post_px=21776 full_frame_passes=2 bounded_passes=36 full_frame_clear_passes=1 bounded_clear_passes=15 full_frame_composite_passes=1 bounded_composite_passes=15 full_frame_postprocess_passes=0 bounded_postprocess_passes=6 full_frame_postprocess_target_uses=0 bounded_postprocess_target_uses=6 full_frame_postprocess_targets=0 bounded_postprocess_targets=0 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1280x720 max_child_layer=114x96 max_child_rt=114x96 max_rt=96x96 fb=1280x720
```

This is the measured bounded-compositor success state for the readback gallery. The important changes are:

- `full_frame_child_layers=0`: child layers are now materialized from recorded content/required bounds instead of the provisional full-frame fallback.
- `unbounded_layer_fallbacks=0` and `unbounded_transform_fallbacks=0`: there are still no unbounded child-layer fallback reasons in this gallery run, including the rotated `#transform_clip` fixture.
- `max_child_layer=114x96`, `max_child_rt=114x96`, and `max_rt=96x96`: the largest child layer and postprocess target are near gallery effect sizes, not the 1280x720 framebuffer.
- `full_frame_passes=2`: the remaining full-frame work is the expected offscreen base clear and final base composite.
- `passes=89`, `views=43`, and `view_reuses=46`: the perf log distinguishes pass-builder operations from reused bgfx views, and the scheduler now reuses adjacent same-target/same-rect non-clear views plus geometry-like draws after clear views.
- `color_filter_folds=9`: nine opacity/color-matrix-only filter chains bypassed postprocess and applied through the composite-filter shader.
- `pass_filter_copy=2`, `bounded_postprocess_passes=6`, `bounded_postprocess_target_uses=6`, and `post_px=21776`: color-only postprocess work was removed, and the mask-image-only path avoids one preliminary filter copy while blur/drop-shadow still use the conservative bounded filter pipeline.

Residual work deferred out of Phase 7:

- `layer_alloc=0 layer_destroy=0`: child layer render targets are reused at steady state, avoiding native GL flicker from per-frame child framebuffer churn.
- `rt_alloc=0 rt_destroy=0`: postprocess targets are also reused at steady state, eliminating the native GL instability caused by per-frame filter target churn.
- Filters expose conservative composited output bounds separately from tighter semantic valid-output bounds. Per-valid-rect postprocess draws remain deferred until visual regression coverage is stronger.
- `pass_layer_clear=13` remains because bounded child layers are replayed with alpha blending, transparent regions, and stencil/clip state; skipping those clears is not generally safe. Phase 7 instead merges safe geometry-like draws into clear views, reducing bgfx view churn without removing required initialization.
- The remaining `pass_filter_copy=2` entries belong to blur/drop-shadow expanded work textures. Removing them safely would require a UV-aware filter shader/input refactor and is deferred.

## RenderInterface 6.2 Method Coverage

| Method | Status | Evidence |
| --- | --- | --- |
| CompileGeometry | VERIFIED | Stores CPU-side indexed local AABB before bgfx upload; invalid/empty/non-finite geometry is rejected by `compute_indexed_geometry_bounds`; Linux readback and unit tests pass. |
| RenderGeometry | VERIFIED | Direct rendering and virtual-layer recording both use compiled geometry bounds; Linux readback verifies textured/color geometry orientation and clip/filter/gradient output. |
| ReleaseGeometry | IMPLEMENTED, NOT VERIFIED | Destroys bgfx buffers; no lifecycle counter test yet. |
| LoadTexture | VERIFIED | Uses AssetManager plus bimg decode; file interface and shader/runtime asset tests pass. |
| GenerateTexture | VERIFIED | RmlUi font texture path is exercised by sandbox/readback capture. |
| ReleaseTexture | IMPLEMENTED, NOT VERIFIED | Releases external and saved-layer textures; no double-release lifecycle test yet. |
| EnableScissorRegion | VERIFIED | Save/copy and readback gallery exercise scissored output. |
| SetScissorRegion | VERIFIED | Clamp behavior is covered by readback/copy paths and bounds tests. |
| EnableClipMask | VERIFIED | Readback covers inherited clip-mask output; conservative mask bounds are inherited by virtual child layers. |
| RenderToClipMask | VERIFIED | Set/SetInverse/Intersect paths are recorded for virtual layers and have conservative bounds helper tests; readback covers visual clip behavior. |
| SetTransform | VERIFIED | `compute_transformed_geometry_bounds()` is used for recorded command bounds; tests cover shader-order translation-before-transform, scale, negative scale, rotation, rotation with non-integer DPR, offscreen clipping, and invalid/non-finite/zero-W input. |
| PushLayer | VERIFIED | Child layers are virtual/recorded and materialize to bounded content/required rectangles instead of immediate full-frame targets. |
| CompositeLayers | VERIFIED | Source layers materialize from recorded content plus filter expansion, destination layers can materialize from composite output bounds, and bounded local source/destination rectangles preserve readback correctness. |
| PopLayer | IMPLEMENTED, NOT VERIFIED | Restores active layer; exact parent-state restoration lacks a targeted test. |
| SaveLayerAsTexture | VERIFIED | Saved-layer copies use bounded layer/scissor intersections and preserve saved bounds metadata. |
| SaveLayerAsMaskImage | VERIFIED | Saved-mask copies preserve saved bounds metadata and own the copied mask texture when borrowed attachment lifetime is unsafe. |
| CompileFilter | VERIFIED | Standard filter compile paths are covered by unit and readback tests for representative filters. |
| ReleaseFilter | VERIFIED | Mask-image filters release owned saved textures and clear the saved texture record metadata. |
| CompileShader | VERIFIED | Linear/radial/conic and repeating gradient records compile and shader assets stage. |
| RenderShader | VERIFIED | Virtual-layer shader commands accumulate conservative geometry bounds from the same compiled geometry records as `RenderGeometry`; Linux readback covers gradient output. |
| ReleaseShader | IMPLEMENTED, NOT VERIFIED | Erases shader records; no lifecycle test yet. |

## Phase Progress

| Phase | Status | Evidence |
| --- | --- | --- |
| Phase 0: Make the Bad Baseline Unmistakable | VERIFIED | Perf logging and web smoke parse/use structural counters; full-frame steady-state work is visible even when allocations are stable. |
| Phase 1: Geometry and Shader Bounds | VERIFIED | `GeometryRecord` stores indexed local bounds; `compute_indexed_geometry_bounds()` and `compute_transformed_geometry_bounds()` cover identity, translation, scale, rotation, offscreen clipping, non-integer DPR, and invalid/non-finite input. |
| Phase 2: Virtual Child Layer Recording | VERIFIED | Child layers now record geometry, shader, and clip-mask commands until materialized; Linux readback capture/verify passes over a 40-frame capture. |
| Phase 3: Layer Content Bounds Accumulation | VERIFIED | Virtual layers accumulate `valid_content_bounds` from recorded geometry/shader commands using local AABB, translation, captured transform, scissor, parent/provisional containment, and conservative clip-mask bounds. Helper tests cover mask `Set`, `Intersect`, `SetInverse`, and scissor/mask bound composition. Web perf shows all unbounded child-layer fallback counters at zero. |
| Phase 4: Bounded Layer Materialization and Replay | VERIFIED | Materialization now chooses child framebuffer bounds from recorded content, required filter/composite bounds, parent/provisional limits, and scissor constraints; Linux readback capture/verify passes and perf shows `full_frame_child_layers=0`, `max_child_layer=114x96`, and `full_frame_passes=2`. |
| Phase 5: Transform Bounds Without Full-Frame Fallback | VERIFIED | The transform bounds path is already integrated with recorded command bounds and materialization. Focused tests now lock shader-order translation-before-transform, negative scale, rotation with non-integer DPR, and zero homogeneous output. The Linux readback gallery keeps `unbounded_transform_fallbacks=0`, `full_frame_child_layers=0`, and `max_child_layer=114x96`. |
| Phase 6a: Filter Bounds Data Model | VERIFIED | `FilterApplyResult` now carries conservative `output_bounds` separately from tighter `valid_output_bounds`. `BgfxFilterPipeline::apply()` preserves conservative work-target output for visual compatibility while advancing valid semantic bounds through opacity/color/mask-image and expanding them through blur/drop-shadow. This is a prerequisite for optimization, not the final speed win. |
| Phase 7: Pass Count and Render-Target Switch Reduction | VERIFIED | Phase 7 adds pass-reason diagnostics, prints pass-builder operations vs reused bgfx views, folds opacity/color-matrix-only chains into a composite-filter shader, reuses adjacent same-target/same-rect non-clear views, merges geometry-like draws into preceding clear views, and bypasses the preliminary filter copy for mask-image-only filters. Linux build, full test suite, readback, resize-readback, web build/smoke, and format-check pass. Readback-gallery steady state drops from `passes=108` to `89`, `views=60` to `43`, `bounded_postprocess_passes=15` to `6`, and reports `color_filter_folds=9`. Remaining layer clears are required initialization for blended replay, and remaining filter copies are deferred to a larger UV-aware filter-shader refactor. |
| Phase 4.5 Stage 0: Reusable Core Boundary | VERIFIED | Added the staged `rmlui_bgfx_renderer` target, generic config/provider interfaces, and NovelTea adapter. Reusable-core files build without NovelTea AssetManager, SurfaceMetrics, shader loader, view IDs, SDL3, Lua, ImGui, runtime, custom component, or editor-preview dependencies. Linux readback and web smoke pass with the Phase 4 structural perf shape preserved. |
| Phase 4.5 Stage 0.5: Shared Types and Coordinate Discipline | VERIFIED | Added `rmlui_bgfx_types.hpp`, moved shared renderer-private records out of the monolithic render-interface source, added global/local framebuffer rect aliases and coordinate helper names, and introduced `TextureRegion` for composite/filter source regions. Linux build, readback, runtime perf smoke, web smoke, and format-check pass with the Phase 4 structural perf shape preserved. |
| Phase 4.5 Stage 1: Extract Target Caches | VERIFIED | Added `BgfxTargetCache` in reusable-core files. It owns child-layer framebuffer/color/depth-stencil resources, postprocess framebuffer/color resources, and layer/postprocess pool metadata. The render interface now delegates target creation, reuse, resize teardown, and destroy accounting to the cache. Linux build, readback, runtime perf smoke, web smoke, and format-check pass with steady-state `rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0`. |
| Phase 4.5 Stage 2: Extract Pass Builder | VERIFIED | Added `BgfxPassBuilder` in reusable-core files. It owns scheduler interaction, bgfx view names, view mode, view rects, framebuffer binding, and clear setup. Raw `bgfx::setViewName`, `setViewMode`, `setViewRect`, `setViewFrameBuffer`, and `setViewClear` calls are centralized in the pass builder. Linux build, readback, runtime perf smoke, web build/smoke, and format-check pass with the Phase 4 structural perf shape preserved. |
| Phase 4.5 Stage 3: Extract Draw Context | VERIFIED | Added `BgfxDrawContext` in reusable-core files. It owns bgfx buffer/texture/uniform/state/stencil/scissor binding, ordinary geometry submission, gradient submission, composite submission, copy/blit submission, fullscreen postprocess submission, mask-image submission, stencil decrement, and clip-mask submission. `rmlui_render_interface_bgfx.cpp` retains policy decisions but no longer directly calls bgfx draw-state or submit/blit APIs. Linux build, readback, runtime perf smoke, web build/smoke, and format-check pass with the Phase 4 structural perf shape preserved. |
| Phase 4.5 Stage 4: Extract Filter Pipeline | VERIFIED | Added `BgfxFilterPipeline` in reusable-core files. It resolves compiled filter handles, computes filter expansion, acquires bounded postprocess targets through `BgfxTargetCache`, applies opacity/color-matrix/mask-image/blur/drop-shadow passes through `BgfxPassBuilder` and `BgfxDrawContext`, and preserves WebGL feedback-loop checks. `CompositeLayers()` now delegates filter application to the pipeline. Linux build, readback, runtime perf smoke, web build/smoke, and format-check pass with the Phase 4 steady-state structural perf shape preserved. |
| Phase 4.5 Stage 5: Extract Layer System | VERIFIED | Added `BgfxLayerSystem` in reusable-core files. It owns active layer handle, layer stack, current/materialized layer lookup, active recording detection, virtual child layer slot initialization with resource preservation and inherited clip-mask state, materialization orchestration, composite-layer orchestration, and save-layer orchestration. `PushLayer()`, `PopLayer()`, `CompositeLayers()`, `SaveLayerAsTexture()`, `SaveLayerAsMaskImage()`, and materialization routing now delegate their layer-system policy to `BgfxLayerSystem` through reusable callback contexts. Linux build, readback, runtime perf smoke, web build/smoke, and format-check pass with the Phase 4 steady-state structural perf shape preserved. |
| Phase 4.5 Stage 6: Thin RmlUi Adapter Cleanup | VERIFIED | Removed the obsolete disabled in-file filter pipeline fallback from `rmlui_render_interface_bgfx.cpp` after `BgfxFilterPipeline` and `BgfxLayerSystem` took ownership of those responsibilities. Also removed stale helper paths that only existed for the old monolithic postprocess implementation. The adapter file is smaller and its live layer/filter paths now delegate through the extracted subsystems. Linux build, readback, runtime perf smoke, web build/smoke, and format-check pass with the Phase 4 steady-state structural perf shape preserved. |
| Phase 4.5 Stage 7: Resize and Flicker Regression Coverage | VERIFIED | Added sandbox options `--resize-sequence WIDTHxHEIGHT[,WIDTHxHEIGHT...]` and `--readback-after-resize-frames N`, wired them through `EngineRunConfig`, and added `noveltea_rmlui_resize_readback_capture/verify` tests. The new readback path runs the gallery through `1280x720,1423x1869,1280x720`, waits three steady frames, captures, and verifies the same visual assertions. Linux build, resize readback, standard readback, runtime perf smoke, web build/smoke, format-check, and dependency-boundary checks pass. |

## Acceptance Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Linux build | VERIFIED | `cmake --build build/linux-debug` passes. |
| Linux test suite | VERIFIED | RmlUi readback capture/verify and resize-readback capture/verify pass under `ctest --test-dir build/linux-debug -R noveltea_rmlui`. |
| Web sandbox rebuild | VERIFIED | `cmake --build --preset web-debug` passes after Phase 7. |
| Web structural smoke | VERIFIED | `node scripts/web-smoke.mjs` passes with zero full-frame child layers, zero unbounded fallbacks, zero full-frame postprocess passes, `max_child_layer=114x96`, `passes=89`, and `views=43`. |
| Full GL3-quality blur | NOT VERIFIED | Current GPU blur still stores four weights and seven taps; downsample/upsample large-sigma path is not implemented. |
| Android emulator runtime smoke | NOT VERIFIED | No emulator smoke is implemented or run. |

## Renderer Model

The renderer is now a measured content-bounded compositor for child layers in the readback gallery:

1. CPU-side geometry and shader bounds exist.
2. Child layers can record commands instead of allocating immediately.
3. Recorded commands accumulate conservative content and clip-mask bounds.
4. Materialization consumes those bounds plus required filter/composite bounds to allocate bounded child targets.
5. Replay renders into bounded targets with local scissor, stencil, copy, and composite coordinates.

The remaining optimization work is no longer discovery, child-layer materialization, normal transform bounding, the filter allocation/content-bounds data-model split, or Phase 7 pass/view reduction. Further layer-clear removal is deferred because child-layer clear passes are required for transparent blended replay, and remaining blur/drop-shadow copies need a larger UV-aware filter-shader refactor. The next planned optimization phase is saved texture/mask-image bound work where profiling or correctness fixtures show remaining waste.

A small direct-base robustness fix is also present: root-preservation discovery is sticky across frames. If direct base presentation discovers that root filters require offscreen preservation, subsequent frames can choose offscreen presentation instead of repeatedly failing with `CompositeLayers root filters require offscreen presentation`. This is a recovery fix, not the final direct-base policy from the later optimization phases.

## Perf Log Guide

The renderer emits a periodic `[perf]` line when render perf logging is enabled. Important fields:

- `layers`, `full_layers`, `bounded_layers`: all layer pushes including the base/root layer.
- `full_frame_child_layers`, `bounded_child_layers`: child layers only; these are the key layer-optimization counters.
- `unbounded_layer_fallbacks`: total child-layer fallback count.
- `unbounded_no_scissor_fallbacks`: child layers that fell back because no reliable scissor bound existed.
- `unbounded_transform_fallbacks`: child layers that fell back because active transforms could not be bounded.
- `unbounded_inverse_clip_fallbacks`: child layers that fell back because inverse clip bounds could not be represented conservatively.
- `passes`, `views`, `view_reuses`: pass-builder operations, newly allocated bgfx views, and operations that reused the current view.
- `pass_*`: reason-specific pass diagnostics for geometry, clear, filter, composite, copy, and save paths.
- `color_filter_folds`: opacity/color-matrix-only filter chains applied by the composite-filter shader instead of the postprocess pipeline.
- `full_frame_clear_passes`, `full_frame_composite_passes`, `full_frame_postprocess_passes`: pass-type breakdown of full-frame work.
- `full_frame_postprocess_target_uses`: per-frame full-frame postprocess target use, including reused targets where `rt_alloc=0`.
- `full_frame_postprocess_targets`: allocation-time full-frame target count; useful but insufficient alone.
- `max_child_layer`: largest child layer, excluding the base/root layer.
- `max_child_rt`: largest child-layer render target; should remain near affected UI content size for bounded scenes.
- `max_rt`: largest postprocess target used this frame.
- `clear_px`, `copy_px`, `composite_px`, `post_px`: pixel-work buckets.
- `rt_alloc`, `rt_destroy`, `layer_alloc`, `layer_destroy`: steady-state allocation health only; zero does not imply bounded work.

## Known Limitations

- Filters have bounded work targets in the readback gallery, color-only filter chains now bypass postprocess, and mask-image-only filters avoid the preliminary source copy. Blur and drop-shadow still use the conservative bounded postprocess path.
- Postprocess targets are reused at steady state; remaining filter work is semantic cleanup and pixel-work reduction, not allocation churn.
- Child layer render targets are reused at steady state; remaining allocation churn is in postprocess targets.
- The web smoke gate passes after Phase 4 for the readback gallery.
- The base presentation path may remain offscreen on WebGL; this is acceptable until bounded child/filter work is stable across platforms.

## Next Implementation Task

Move to Phase 8 after the completed Phase 7 pass/view reduction. The next target is saved texture/mask-image bounds and ownership behavior where profiling or correctness tests show remaining waste; do not reopen Phase 7 unless a concrete fixture demonstrates a safe redundant-clear or copy-removal opportunity.

Do not start physical extraction to a separate repository until Phase 7 correctness/perf semantics are tightened.
