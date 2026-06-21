# RmlUi bgfx Renderer Optimization Plan

The current renderer is functionally ambitious: it supports RmlUi geometry, textures, stencil clip masks, layers, filters, gradients, saved layers, mask images, and WebGL feedback-loop protection. The current performance problem is not that RmlUi or bgfx are fundamentally the wrong abstraction. The problem is that the renderer currently treats many small UI effects as full-frame offscreen render passes.

The immediate goal is to turn the renderer from a functionally complete but full-frame compositor into a bounded compositor. Small elements should produce small render targets, small postprocess passes, small copies, and small composites. Full-frame render targets and passes should be reserved for the base layer, the final backbuffer composite, and truly unbounded fallback cases.

## Status Legend

- `[done]`: phase acceptance criteria are complete.
- `[next]`: next phase to plan or implement.
- `[active]`: implementation is in progress.
- `[blocked]`: cannot proceed until a listed dependency is resolved.
- `[pending]`: not started.

## Current Direction

RmlUi remains the primary general runtime UI layer for NovelTea. It should support normal RML/RCSS authoring, rich styled UI, filters, decorators, clipping, masks, transforms, and custom C++ elements where needed.

bgfx remains the renderer backend. The RmlUi renderer must work across desktop, web/Emscripten/WebGL, and Android. WebGL is the strictest and most performance-sensitive target because framebuffer switches, full-frame postprocess passes, and feedback loops are especially expensive there.

The renderer should behave like a real UI compositor:

1. Direct geometry should render as normal geometry.
2. Rectangular clipping should use scissor where possible.
3. Complex clip masks should use stencil, but only inside bounded layer regions when possible.
4. Filtered, masked, or saved subtrees should render into bounded offscreen textures.
5. Postprocess passes should execute over the bounded work area, not the whole framebuffer.
6. Composites should draw only the destination rectangle affected by the source.
7. Full-frame fallback should be explicit, instrumented, and rare.

The renderer should be optimized for the common NovelTea case: visual-novel-style 2D UI with text, panels, choices, images, active text effects, tweened transitions, masks, and localized filter effects. A tiny blur or drop shadow must not become a full-canvas postprocess pipeline.

## Problem Summary

The current renderer pays full-frame costs for small effects.

The readback gallery is a compact RmlUi document with small panels and tiny filtered elements. Despite that, the web build can report very low FPS and a large per-frame pixel workload because the renderer allocates full-frame layers and full-frame postprocess targets, then runs full-frame copies, filters, composites, and mask operations.

The main problem areas are:

- `ensure_layer(size_t index)`
  - Allocates every layer as `width x height`.
  - Allocates a full-size color target and full-size depth/stencil target per layer.
  - Records layer dimensions as the full framebuffer.

- `ensure_postprocess_target(PostprocessTargetKind kind)`
  - Claims to use a work area but currently uses `work_w = width` and `work_h = height`.
  - Allocates full-frame primary, secondary, tertiary, scratch, and mask/blend targets.

- `composite(const CompositeOp& op)`
  - Acquires a pass with full `width x height`.
  - Draws a fullscreen triangle.
  - Uses source UV bounds `{0, 0, 1, 1}`.
  - Counts full-frame pixels for each composite.

- `fullscreen_filter_pass(...)`
  - Acquires a full-frame postprocess pass.
  - Runs opacity, color matrix, mask, blur, and shadow work over the whole framebuffer.

- `apply_filters(...)`
  - Copies the source to a full-frame postprocess target.
  - Runs blur and drop shadow using full framebuffer dimensions for texel offsets.
  - Composites original content and filtered content through full-frame paths.

- `SaveLayerAsMaskImage()`
  - Copies the full framebuffer-sized layer even when the mask belongs to a small element.

- `submit_to_clip_mask(...)` and stencil normalization
  - Use full-frame view dimensions even when the active scissor/layer area is small.
  - Render actual geometry, so this is less severe than filter/composite passes, but it still needs bounded accounting and bounded layer integration.

The current `shaded_pixels` counter is useful as an alarm, but it is too coarse. It overcounts ordinary geometry and clip draws by charging full-frame area for each geometry submit. It should be replaced with pass-specific counters so performance regressions are easy to diagnose.

## Non-Negotiable Architecture Rules

Do not remove RmlUi as the primary runtime UI layer.

Do not avoid the problem by disabling filters, masks, clips, gradients, or saved layers globally. Temporary debug flags are acceptable, but production behavior must support RmlUi’s advanced render interface correctly.

Do not solve the problem by capping DPR as the main fix. DPR capping may be useful for debug comparison or emergency web fallback, but the renderer must be efficient at high DPI.

Do not make web behave differently unless required by WebGL capabilities. Desktop, Android, and web should share the same bounded compositor architecture.

Do not introduce OpenGL/WebGL calls directly into the RmlUi renderer. All rendering must continue through bgfx.

Do not treat full-frame fallback as invisible. Any fallback to full-frame child layers or full-frame postprocess must be counted and logged.

Do not sacrifice correctness of clipping, transforms, masks, filter expansion, blend modes, or WebGL feedback-loop avoidance for speed. Optimize by bounding and simplifying work, not by dropping visual semantics.

Keep pure math and planning logic testable without bgfx where possible.

## Target Renderer Model

The renderer should be structured around these concepts.

### Surface

The surface represents the actual framebuffer/backbuffer dimensions and the logical UI dimensions.

```cpp
struct SurfaceState {
    int framebuffer_width = 1;
    int framebuffer_height = 1;
    int logical_width = 1;
    int logical_height = 1;
    float scale_x = 1.0f;
    float scale_y = 1.0f;
};
```

The surface is global to the frame. It is not the correct size for every child layer or postprocess target.

### Rectangles

Use explicit logical and framebuffer rectangles.

```cpp
struct LogicalRect {
    float x = 0.0f;
    float y = 0.0f;
    float w = 0.0f;
    float h = 0.0f;
};

struct FbRect {
    int x = 0;
    int y = 0;
    int w = 0;
    int h = 0;
};

struct RenderBounds {
    LogicalRect logical;
    FbRect framebuffer;
};
```

All helpers should make empty/intersection/inflation behavior explicit.

Required helpers:

- `area(FbRect)`
- `is_empty(FbRect)`
- `intersect(FbRect, FbRect)`
- `inflate(FbRect, int x, int y)`
- `clamp_to_surface(FbRect, SurfaceState)`
- `logical_to_framebuffer(LogicalRect, SurfaceState)`
- `framebuffer_to_logical(FbRect, SurfaceState)`
- `align_outward_for_render_target(FbRect)`
- `uv_rect_for_source_region(FbRect source_region, int texture_width, int texture_height)`

### Layers

A layer is not inherently full-screen. It has an origin, a logical coverage area, framebuffer coverage, texture dimensions, attachments, clip state, and inherited clip commands.

```cpp
struct LayerRecord {
    bgfx::FrameBufferHandle framebuffer = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle color = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle depth_stencil = BGFX_INVALID_HANDLE;

    RenderBounds bounds;
    int texture_width = 0;
    int texture_height = 0;

    bool clip_mask_enabled = false;
    uint8_t stencil_ref = 1;
    std::vector<size_t> clip_commands;
};
```

The base layer may remain full-frame initially. Child layers should use bounded rectangles whenever a reliable bound exists.

### Postprocess Targets

Postprocess targets are temporary scratch textures sized for a specific work area.

```cpp
struct RenderTargetRecord {
    bgfx::FrameBufferHandle framebuffer = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle color = BGFX_INVALID_HANDLE;

    FbRect bounds;
    int texture_width = 0;
    int texture_height = 0;
    PostprocessTargetKind kind = PostprocessTargetKind::Primary;
};
```

A target is reusable only if its kind and dimensions match the requested work size. It should not be assumed that one primary target size is valid for every filtered element in the frame.

### Compositing

Compositing must be rectangle-aware.

```cpp
struct CompositeRectOp {
    bgfx::TextureHandle source = BGFX_INVALID_HANDLE;
    bgfx::FrameBufferHandle destination = BGFX_INVALID_HANDLE;

    FbRect source_rect;
    FbRect destination_rect;

    int source_texture_width = 0;
    int source_texture_height = 0;

    Rml::BlendMode blend_mode = Rml::BlendMode::Blend;
    ScissorState scissor;
    bool apply_destination_stencil = false;
    uint8_t stencil_ref = 1;

    RmlUiPassKind kind = RmlUiPassKind::LayerComposite;
    const char* name = "RmlUi.CompositeRect";
};
```

The composite draw should rasterize only the destination rectangle and sample only the source rectangle.

### Filter Work Areas

Filters must operate on bounded work areas with padding for visual expansion.

```cpp
struct FilterExpansion {
    int left = 0;
    int top = 0;
    int right = 0;
    int bottom = 0;
};

struct FilterWorkArea {
    RenderBounds source_bounds;
    RenderBounds output_bounds;

    FbRect source_rect_in_work_texture;
    int work_width = 0;
    int work_height = 0;
};
```

Blur and drop shadow must expand the output bounds. Color matrix and opacity normally do not. Mask images normally do not expand, but they require correct source/mask UV mapping.

## Phase 0 [done]: Instrumentation and Baseline Metrics

Goal: make the performance problem measurable before changing behavior.

The current `PerfCounters` should be split into precise categories. Keep the old headline count temporarily if useful, but add enough detail to identify which pass kinds are expensive.

Implement:

- `pass_count`
- `geometry_draws`
- `geometry_indices`
- `clip_mask_draws`
- `gradient_draws`
- `clear_passes`
- `copy_passes`
- `composite_passes`
- `postprocess_passes`
- `blur_passes`
- `dropshadow_passes`
- `mask_passes`
- `full_frame_passes`
- `bounded_passes`
- `full_frame_layers`
- `bounded_layers`
- `unbounded_layer_fallbacks`
- `full_frame_postprocess_targets`
- `bounded_postprocess_targets`
- `steady_state_allocations`
- `geometry_estimated_pixels` if a bounds estimate exists
- `clip_estimated_pixels` if a bounds estimate exists
- `clear_pixels`
- `copy_pixels`
- `composite_pixels`
- `postprocess_pixels`
- `max_layer_width`
- `max_layer_height`
- `max_postprocess_width`
- `max_postprocess_height`

Update the periodic `[perf]` log to include separate pixel buckets:

```text
[perf] fps=...
       passes=...
       geom=... clip=... gradients=...
       layers=... full_layers=... bounded_layers=...
       filters=... blur=... shadow=... mask=...
       clear_px=... copy_px=... composite_px=... post_px=...
       full_frame_passes=... bounded_passes=...
       rt_alloc=... rt_destroy=... layer_alloc=... layer_destroy=...
       max_layer=... max_rt=... fb=...
```

Do not change renderer behavior in this phase.

Acceptance criteria:

- Existing visual output remains unchanged.
- Existing tests pass.
- Readback gallery still renders.
- The performance log makes it clear how many full-frame copy/composite/postprocess passes are happening.
- The log distinguishes geometry draw count from postprocess/composite pixel area.
- The log can prove whether later phases reduce full-frame work.

## Phase 1 [done]: Pure Rectangle and Bounds Planning

Goal: introduce testable rectangle, bounds, and filter-expansion helpers before changing bgfx rendering behavior.

Implement internal helpers for:

- integer framebuffer rectangles
- floating logical rectangles
- intersection
- union
- inflation
- clamping
- area calculation
- logical-to-framebuffer conversion
- framebuffer-to-logical conversion
- source UV calculation
- blur expansion
- drop-shadow expansion
- filter-chain expansion

These helpers should live in a small renderer-internal module, not as ad hoc local functions buried inside `rmlui_render_interface_bgfx.cpp`.

Possible files:

```text
engine/src/ui/rmlui/rmlui_render_bounds.hpp
engine/src/ui/rmlui/rmlui_render_bounds.cpp
tests/ui/rmlui/rmlui_render_bounds_tests.cpp
```

The helpers should be independent from bgfx. They may depend on RmlUi rectangle/vector types only if that keeps call sites simple. Prefer small internal POD types if it makes tests easier.

Acceptance criteria:

- Unit tests cover empty rectangles, intersection, clamping, inflation, DPR conversion, and UV calculation.
- Blur expansion is conservative enough to avoid clipped blur edges.
- Drop-shadow expansion accounts for offset and blur radius.
- Helpers support non-integer DPR such as 1.25.
- Helpers support negative or offscreen source rectangles and clamp correctly.
- No renderer behavior changes yet except optional logging of computed candidate bounds.

## Phase 2 [next]: Bounded Layer Allocation

Goal: stop allocating every child layer as full framebuffer size.

Change layer creation from:

```cpp
ensure_layer(size_t index)
```

to a bounded form:

```cpp
ensure_layer(size_t index, const RenderBounds& bounds)
```

The base layer can remain full-frame in this phase.

Child layer bounds policy:

1. If there is an active scissor region, use the scissor region as the first reliable bound.
2. If the requested layer inherits a parent layer, clamp child bounds to the parent layer bounds.
3. If a transform or operation prevents reliable bounding, fall back to full-frame but log `unbounded_layer_fallback`.
4. If there is no scissor and no reliable bound, fall back to full-frame but log it.
5. Never allocate zero-size layers.

Rendering into a bounded layer must account for the layer origin. There are two viable approaches:

1. Per-layer projection:
   - Build an orthographic projection matching the layer’s logical bounds.
   - RmlUi geometry remains in document logical coordinates.
   - The layer target covers only its local bounds.

2. Global projection plus translation:
   - Keep global projection semantics but subtract layer origin from geometry.
   - This may be more error-prone with transforms and clip masks.

Prefer per-layer projection unless it conflicts with existing shader assumptions.

Update:

- `LayerRecord`
- `ensure_layer`
- `begin_base_layer`
- `PushLayer`
- layer clear paths
- inherited clip replay paths
- performance counters

Acceptance criteria:

- Base layer still renders correctly.
- Child layers with active scissor allocate to scissor size.
- Full-frame child layer fallback is explicit and logged.
- Existing clip/mask/filter gallery remains visually correct.
- No steady-state allocations after warmup.
- Tests cover child layer bound selection.

## Phase 3 [pending]: Rectangle-Aware Compositing

Goal: replace full-frame compositing with bounded compositing.

Refactor the current fullscreen `composite()` path into a rectangle-aware path. The new composite operation must know:

- source texture
- source rectangle in source texture coordinates
- destination framebuffer
- destination rectangle
- source texture dimensions
- blend mode
- scissor
- stencil state
- pass kind/name

Implementation options:

1. Dynamic quad:
   - Create transient vertices for the destination rectangle and UV rectangle.
   - Submit two triangles.
   - Simple and explicit.

2. Unit quad with uniforms:
   - Reuse a static quad.
   - Pass destination rectangle and UV rectangle through uniforms.
   - Less per-draw vertex data but more shader changes.

Use the simplest correct implementation first. A dynamic quad is acceptable unless profiling proves it matters.

Update these paths:

- layer composites
- scratch copies
- filter copy into primary target
- drop-shadow original composite
- final composite if applicable
- copy-to-framebuffer fallback

Keep the existing WebGL feedback-loop checks.

The final composite from the base layer to the backbuffer may remain full-frame initially. That should be one full-frame pass, not dozens.

Acceptance criteria:

- Layer-to-layer composites rasterize only the affected destination rectangle.
- Scratch copies do not copy full-frame unless the source bounds are full-frame.
- Composite pixel counters use destination rectangle area.
- Source UVs are correct for bounded source textures.
- WebGL feedback-loop protection still works.
- Readback gallery output remains visually correct.

## Phase 4 [pending]: Bounded Postprocess Targets

Goal: make postprocess targets sized to filter work areas instead of the full framebuffer.

Change `ensure_postprocess_target(PostprocessTargetKind kind)` to accept requested dimensions or bounds:

```cpp
RenderTargetRecord* ensure_postprocess_target(
    PostprocessTargetKind kind,
    int width,
    int height);
```

or:

```cpp
RenderTargetRecord* ensure_postprocess_target(
    PostprocessTargetKind kind,
    const FbRect& bounds);
```

Postprocess target reuse should be dimension-aware. A target can be reused when its dimensions are sufficient and the renderer intentionally supports over-allocation, or when dimensions match exactly. The first implementation should prefer exact dimensions for easier correctness and diagnostics.

Update `RenderTargetRecord` to store dimensions and bounds.

Do not use global framebuffer `width` and `height` inside postprocess target allocation except for full-frame fallback.

Acceptance criteria:

- Tiny filters allocate tiny postprocess targets.
- `max_postprocess_width` and `max_postprocess_height` reflect actual work sizes.
- Full-frame postprocess target allocation is rare and logged.
- No steady-state allocation churn after warmup for stable documents.
- Existing visual output remains correct.

## Phase 5 [pending]: Bounded Filter Pipeline

Goal: run filters over bounded work areas with correct padding and UV mapping.

Refactor `apply_filters(...)` so it receives enough context:

```cpp
bgfx::TextureHandle apply_filters(
    bgfx::TextureHandle source,
    const RenderBounds& source_bounds,
    Rml::Span<const Rml::CompiledFilterHandle> filters,
    FilterResult* out_result);
```

The result should include:

```cpp
struct FilterResult {
    bgfx::TextureHandle texture = BGFX_INVALID_HANDLE;
    RenderBounds output_bounds;
    FbRect valid_rect_in_texture;
    int texture_width = 0;
    int texture_height = 0;
};
```

Filter pipeline:

1. Compute total filter expansion.
2. Clamp output bounds to surface or parent layer as appropriate.
3. Allocate primary and secondary targets to the work size.
4. Clear primary target to transparent.
5. Copy source rect into primary at the padded offset.
6. Run each filter over the bounded target.
7. Return the final texture and output bounds.
8. Composite the final texture back using bounded compositing.

Filter-specific requirements:

- Opacity:
  - No expansion.
  - Can be a bounded pass initially.
  - Later may be folded into final composite.

- Color matrix filters:
  - No expansion.
  - Bounded pass.
  - Later consecutive color matrices may be combined.

- Mask image:
  - No expansion.
  - Must sample the mask with correct bounded UVs.
  - Must not assume mask texture is full-frame.

- Blur:
  - Expansion should be conservative, for example `ceil(3 * sigma)` pixels.
  - Vertical texel step uses `1.0 / work_height`.
  - Horizontal texel step uses `1.0 / work_width`.
  - Shader `u_texCoordBounds` must reflect valid source region inside the work texture if needed.

- Drop shadow:
  - Expansion includes blur radius and absolute offset.
  - Shadow offset is normalized to work texture dimensions.
  - Original content composite must use bounded compositing.
  - Avoid feedback loops by ping-ponging targets or using scratch as needed.

Acceptance criteria:

- Blur of a tiny element no longer runs over the full framebuffer.
- Drop shadow of a tiny element no longer runs over the full framebuffer.
- Opacity/color matrix filters no longer allocate full-frame targets.
- Filter expansion prevents clipped blur/shadow edges.
- Visual output matches existing readback expectations.
- Performance logs show postprocess pixels reduced by at least an order of magnitude on the readback gallery.

## Phase 6 [pending]: Saved Layer and Mask Image Bounds

Goal: stop saving full-frame textures for small layer/mask operations.

Update `SaveLayerAsTexture()` and `SaveLayerAsMaskImage()` so both use the current bounded layer/scissor/content area rather than defaulting to the full framebuffer.

`SaveLayerAsTexture()` already uses scissor when available. Preserve that behavior, but make it layer-origin-aware.

`SaveLayerAsMaskImage()` currently copies full bounds. Change it to use the active layer/scissor/bounds, and store enough metadata to sample the mask correctly later.

Possible structures:

```cpp
struct SavedLayerTextureRecord {
    bgfx::TextureHandle handle = BGFX_INVALID_HANDLE;
    RenderBounds bounds;
    int texture_width = 0;
    int texture_height = 0;
};
```

`TextureRecord` may need to grow beyond just `handle`, dimensions, and ownership.

Acceptance criteria:

- Mask images for small elements create small saved textures.
- Mask sampling remains visually correct.
- Saved layer textures store bounds metadata.
- Releasing saved mask filters destroys associated saved textures.
- Readback gallery `saved_mask` remains correct.
- Performance logs show no full-frame saved-mask copy for small masks.

## Phase 7 [pending]: Clip Mask and Stencil Bounds

Goal: align clip mask rendering with bounded layers and avoid unnecessary full-frame stencil work.

Clip masks are currently less severe than filters because they draw actual geometry, but clears and stencil normalization can still become full-layer operations. Once layers are bounded, these operations should naturally become bounded as well.

Update:

- `clear_active_stencil`
- `submit_to_clip_mask`
- `decrement_stencil_ref`
- `normalize_active_stencil_to_one`
- inherited clip replay
- clip command storage

Rules:

1. Stencil clears should clear only the active layer or active scissor bounds.
2. Clip mask geometry should render in the current bounded layer projection.
3. Inherited clip commands should be replayed only if they intersect the child layer.
4. Rectangular clipping should stay as scissor and avoid stencil where possible.
5. Border-radius and complex clip masks can continue using stencil.

Acceptance criteria:

- Clip-mask rendering remains correct for rounded clips and transformed clips.
- Stencil clears are bounded.
- Inherited clip replay skips commands outside the child layer.
- Clip-related performance counters stop charging full-frame area when the active layer is bounded.
- Existing readback clip tests remain correct.

## Phase 8 [pending]: No-Op and Filter Simplification

Goal: reduce pass count after bounded rendering is correct.

Implement no-op filter elimination:

- `opacity(1)` is no-op.
- `blur(0)` and near-zero blur are no-op.
- identity color matrix is no-op.
- `brightness(1)` is no-op.
- `contrast(1)` is no-op.
- `invert(0)` is no-op.
- `grayscale(0)` is no-op.
- `sepia(0)` is no-op.
- `hue-rotate(0)` is no-op.
- `saturate(1)` is no-op.

Implement safe filter combination:

- Consecutive color-matrix filters can be multiplied into one matrix.
- Opacity may be folded into a color matrix where appropriate.
- Opacity may be folded into final composite when there is no semantic difference.
- Drop shadow with sigma below threshold skips blur passes.

This phase should not happen before bounded postprocess is correct. Simplifying full-frame passes is useful, but bounding them is the primary win.

Acceptance criteria:

- No-op filters do not allocate postprocess targets.
- No-op filters do not submit postprocess passes.
- Consecutive color-matrix filters reduce pass count.
- Visual output remains correct.
- Tests cover each no-op filter case.

## Phase 9 [pending]: Base Layer and Direct-to-Backbuffer Optimization

Goal: consider removing the full-frame base offscreen layer where safe.

The current renderer renders the base RmlUi layer into an offscreen framebuffer and then composites it to the backbuffer. Keeping that initially is acceptable. One full-frame base/final composite is not the main performance problem.

After bounded child layers and filters are complete, evaluate direct-to-backbuffer rendering for the base layer.

Possible policy:

- Render base directly to backbuffer when:
  - no root-level filters require saving the whole root,
  - stencil behavior is supported directly,
  - backbuffer clear ordering is safe,
  - final composite is not needed for premultiplied conversion or render-target origin correction.

- Use offscreen base layer when:
  - root itself needs filter/mask/save-layer behavior,
  - backbuffer stencil is unavailable or unreliable,
  - platform-specific origin/resolve behavior requires it.

Acceptance criteria:

- Direct-to-backbuffer mode is optional and capability-gated.
- Existing offscreen base path remains available.
- WebGL behavior remains correct.
- Performance improvement is measured separately from the bounded compositor work.
- No correctness regression in readback gallery.

## Phase 10 [pending]: Web Performance Smoke and Regression Gates

Goal: prevent the renderer from returning to full-frame postprocess behavior.

Add a web runtime smoke/performance test for the readback gallery or an equivalent deterministic document.

The test should verify:

- The web build initializes.
- The gallery renders without WebGL feedback-loop errors.
- Steady-state allocations drop to zero after warmup.
- Full-frame postprocess pass count is zero or explicitly justified.
- Full-frame child layer count is zero or explicitly justified.
- Total postprocess/composite pixels remain below a documented threshold for the scene and framebuffer size.
- Console logs do not contain repeated `GL_INVALID_OPERATION` feedback loop errors.

Avoid brittle absolute FPS gates in CI. Use structural metrics instead. FPS varies by runner, browser, virtualization, and display scheduling. Pixel/pass/target metrics are more deterministic.

Acceptance criteria:

- CI can catch accidental reintroduction of full-frame filter targets.
- CI can catch full-frame saved mask copies.
- CI can catch steady-state render-target allocation churn.
- Browser smoke verifies the renderer can run the gallery without catastrophic logs.

## Phase 11 [pending]: Documentation and Status Update

Goal: make the new renderer model clear for future agents.

Update:

```text
docs/rendering/RMLUI_BGFX_STATUS.md
docs/rendering/RMLUI_BGFX_OPTIMIZATION_PLAN.md
```

Document:

- The bounded compositor model.
- The difference between RmlUi logical coordinates and framebuffer coordinates.
- How layer bounds are selected.
- How filter expansion is computed.
- How postprocess targets are pooled.
- Why full-frame fallback exists and when it is allowed.
- How to read the performance log.
- Current known limitations.

Acceptance criteria:

- Future agents do not assume all RmlUi layers are full-frame.
- Future agents know not to “fix” artifacts by reverting to full-frame passes.
- Status docs distinguish functional completeness from performance completeness.
- Web performance smoke status is clearly marked.

## Implementation Notes

### Correctness First

The first bounded implementation can be conservative. If a case is hard to bound safely, use full-frame fallback and log it. The goal is not to eliminate every full-frame pass immediately. The goal is to eliminate accidental full-frame work for common small scissored/filtered elements.

### Scissor as Initial Bounds Source

RmlUi commonly sets scissor around clipped, filtered, or saved content. Use active scissor as the first reliable source of child layer bounds. Later phases can derive tighter geometry/content bounds if RmlUi does not provide a scissor for some layer operations.

### Transforms

Transforms require caution. A transformed rectangle may need bounds computed from transformed corners. Until transform bounds are implemented, transformed layers may fall back to full-frame. Log this distinctly as `transform_unbounded_fallback` so it is not confused with normal behavior.

### DPR

All bounds must be converted carefully between logical coordinates and framebuffer pixels. Non-integer DPR values such as 1.25 must be supported. Rectangles should generally round outward when allocating render targets so visual content is not clipped.

### Blur Padding

A Gaussian blur needs padding beyond the source rectangle. A conservative radius of `ceil(3 * sigma)` is acceptable for the first implementation. If the shader only samples a fixed number of taps, use the actual maximum sampled radius.

### WebGL Feedback Loops

Keep all existing feedback-loop checks. Bounded render targets do not remove WebGL’s rule that a texture cannot be sampled while rendering into a framebuffer that owns the same texture.

### Render Target Pooling

Exact-size render-target pooling is simplest. If allocation churn appears for animated sizes, add bucketing later. Possible bucket policy:

- round widths/heights up to multiples of 16 or 32,
- reuse if target is at least requested size,
- keep UV bounds explicit so over-allocation remains correct.

Do not add bucketing until exact-size correctness is established.

### Metrics Over FPS

Do not rely only on FPS. Browser `requestAnimationFrame` caps visible FPS, and CI machines vary. Use these metrics as primary regression signals:

- full-frame postprocess pass count
- full-frame child layer count
- postprocess pixels
- composite pixels
- render-target allocation count
- maximum postprocess target size
- maximum child layer size

## Expected End State

For the readback gallery at a high-DPI web framebuffer, the renderer should show:

- one full-frame base/final path, unless direct-to-backbuffer is implemented,
- no full-frame postprocess targets for tiny filters,
- no full-frame saved mask textures for small masks,
- bounded blur and shadow passes,
- bounded layer composites,
- zero steady-state render-target allocation churn,
- dramatically lower postprocess/composite pixel counts,
- no WebGL feedback-loop errors,
- visually correct output.

The practical target is that the readback gallery becomes cheap enough that the browser refresh loop, not the renderer, is the limiting factor.
