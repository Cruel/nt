# RmlUi bgfx Status

Status values: NOT STARTED, IMPLEMENTED, NOT VERIFIED, VERIFIED, FAILED BASELINE.

Current status: Phases 0 through 4 of [`RMLUI_BGFX_OPTIMIZATION_PLAN.md`](RMLUI_BGFX_OPTIMIZATION_PLAN.md) are implemented and verified on the Linux debug test suite. Phase 4.5 Stage 0 through Stage 2 are also implemented and verified: the renderer now has a staged reusable `rmlui_bgfx` core target with generic surface, view-range, shader, texture, diagnostics, and perf-log provider interfaces, while NovelTea-specific AssetManager, shader-loader, view-id, surface, and logging behavior lives behind an adapter. Shared renderer-private records now live in reusable-core type headers, texture source-region plumbing uses an explicit `TextureRegion`, `BgfxTargetCache` owns child-layer and postprocess render-target resources plus their pool metadata, and `BgfxPassBuilder` owns pass scheduling plus bgfx view setup. The renderer is functionally correct for the readback gallery, records virtual child-layer commands with conservative content/mask bounds, and uses those bounds when materializing child render targets. The next work is Phase 4.5 Stage 3: extract the draw context without changing behavior. It is still not a fully optimized compositor because Phase 6 has not yet split postprocess work between allocation bounds and valid content bounds, and later phases still need pass folding and direct-base cleanup.

## Current Performance Truth

The readback gallery remains functionally correct on Linux. After Phase 4, child layers are no longer materialized full-frame in the representative Linux readback gallery run. The remaining heavy work is now bounded postprocess/composite work and steady-state target resizing that later phases can tighten.

Representative Linux perf after Phase 4 at 1280x720:

```text
[perf] fps=96 passes=108 geom=27 clip=15 gradients=8 layers=13 full_layers=1 bounded_layers=13 full_frame_child_layers=0 bounded_child_layers=13 unbounded_layer_fallbacks=0 unbounded_no_scissor_fallbacks=0 unbounded_transform_fallbacks=0 unbounded_inverse_clip_fallbacks=0 filters=14 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=980004 copy_px=9216 composite_px=985744 post_px=38352 full_frame_passes=2 bounded_passes=55 full_frame_clear_passes=1 bounded_clear_passes=15 full_frame_composite_passes=1 bounded_composite_passes=25 full_frame_postprocess_passes=0 bounded_postprocess_passes=15 full_frame_postprocess_target_uses=0 bounded_postprocess_target_uses=24 full_frame_postprocess_targets=0 bounded_postprocess_targets=12 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1280x720 max_child_layer=114x96 max_child_rt=114x96 max_rt=114x96 fb=1280x720
```

This is the first measured bounded-compositor success for the readback gallery. The important changes are:

- `full_frame_child_layers=0`: child layers are now materialized from recorded content/required bounds instead of the provisional full-frame fallback.
- `unbounded_layer_fallbacks=0`: there are still no unbounded child-layer fallback reasons in this gallery run.
- `max_child_layer=114x96`, `max_child_rt=114x96`, and `max_rt=114x96`: the largest child layer and postprocess target are near gallery effect sizes, not the 1280x720 framebuffer.
- `full_frame_passes=2`: the remaining full-frame work is the expected offscreen base clear and final base composite.
- `clear_px=980004`, `composite_px=985744`, and `post_px=38352`: pixel work has dropped by more than an order of magnitude from the Phase 3 baseline.

The important remaining work is:

- `layer_alloc=0 layer_destroy=0`: child layer render targets are reused at steady state, avoiding native GL flicker from per-frame child framebuffer churn.
- `rt_alloc=0 rt_destroy=0`: postprocess targets are also reused at steady state, eliminating the native GL instability caused by per-frame filter target churn.
- Filters now run over bounded targets, but Phase 6 still needs to make the filter API explicitly distinguish allocation bounds from valid content bounds throughout the pipeline.
- Pass count is still high (`passes=108`), which belongs to Phase 9 pass folding after bounded work is stable.

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
| SetTransform | VERIFIED | `compute_transformed_geometry_bounds()` is used for recorded command bounds; tests cover scale, rotation, translation, offscreen clipping, non-integer DPR, and invalid/non-finite input. |
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
| Phase 4.5 Stage 0: Reusable Core Boundary | VERIFIED | Added the staged `rmlui_bgfx_renderer` target, generic config/provider interfaces, and NovelTea adapter. Reusable-core files build without NovelTea AssetManager, SurfaceMetrics, shader loader, view IDs, SDL3, Lua, ImGui, runtime, custom component, or editor-preview dependencies. Linux readback and web smoke pass with the Phase 4 structural perf shape preserved. |
| Phase 4.5 Stage 0.5: Shared Types and Coordinate Discipline | VERIFIED | Added `rmlui_bgfx_types.hpp`, moved shared renderer-private records out of the monolithic render-interface source, added global/local framebuffer rect aliases and coordinate helper names, and introduced `TextureRegion` for composite/filter source regions. Linux build, readback, runtime perf smoke, web smoke, and format-check pass with the Phase 4 structural perf shape preserved. |
| Phase 4.5 Stage 1: Extract Target Caches | VERIFIED | Added `BgfxTargetCache` in reusable-core files. It owns child-layer framebuffer/color/depth-stencil resources, postprocess framebuffer/color resources, and layer/postprocess pool metadata. The render interface now delegates target creation, reuse, resize teardown, and destroy accounting to the cache. Linux build, readback, runtime perf smoke, web smoke, and format-check pass with steady-state `rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0`. |
| Phase 4.5 Stage 2: Extract Pass Builder | VERIFIED | Added `BgfxPassBuilder` in reusable-core files. It owns scheduler interaction, bgfx view names, view mode, view rects, framebuffer binding, and clear setup. Raw `bgfx::setViewName`, `setViewMode`, `setViewRect`, `setViewFrameBuffer`, and `setViewClear` calls are centralized in the pass builder. Linux build, readback, runtime perf smoke, web build/smoke, and format-check pass with the Phase 4 structural perf shape preserved. |

## Acceptance Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Linux build | VERIFIED | `cmake --build build/linux-debug` passes. |
| Linux test suite | VERIFIED | `ctest --test-dir build/linux-debug` passes 316/316, including RmlUi readback capture/verify. |
| Web sandbox rebuild | VERIFIED | `cmake --build --preset web-debug` passes after Phase 4. |
| Web structural smoke | VERIFIED | `node scripts/web-smoke.mjs` passes with zero full-frame child layers, zero unbounded fallbacks, zero full-frame postprocess passes, and `max_child_layer=114x96`. |
| Full GL3-quality blur | NOT VERIFIED | Current GPU blur still stores four weights and seven taps; downsample/upsample large-sigma path is not implemented. |
| Android emulator runtime smoke | NOT VERIFIED | No emulator smoke is implemented or run. |

## Renderer Model

The renderer is now a measured content-bounded compositor for child layers in the readback gallery:

1. CPU-side geometry and shader bounds exist.
2. Child layers can record commands instead of allocating immediately.
3. Recorded commands accumulate conservative content and clip-mask bounds.
4. Materialization consumes those bounds plus required filter/composite bounds to allocate bounded child targets.
5. Replay renders into bounded targets with local scissor, stencil, copy, and composite coordinates.

The remaining optimization work is no longer discovery or child-layer materialization. It is bounded-filter semantics, allocation reuse, pass-count reduction, and the later direct-base policy cleanup.

A small direct-base robustness fix is also present: root-preservation discovery is sticky across frames. If direct base presentation discovers that root filters require offscreen preservation, subsequent frames can choose offscreen presentation instead of repeatedly failing with `CompositeLayers root filters require offscreen presentation`. This is a recovery fix, not the final direct-base policy from the later optimization phases.

## Perf Log Guide

The renderer emits a periodic `[perf]` line when render perf logging is enabled. Important fields:

- `layers`, `full_layers`, `bounded_layers`: all layer pushes including the base/root layer.
- `full_frame_child_layers`, `bounded_child_layers`: child layers only; these are the key layer-optimization counters.
- `unbounded_layer_fallbacks`: total child-layer fallback count.
- `unbounded_no_scissor_fallbacks`: child layers that fell back because no reliable scissor bound existed.
- `unbounded_transform_fallbacks`: child layers that fell back because active transforms could not be bounded.
- `unbounded_inverse_clip_fallbacks`: child layers that fell back because inverse clip bounds could not be represented conservatively.
- `full_frame_clear_passes`, `full_frame_composite_passes`, `full_frame_postprocess_passes`: pass-type breakdown of full-frame work.
- `full_frame_postprocess_target_uses`: per-frame full-frame postprocess target use, including reused targets where `rt_alloc=0`.
- `full_frame_postprocess_targets`: allocation-time full-frame target count; useful but insufficient alone.
- `max_child_layer`: largest child layer, excluding the base/root layer.
- `max_child_rt`: largest child-layer render target; should remain near affected UI content size for bounded scenes.
- `max_rt`: largest postprocess target used this frame.
- `clear_px`, `copy_px`, `composite_px`, `post_px`: pixel-work buckets.
- `rt_alloc`, `rt_destroy`, `layer_alloc`, `layer_destroy`: steady-state allocation health only; zero does not imply bounded work.

## Known Limitations

- Filters have bounded work targets in the readback gallery, but the filter API still needs a cleaner explicit split between allocation bounds and valid content bounds.
- Postprocess targets are reused at steady state; remaining filter work is semantic cleanup and pixel-work reduction, not allocation churn.
- Child layer render targets are reused at steady state; remaining allocation churn is in postprocess targets.
- The web smoke gate passes after Phase 4 for the readback gallery.
- The base presentation path may remain offscreen on WebGL; this is acceptable until bounded child/filter work is stable across platforms.

## Next Implementation Task

Continue with Phase 4.5 Stage 3 from [`RMLUI_BGFX_OPTIMIZATION_PLAN.md`](RMLUI_BGFX_OPTIMIZATION_PLAN.md) and [`RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md`](RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md). Extract `BgfxDrawContext` from the monolithic render-interface implementation without changing behavior.

After Stage 3, continue Phase 4.5 subsystem extraction in order: filter pipeline, layer system, thin adapter cleanup, resize regression coverage, and docs/status updates. Do not start Phase 5/6, pass folding, direct-base tuning, or physical extraction to a separate repository until the in-repo reusable boundary and behavior-preserving subsystem split are verified.
