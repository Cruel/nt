# RmlUi bgfx Status

Status values: NOT STARTED, IMPLEMENTED, NOT VERIFIED, VERIFIED.

Current commit inspected: `dfe4557f45990a31ff6360b9fa2a9f5855d956bd`.

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
| RenderToClipMask | IMPLEMENTED, NOT VERIFIED | Set/SetInverse/intersect paths and transformed replay are readback-covered; stencil overflow now preserves the accumulated mask with normalization, but visual overflow equivalence is still missing. |
| SetTransform | VERIFIED | Expanded readback gallery verifies transformed clipped output and escaped-region rejection. |
| PushLayer | IMPLEMENTED, NOT VERIFIED | Layer creation and inherited clip replay exist; transformed clip fixture is covered, but overflow replay still needs coverage after semantic fix. |
| CompositeLayers | VERIFIED | Linux readback covers filtered and gradient layer composition; same-layer composition still needs targeted coverage. |
| PopLayer | IMPLEMENTED, NOT VERIFIED | Restores active layer; exact parent-state restoration lacks a targeted test. |
| SaveLayerAsTexture | VERIFIED | Saved-layer copies now use bounded layer/scissor intersections and preserve saved bounds metadata. |
| SaveLayerAsMaskImage | VERIFIED | Saved-mask copies now use bounded layer attachments, preserve saved bounds metadata, and own the copied mask texture when borrowed attachment lifetime is unsafe. |
| CompileFilter | VERIFIED | Standard filter compile paths are covered by unit and readback tests for representative filters. |
| ReleaseFilter | VERIFIED | Mask-image filters release owned saved textures and clear the saved texture record metadata. |
| CompileShader | VERIFIED | Linear/radial/conic and repeating gradient records compile and shader assets stage. |
| RenderShader | VERIFIED | Linux readback covers standard gradient output; repeating variants still need pixel assertions. |
| ReleaseShader | IMPLEMENTED, NOT VERIFIED | Erases shader records; no lifecycle test yet. |

## Acceptance Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Baseline Linux configure/build/ctest before edits | VERIFIED | `cmake --preset linux-debug`, `cmake --build --preset linux-debug`, and `ctest --test-dir build/linux-debug --output-on-failure` passed 42/42 before edits. |
| Post-edit Linux build/ctest | VERIFIED | Build passed and ctest passed 42/42 after the transform replay and saved-mask ownership fixes. |
| Shader compilation for GLSL 120, ESSL 100, ESSL 300 | VERIFIED | `noveltea_shader_verify` passed in ctest after the color-matrix shader fix. |
| Transform-aware clip replay | VERIFIED | Clip commands capture transform-active flag and full matrix; expanded readback asserts transformed clip content and escaped background regions. |
| Stencil overflow preserves accumulated mask | IMPLEMENTED, NOT VERIFIED | Overflow now normalizes the accumulated stencil mask down to ref 1 using stencil-only decrement passes, then applies the new intersect at ref 2; deterministic planner test passes, but the required visual equivalence readback is still missing. |
| Saved-mask ownership | VERIFIED | `ReleaseFilter` releases and erases MaskImage-owned saved textures exactly once. |
| Full GL3-quality blur | NOT VERIFIED | Current GPU blur still stores four weights and seven taps; downsample/upsample large-sigma path is not implemented. |
| Capability-aware MSAA and resolve | NOT VERIFIED | Current layer path is single-sample only; portable MSAA/resolve planning and runtime coverage are missing. |
| Blit and shader-copy paths | IMPLEMENTED, NOT VERIFIED | Both code paths exist, but no test hook forces shader-copy fallback. |
| Standard color filter visual coverage | IMPLEMENTED, NOT VERIFIED | The bounded filter pipeline refactor landed and the saved `mask-image` readback issue is fixed; broader perf-log review is still pending before Phase 5 is closed. |
| Gradient visual coverage | VERIFIED | Expanded readback asserts linear, radial, conic, repeating linear, repeating radial, repeating conic, and multi-stop gradient regions. |
| RuntimeUI facade integration tests | NOT VERIFIED | Event-consumption polarity has tests; document/element/listener/data-model/reload/density/focus lifecycle tests are missing. |
| Linux visual readback | VERIFIED | `noveltea_rmlui_readback_capture` and `noveltea_rmlui_readback_verify` pass for the gallery, including the saved `mask-image` pixel. |
| Web headless-browser runtime smoke | VERIFIED | `scripts/web-smoke.mjs` runs the readback gallery in headless Chromium through Playwright, captures the renderer perf log, and fails on page/console errors. |
| Android packaged-shader verification | IMPLEMENTED, NOT VERIFIED | CI checks rmlui shader assets by program list; local Android assemble was not rerun in this pass. |
| Android emulator runtime smoke | NOT VERIFIED | No emulator smoke is implemented or run. |
| Latest GitHub Actions status checked | VERIFIED | Latest Build run `27728367992` for SHA `dfe4557f45990a31ff6360b9fa2a9f5855d956bd` succeeded. |

## Renderer Model

The current RmlUi bgfx renderer is a bounded compositor, not a full-frame compositor with a few special cases.

- Logical RmlUi coordinates are converted into framebuffer bounds when a layer, postprocess pass, or composite needs explicit pixel work.
- Child layers are bounded by the best reliable rectangle available, usually active scissor, then parent bounds, with explicit full-frame fallback when the bounds are unsafe or unavailable.
- Filter chains compute a work area first, then size temporary targets to that area instead of defaulting to the framebuffer.
- Composites are rectangle-aware: source and destination rectangles are tracked explicitly so copies and layer merges only shade the affected area.
- Clip/stencil operations stay inside the active bounded work area when possible.

## Perf Log Guide

The renderer emits a periodic `[perf]` line when render perf logging is enabled. The important fields are:

- `passes`: total bgfx passes acquired.
- `geom`, `clip`, `gradients`: draw categories, separated from postprocess and composite work.
- `layers`, `full_layers`, `bounded_layers`, `unbounded_layer_fallbacks`: layer allocation shape and fallback behavior.
- `filters`, `blur`, `shadow`, `mask`: filter workload counts.
- `base_direct`, `base_offscreen`, `base_fallback`: base presentation policy and fallbacks.
- `clear_px`, `copy_px`, `composite_px`, `post_px`: pixel work buckets for the current frame.
- `full_frame_passes`, `bounded_passes`: whether the work was explicitly bounded or had to fall back.
- `rt_alloc`, `rt_destroy`, `layer_alloc`, `layer_destroy`: steady-state allocation health.
- `max_layer`, `max_rt`, `fb`: the largest layer/target sizes observed alongside the current framebuffer dimensions.

The log is intended to show whether the renderer is staying in the bounded path. A rise in `full_layers`, `full_frame_passes`, or `max_rt` usually means a fallback or a regression in bound selection.

Current web-smoke baseline from the readback gallery:

```text
[perf] fps=2 passes=121 geom=27 clip=15 gradients=8 layers=13 full_layers=13 bounded_layers=1 unbounded_layer_fallbacks=12 filters=14 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=24901632 copy_px=9216 composite_px=23961600 post_px=13824000 full_frame_passes=66 bounded_passes=4 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1280x720 max_rt=1280x720 fb=1280x720
```

## Known Limitations

- The base presentation path may still be offscreen depending on capability gating and compatibility mode.
- Transform-derived bounds remain conservative, so some transformed layers still fall back to full-frame.
- The web smoke gate currently tracks the observed structural baseline for the readback gallery; it is a regression gate, not a strict end-state performance target.
- The docs now describe the bounded compositor model, but the implementation still relies on explicit fallback logging to explain rare full-frame work.
