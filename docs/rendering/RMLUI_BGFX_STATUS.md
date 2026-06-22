# RmlUi bgfx Status

Status values: NOT STARTED, IMPLEMENTED, NOT VERIFIED, VERIFIED, FAILED BASELINE.

Current status: Phase 0 of [`RMLUI_BGFX_OPTIMIZATION_PLAN.md`](RMLUI_BGFX_OPTIMIZATION_PLAN.md) is implemented. The renderer now exposes enough structural counters for the web smoke gate to reject the current full-frame behavior. The renderer is still not an optimized bounded compositor.

## Current Performance Truth

The readback gallery remains functionally correct on Linux, but the web path still performs far too much full-frame work. After rebuilding `build/web-debug`, `node scripts/web-smoke.mjs` intentionally fails with this representative perf line:

```text
[perf] fps=2 passes=121 geom=27 clip=15 gradients=8 layers=13 full_layers=13 bounded_layers=1 full_frame_child_layers=12 bounded_child_layers=1 unbounded_layer_fallbacks=12 unbounded_no_scissor_fallbacks=12 unbounded_transform_fallbacks=1 unbounded_inverse_clip_fallbacks=0 filters=14 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=24901632 copy_px=9216 composite_px=23961600 post_px=13824000 full_frame_passes=66 bounded_passes=4 full_frame_clear_passes=27 bounded_clear_passes=2 full_frame_composite_passes=24 bounded_composite_passes=2 full_frame_postprocess_passes=15 bounded_postprocess_passes=0 full_frame_postprocess_target_uses=24 bounded_postprocess_target_uses=0 full_frame_postprocess_targets=0 bounded_postprocess_targets=0 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1280x720 max_child_layer=1280x720 max_child_rt=1280x720 max_rt=1280x720 fb=1280x720
```

This is a failed optimization baseline. The important failures are:

- `full_frame_child_layers=12`: almost every child layer is still full-frame.
- `unbounded_no_scissor_fallbacks=12`: child layer bounds still depend on scissor, and most advanced layers have no active scissor.
- `full_frame_postprocess_target_uses=24`: steady-state full-frame target use is visible even when `rt_alloc=0`.
- `full_frame_postprocess_passes=15`: filters/masks still run across the whole framebuffer.
- `max_child_layer=1280x720` and `max_rt=1280x720`: small readback-gallery effects still allocate/use framebuffer-sized work areas.

## RenderInterface 6.2 Method Coverage

| Method | Status | Evidence |
| --- | --- | --- |
| CompileGeometry | VERIFIED | Exercised by Linux readback capture and unit-linked renderer paths. |
| RenderGeometry | VERIFIED | Linux readback verifies textured/color geometry orientation and clip/filter/gradient output. |
| ReleaseGeometry | IMPLEMENTED, NOT VERIFIED | Destroys bgfx buffers; no lifecycle counter test yet. |
| LoadTexture | VERIFIED | Uses AssetManager plus bimg decode; file interface and shader/runtime asset tests pass. |
| GenerateTexture | VERIFIED | RmlUi font texture path is exercised by sandbox/readback capture. |
| ReleaseTexture | IMPLEMENTED, NOT VERIFIED | Releases external and saved-layer textures; no double-release lifecycle test yet. |
| EnableScissorRegion | VERIFIED | Save/copy and readback gallery exercise scissored output. |
| SetScissorRegion | VERIFIED | Clamp behavior is covered by readback/copy paths; no standalone edge-table test. |
| EnableClipMask | VERIFIED | Readback covers inherited clip-mask output. |
| RenderToClipMask | IMPLEMENTED, NOT VERIFIED | Set/SetInverse/intersect paths and transformed replay are readback-covered; stencil overflow visual equivalence still lacks a dedicated readback. |
| SetTransform | VERIFIED | Expanded readback gallery verifies transformed clipped output and escaped-region rejection. |
| PushLayer | FAILED BASELINE | Functional, but current bounds selection falls back to full-frame for most child layers. |
| CompositeLayers | FAILED BASELINE | Functional, but current composites are frequently full-frame because source layers are full-frame. |
| PopLayer | IMPLEMENTED, NOT VERIFIED | Restores active layer; exact parent-state restoration lacks a targeted test. |
| SaveLayerAsTexture | VERIFIED | Saved-layer copies use bounded layer/scissor intersections and preserve saved bounds metadata. |
| SaveLayerAsMaskImage | VERIFIED | Saved-mask copies preserve saved bounds metadata and own the copied mask texture when borrowed attachment lifetime is unsafe. |
| CompileFilter | VERIFIED | Standard filter compile paths are covered by unit and readback tests for representative filters. |
| ReleaseFilter | VERIFIED | Mask-image filters release owned saved textures and clear the saved texture record metadata. |
| CompileShader | VERIFIED | Linear/radial/conic and repeating gradient records compile and shader assets stage. |
| RenderShader | VERIFIED | Linux readback covers standard gradient output; repeating variants still need pixel assertions. |
| ReleaseShader | IMPLEMENTED, NOT VERIFIED | Erases shader records; no lifecycle test yet. |

## Acceptance Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Linux engine/sandbox/render-test build | VERIFIED | `cmake --build build/linux-debug --target engine noveltea-sandbox noveltea_render_tests -- -j2` passes. |
| Linux RmlUi readback | VERIFIED | `ctest --test-dir build/linux-debug -R 'noveltea_(render|rmlui_readback)_' --output-on-failure` runs the two readback tests and both pass. |
| Web sandbox rebuild | VERIFIED | `cmake --build build/web-debug --target noveltea-sandbox -- -j2` passes after the Phase 0 instrumentation changes. |
| Web structural smoke | FAILED BASELINE | `node scripts/web-smoke.mjs` now fails intentionally on full-frame child layers and full-frame postprocess target use. |
| Full GL3-quality blur | NOT VERIFIED | Current GPU blur still stores four weights and seven taps; downsample/upsample large-sigma path is not implemented. |
| Android emulator runtime smoke | NOT VERIFIED | No emulator smoke is implemented or run. |

## Renderer Model

The current renderer is a functional RmlUi bgfx renderer with partial bounded plumbing. It is not yet a successful content-bounded compositor.

The failed assumption in the previous optimization work was that active scissor or parent bounds would be enough to size child layers. The current perf counters prove otherwise: most advanced RmlUi child layers are pushed without an active scissor, so the renderer falls back to the full framebuffer before it knows the layer's actual content bounds.

The next architecture step is virtual child-layer recording:

1. Store CPU-side geometry/shader bounds.
2. Record child-layer draw commands instead of eagerly allocating a framebuffer at `PushLayer()`.
3. Accumulate content, scissor, clip, and transform bounds from recorded commands.
4. Materialize the smallest safe child framebuffer only when the layer texture is needed.
5. Run filters and composites over content-derived bounds rather than allocation-sized or framebuffer-sized bounds.

## Perf Log Guide

The renderer emits a periodic `[perf]` line when render perf logging is enabled. Phase 0 added explicit use counters so full-frame steady-state work cannot hide behind zero allocation churn.

Important fields:

- `layers`, `full_layers`, `bounded_layers`: all layer pushes including the base/root layer.
- `full_frame_child_layers`, `bounded_child_layers`: child layers only; these are the key layer-optimization counters.
- `unbounded_layer_fallbacks`: total child-layer fallback count.
- `unbounded_no_scissor_fallbacks`: child layers that fell back because no reliable scissor bound existed.
- `unbounded_transform_fallbacks`: child layers that fell back because active transforms are not yet content-bounded.
- `unbounded_inverse_clip_fallbacks`: child layers that fell back because inverse clip bounds could not be represented conservatively.
- `full_frame_clear_passes`, `full_frame_composite_passes`, `full_frame_postprocess_passes`: pass-type breakdown of full-frame work.
- `full_frame_postprocess_target_uses`: per-frame full-frame postprocess target use, including reused targets where `rt_alloc=0`.
- `full_frame_postprocess_targets`: allocation-time full-frame target count; useful but insufficient alone.
- `max_child_layer`: largest child layer, excluding the base/root layer.
- `max_child_rt`: largest child-layer render target; currently equivalent to `max_child_layer` until virtual layers split logical layer bounds from materialized render target bounds.
- `max_rt`: largest postprocess target used this frame.
- `clear_px`, `copy_px`, `composite_px`, `post_px`: pixel-work buckets.
- `rt_alloc`, `rt_destroy`, `layer_alloc`, `layer_destroy`: steady-state allocation health only; zero does not imply bounded work.

## Known Limitations

- Child layer bounds are still scissor-first and fall back to full-frame when no scissor exists.
- Transform-derived content bounds are not implemented.
- Postprocess targets still receive full-frame source bounds when their source layer was allocated full-frame.
- The web smoke gate is now intentionally strict and fails until real content bounds are implemented.
- The base presentation path may remain offscreen on WebGL; this is acceptable until child layer/filter full-frame work is fixed.

## Next Implementation Task

Implement Phase 1 from [`RMLUI_BGFX_OPTIMIZATION_PLAN.md`](RMLUI_BGFX_OPTIMIZATION_PLAN.md): CPU-side geometry/shader bounds and transform-bound helpers with tests. Do not start pass-count reduction or direct-base work until `full_frame_child_layers`, `unbounded_layer_fallbacks`, `full_frame_postprocess_target_uses`, and `max_child_layer` are materially reduced for the readback gallery.
