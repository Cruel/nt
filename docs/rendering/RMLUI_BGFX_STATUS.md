# RmlUi bgfx Status

Status values: NOT STARTED, IMPLEMENTED, NOT VERIFIED, VERIFIED, FAILED BASELINE.

Current status: Phases 0 through 3 of [`RMLUI_BGFX_OPTIMIZATION_PLAN.md`](RMLUI_BGFX_OPTIMIZATION_PLAN.md) are implemented and verified on the Linux debug test suite. The renderer is functionally correct for the readback gallery and now records virtual child-layer commands with conservative content/mask bounds. It is still not an optimized bounded compositor because Phase 4 has not yet used the accumulated content bounds to allocate bounded child-layer render targets, and Phase 6 has not yet made the filter pipeline operate on valid content bounds.

## Current Performance Truth

The readback gallery remains functionally correct on Linux. The web path still performs too much full-frame work, but the Phase 3 fallback counters now show that child layers have conservative recorded bounds instead of immediate unbounded scissor/transform fallback.

Representative web perf after Phase 3:

```text
[perf] fps=5 passes=121 geom=27 clip=15 gradients=8 layers=13 full_layers=13 bounded_layers=1 full_frame_child_layers=12 bounded_child_layers=1 unbounded_layer_fallbacks=0 unbounded_no_scissor_fallbacks=0 unbounded_transform_fallbacks=0 unbounded_inverse_clip_fallbacks=0 filters=14 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=71838131 copy_px=14641 composite_px=69149262 post_px=39893805 full_frame_passes=66 bounded_passes=4 full_frame_clear_passes=27 bounded_clear_passes=2 full_frame_composite_passes=24 bounded_composite_passes=2 full_frame_postprocess_passes=15 bounded_postprocess_passes=0 full_frame_postprocess_target_uses=24 bounded_postprocess_target_uses=0 full_frame_postprocess_targets=0 bounded_postprocess_targets=0 rt_alloc=0 rt_destroy=0 layer_alloc=13 layer_destroy=13 max_layer=1423x1869 max_child_layer=1423x1869 max_child_rt=1423x1869 max_rt=1423x1869 fb=1423x1869
```

This is a partial plumbing success but still a failed optimization baseline. The important changes are:

- `unbounded_layer_fallbacks=0`: Phase 3 removed the old immediate no-scissor/transform fallback accounting for recorded virtual child layers.
- `unbounded_no_scissor_fallbacks=0`, `unbounded_transform_fallbacks=0`, `unbounded_inverse_clip_fallbacks=0`: there are no remaining unbounded child-layer fallback reasons in this gallery run.

The important remaining failures are:

- `full_frame_child_layers=12`: almost every child layer still materializes full-frame because Phase 4 has not consumed `valid_content_bounds` for allocation.
- `full_frame_clear_passes=27` and `clear_px=71838131`: layer clears are still dominated by full-frame materialized targets.
- `full_frame_composite_passes=24` and `composite_px=69149262`: composites are still dominated by full-frame source/destination bounds.
- `full_frame_postprocess_passes=15`, `full_frame_postprocess_target_uses=24`, and `post_px=39893805`: filters still run over full-frame work textures because Phase 6 has not split valid content bounds from allocation bounds.
- `max_child_layer=1423x1869`, `max_child_rt=1423x1869`, and `max_rt=1423x1869`: the largest child layer and postprocess targets are still framebuffer-sized.
- `layer_alloc=13 layer_destroy=13`: virtual child slots currently destroy previous materialized framebuffers before replacing the slot with a new recording record. This prevents bgfx framebuffer exhaustion but should be improved after bounded allocation is stable.

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
| PushLayer | IMPLEMENTED, FAILED BASELINE | Child layers are virtual/recorded and no longer count immediate unbounded fallbacks, but materialization still uses provisional bounds so most child render targets remain full-frame. |
| CompositeLayers | FAILED BASELINE | Functional, but composites are frequently full-frame because source layers are still materialized full-frame. |
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
| Phase 4: Bounded Layer Materialization and Replay | NOT STARTED | Next implementation task. Child layers still materialize using provisional/full-frame bounds. |

## Acceptance Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Linux build | VERIFIED | `cmake --build build/linux-debug` passes. |
| Linux test suite | VERIFIED | `ctest --test-dir build/linux-debug` passes 316/316, including RmlUi readback capture/verify. |
| Web sandbox rebuild | NOT VERIFIED | Not rerun after Phase 3 in this status update. |
| Web structural smoke | FAILED BASELINE | Representative web perf still has full-frame child layers, full-frame postprocess passes, and framebuffer-sized `max_child_layer`/`max_rt`. |
| Full GL3-quality blur | NOT VERIFIED | Current GPU blur still stores four weights and seven taps; downsample/upsample large-sigma path is not implemented. |
| Android emulator runtime smoke | NOT VERIFIED | No emulator smoke is implemented or run. |

## Renderer Model

The renderer now has the first half of a content-bounded compositor:

1. CPU-side geometry and shader bounds exist.
2. Child layers can record commands instead of allocating immediately.
3. Recorded commands accumulate conservative content and clip-mask bounds.
4. Remaining work is to consume those bounds during materialization, replay, filtering, and compositing.

The current full-frame performance is therefore no longer primarily a bounds-discovery failure. It is a bounds-consumption failure: the renderer knows more about virtual layer content than it uses when allocating child framebuffers and postprocess targets.

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
- `max_child_rt`: largest child-layer render target; currently equivalent to `max_child_layer` until materialization uses content bounds.
- `max_rt`: largest postprocess target used this frame.
- `clear_px`, `copy_px`, `composite_px`, `post_px`: pixel-work buckets.
- `rt_alloc`, `rt_destroy`, `layer_alloc`, `layer_destroy`: steady-state allocation health only; zero does not imply bounded work.

## Known Limitations

- `valid_content_bounds` is accumulated but not yet used to choose child framebuffer allocation bounds.
- Saved texture/mask copy paths still materialize the current layer before copy and rely on the current materialized layer bounds.
- Postprocess targets still receive full-frame source bounds when their source layer was allocated full-frame.
- Filters do not yet distinguish allocation bounds from valid content bounds.
- Child layer allocation churn is still visible in the readback gallery.
- The web smoke gate remains intentionally strict and fails until bounded materialization/filter work is implemented.
- The base presentation path may remain offscreen on WebGL; this is acceptable until child layer/filter full-frame work is fixed.

## Next Implementation Task

Implement Phase 4 from [`RMLUI_BGFX_OPTIMIZATION_PLAN.md`](RMLUI_BGFX_OPTIMIZATION_PLAN.md): bounded layer materialization and replay. Materialization should choose child framebuffer bounds from accumulated content bounds plus required scissor/parent/clip/filter constraints, then replay recorded geometry/shader/clip-mask commands into that bounded target while preserving readback correctness. Do not start pass folding or direct-base optimization until `full_frame_child_layers`, `max_child_layer`, `clear_px`, and composite work are materially reduced for the readback gallery.
