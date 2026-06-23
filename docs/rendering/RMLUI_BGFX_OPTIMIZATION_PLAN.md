# RmlUi bgfx Real Optimization Plan

This document replaces the previous 11-phase optimization plan. The earlier plan added many useful pieces: counters, rectangle helpers, postprocess target sizing, rectangle-aware composite metadata, no-op filter simplification, and a web smoke harness. However, the current measured renderer is still not performant. Treat the current implementation as a functional/correctness baseline with important instrumentation, not as a completed optimization.

The current blocker is clear: the renderer still executes most layer, clear, composite, and filter work over the full framebuffer. The code contains bounded paths, but the real readback gallery usually does not enter them because layer bounds are selected almost entirely from active scissor state. RmlUi often calls `PushLayer()` for filtered, masked, transformed, or blended content without an active scissor. The renderer then falls back to full-frame child layers, and every later bounded pipeline stage receives full-frame source bounds.

The new goal is to make work proportional to affected UI content, not framebuffer area.

## Current Baseline: Failed Optimization State

Current web smoke at 1280x720:

```text
[perf] fps=1 passes=121 geom=27 clip=15 gradients=8 layers=13 full_layers=13 bounded_layers=1 unbounded_layer_fallbacks=12 filters=14 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=24901632 copy_px=9216 composite_px=23961600 post_px=13824000 full_frame_passes=66 bounded_passes=4 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1280x720 max_rt=1280x720 fb=1280x720
```

Observed browser run at 1423x1869:

```text
[perf] fps=5 passes=121 geom=27 clip=15 gradients=8 layers=13 full_layers=13 bounded_layers=1 unbounded_layer_fallbacks=12 filters=14 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=71838131 copy_px=14641 composite_px=69149262 post_px=39893805 full_frame_passes=66 bounded_passes=4 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1423x1869 max_rt=1423x1869 fb=1423x1869
```

These numbers reveal the problem precisely. For 1423x1869, one full framebuffer is 2,659,587 pixels. The counters are effectively:

- `clear_px`: 27 full-frame equivalents.
- `composite_px`: 26 full-frame equivalents.
- `post_px`: 15 full-frame equivalents.
- `full_frame_passes`: 66.
- `full_layers`: 13.
- `unbounded_layer_fallbacks`: 12.
- `max_layer` and `max_rt`: equal to the framebuffer.

The readback gallery is a tiny 860x300 logical document with small panels and tiny filtered elements. A small blur, opacity, color matrix, drop shadow, rounded clip, or saved mask must not produce full-screen clears and fullscreen postprocess passes. The fact that FPS did not improve after the refactor is expected from these counters: the expensive work remains full-frame.

## Non-Negotiable Requirements

RmlUi remains the runtime UI system. Do not solve this by disabling filters, masks, layers, clips, gradients, transforms, or RmlUi advanced rendering features globally.

bgfx remains the rendering backend. Do not add direct OpenGL/WebGL calls to the RmlUi renderer.

Correctness remains mandatory. Do not drop clip masks, transforms, filter expansion, premultiplied alpha behavior, mask-image sampling, or WebGL feedback-loop protection to gain speed.

The renderer must be efficient at high-DPI framebuffer sizes. Do not treat DPR capping as the primary fix. DPR caps may be useful as a debug comparison or emergency option, but the compositor must stop scaling small UI effects to full-screen work.

The default path must pass correctness tests without a compatibility flag. Temporary compatibility flags are allowed only for bisecting behavior. They must not be required to make normal tests pass.

The web smoke gate must fail the current bad baseline. A smoke test that allows 13 full-frame child layers is only a regression-to-bad-baseline gate, not an optimization gate.

## Target Performance Shape

For the readback gallery, the steady-state target is structural, not a brittle absolute FPS number. On a normal desktop browser, the scene should plausibly run far above 60 FPS and should not be limited by the RmlUi renderer. A local 200+ FPS result is a reasonable expectation for this scene once full-frame effect work is removed, but CI should gate deterministic counters rather than FPS.

At 1280x720, the target shape is:

- `unbounded_layer_fallbacks = 0` for the readback gallery.
- `full_layers <= 1`, where the only allowed full-frame layer is the base/root layer if direct-to-backbuffer is not active.
- `full_frame_passes <= 2` in the normal offscreen-root path: base clear plus final base composite. If direct-to-backbuffer is correct and active, this can be lower.
- `max_rt` must be near the largest affected filter/mask region, not 1280x720.
- `max_child_layer` must be near the largest affected layer region, not 1280x720.
- `post_px` should be under a small fraction of framebuffer area for this scene. A reasonable first hard gate is `< 1.0 * framebuffer_area`, then tighten after the first successful bounded implementation.
- `composite_px` should be under a small multiple of actual document/effect area. A reasonable first hard gate is `< 3.0 * framebuffer_area`, then tighten after pass folding.
- `rt_alloc`, `rt_destroy`, `layer_alloc`, and `layer_destroy` must remain zero after warmup.

At the user's observed 1423x1869 framebuffer, these structural gates matter more than FPS. The current renderer spends roughly 68 full-frame equivalents per frame across clears, composites, and postprocess. The first real optimization milestone is to make that impossible.

## Core Diagnosis

### 1. Bounds discovery is insufficient

Current child layer bounds are selected from active scissor, parent bounds, and a conservative transform fallback. When scissor is unavailable, the renderer falls back to the full surface. This produces `unbounded_layer_fallbacks=12` in the readback gallery.

The missing data is content bounds. The renderer currently does not store CPU-side geometry bounds in `GeometryRecord`, does not accumulate layer content bounds from `RenderGeometry()`/`RenderShader()` calls, and does not derive transformed bounds. Without this, `PushLayer()` cannot know how large the layer should be.

### 2. Layers are allocated too early

RmlUi's advanced render API calls `PushLayer()` before the layer's contents are rendered. Since the renderer does not yet know the contents, eager framebuffer allocation at `PushLayer()` forces either scissor-only bounds or full-frame fallback.

The correct architecture is a virtual child layer: record commands, accumulate conservative content bounds, then materialize a GPU framebuffer when `CompositeLayers()`, `SaveLayerAsTexture()`, `SaveLayerAsMaskImage()`, or another operation actually needs the layer texture.

### 3. The bounded filter pipeline receives full-frame source bounds

`apply_filters(source, source_bounds, filters)` has bounded plumbing, but `source_bounds` is often the full source layer. Therefore primary/secondary postprocess targets are allocated full-frame and all filter passes remain full-frame.

### 4. The smoke gate accepts the bad state

`scripts/web-smoke-thresholds.json` currently allows `max_full_frame_child_layers = 13`. Also, `scripts/web-smoke.mjs` parses `full_frame_postprocess_targets`, but the perf log does not print that key. Even if it did, allocation-only counters are insufficient because a reused full-frame target can persist with `rt_alloc=0`.

### 5. Base-direct is a secondary issue

The compatibility flag and direct-base path are not the source of the current 5 FPS result. Web currently uses offscreen root, and one full-frame root clear/composite is acceptable. The catastrophic cost is full-frame child layers, full-frame child clears, full-frame filter passes, and full-frame child composites.

## New Implementation Strategy

The renderer must become a content-bounded compositor. The key design is:

1. Store geometry bounds at compile time.
2. Record commands for child layers instead of immediately rendering them to eagerly allocated full-frame textures.
3. Accumulate conservative content, clip, scissor, and transformed bounds while recording.
4. Materialize a child layer to a GPU framebuffer only when its texture is needed.
5. Allocate that framebuffer to the materialized bounds plus required filter expansion.
6. Replay the recorded commands into the bounded framebuffer with a per-layer projection.
7. Run filters over the materialized content bounds, not the framebuffer size unless they are equal.
8. Composite only the affected destination rectangle.

The base/root layer may remain offscreen full-frame initially. That is not the performance problem. Once child layers and filters are truly bounded, revisit direct-to-backbuffer.

## Data Model to Introduce

The names below are suggestions. Use names consistent with the existing codebase.

```cpp
struct GeometryRecord {
    bgfx::VertexBufferHandle vb;
    bgfx::IndexBufferHandle ib;
    uint32_t index_count;
    LogicalRect local_bounds;
};

struct RecordedDrawCommand {
    enum class Kind { Geometry, Shader, ClipMask };
    Kind kind;
    Rml::CompiledGeometryHandle geometry;
    Rml::TextureHandle texture;
    Rml::CompiledShaderHandle shader;
    Rml::Vector2f translation;
    ScissorState scissor;
    bool transform_valid;
    std::array<float, 16> transform;
    Rml::ClipMaskOperation clip_operation;
};

struct LayerRecord {
    bgfx::FrameBufferHandle framebuffer;
    bgfx::TextureHandle color;
    bgfx::TextureHandle depth_stencil;

    RenderBounds allocation_bounds;
    FbRect valid_content_bounds;
    FbRect conservative_clip_bounds;

    bool materialized;
    bool recording;
    bool requires_full_frame;
    const char* full_frame_reason;

    std::vector<RecordedDrawCommand> commands;
};
```

`allocation_bounds` is the actual texture bounds. `valid_content_bounds` is the affected content region inside global framebuffer coordinates. They are not always the same. Filters expand output bounds. Clips may reduce effective content. Transforms may expand geometry AABBs.

## Phase 0: Make the Bad Baseline Unmistakable

Goal: ensure future agents cannot declare the renderer optimized while it still behaves like the current baseline.

Required changes:

- Update perf logging to print these additional fields:
  - `full_frame_postprocess_target_uses`
  - `bounded_postprocess_target_uses`
  - `full_frame_child_layers`
  - `max_child_layer`
  - `max_child_rt`
  - `unbounded_no_scissor_fallbacks`
  - `unbounded_transform_fallbacks`
  - `unbounded_inverse_clip_fallbacks`
  - `full_frame_clear_passes`
  - `full_frame_composite_passes`
  - `full_frame_postprocess_passes`
- Do not rely on allocation counters to detect full-frame reuse. Count target/layer/pass uses each frame.
- Update `scripts/web-smoke.mjs` to parse every emitted field it gates.
- Change `scripts/web-smoke-thresholds.json` so the current baseline fails.
- Store current bad baseline values in this document or a separate archive note, not as passing thresholds.

Acceptance criteria:

- The current readback gallery fails the structural web-smoke gate before optimization work begins.
- The failure message identifies `full_layers`, `unbounded_layer_fallbacks`, `full_frame_passes`, `max_layer`, `max_rt`, `post_px`, and/or `composite_px` directly.
- Linux readback correctness tests still pass.
- The log distinguishes base/root full-frame work from child layer full-frame work.

Do not proceed to implementation phases until this diagnostic gate is in place.

## Phase 1: Geometry and Shader Bounds

Goal: give the renderer enough data to compute content bounds without relying on scissor.

Required changes:

- Extend `GeometryRecord` to store a CPU-side local-space AABB computed from compiled vertices.
- Add tests for geometry AABB calculation, including empty/invalid geometry rejection.
- Add a helper to convert a geometry local AABB plus translation plus optional transform into a conservative logical/framebuffer AABB.
- Support normal affine transforms by transforming all four rectangle corners and taking the enclosing AABB.
- Treat non-finite coordinates, impossible transforms, or invalid output as explicit fallback reasons.
- Account for DPR using the existing `logical_to_framebuffer()` outward rounding rules.
- Ensure `RenderShader()` uses the same geometry bounds as `RenderGeometry()`.

Acceptance criteria:

- A 24x36 filtered element can produce a 24x36-ish framebuffer bound before filter expansion.
- A rotated rectangle produces a conservative AABB, not full-frame fallback.
- Tests cover identity transform, translation, scaling, rotation, negative coordinates, offscreen clipping, and non-integer DPR.
- No rendering behavior changes are required yet, but optional debug logging can show candidate bounds.

## Phase 2: Virtual Child Layer Recording

Goal: stop allocating child framebuffer textures at `PushLayer()` when bounds are unknown.

Required changes:

- Split layers into root/base layers and child virtual layers.
- `PushLayer()` for child layers should create a logical layer record and begin recording commands, not immediately allocate a bgfx framebuffer unless a safe bound is already known and eager materialization is explicitly selected.
- `RenderGeometry()`, `RenderShader()`, and `RenderToClipMask()` should record commands when the active layer is virtual.
- Each recorded command must capture the render state needed for faithful replay:
  - geometry handle
  - shader handle or texture handle
  - translation
  - active scissor
  - active transform
  - active clip-mask operation and stencil transition metadata
  - blend-relevant state if needed
- Base/root geometry may continue to render immediately to the root target for now.
- Layer stack semantics must remain identical from RmlUi's point of view.

Acceptance criteria:

- The readback gallery still renders correctly after recording/replay is enabled for child layers.
- Child `PushLayer()` no longer increments full-frame layer allocation just because no scissor exists.
- Tests cover nested layer recording order.
- Tests cover that command replay preserves geometry order around clip-mask commands.
- No WebGL feedback-loop errors appear.

Implementation note, 2026-06-21:

- Child layers now start as virtual records. `PushLayer()` creates logical layer metadata, captures push-time scissor/transform state, stores provisional non-GPU bounds for nested-layer inheritance, and does not call `ensure_layer()` or clear a child framebuffer.
- Geometry, gradient shader, and clip-mask operations record their handles plus scissor, transform, clip-mask enable, and stencil-reference state when the active layer is virtual.
- `CompositeLayers()`, `SaveLayerAsTexture()`, and `SaveLayerAsMaskImage()` materialize virtual layers on demand, clear the materialized target once, replay inherited clip masks, then replay recorded commands in order.
- Nested virtual layers need the provisional parent bounds. Without that, saved `mask-image` layers can collapse to the conservative 1x1 fallback before Phase 3 content bounds exist.
- Reused virtual layer slots must destroy any previous-frame materialized framebuffer before replacing the slot with a new virtual record. Otherwise the gallery can render correctly for a few frames, then exhaust bgfx framebuffer resources and go blank.
- This phase deliberately does not make child layer work proportional to content yet. Materialization still uses the old scissor/provisional selection policy, so the strict web-smoke structural gate is expected to keep failing until Phase 3/4 replace provisional bounds with accumulated content bounds and bounded allocation.

## Phase 3: Layer Content Bounds Accumulation

Goal: compute conservative content bounds for virtual layers from their recorded commands.

Required changes:

- Accumulate a `valid_content_bounds` rectangle for each virtual layer.
- For geometry and shader commands, union the transformed geometry AABB with the layer content bounds.
- Intersect draw bounds with active scissor when scissor is enabled.
- Track clip bounds conservatively:
  - `Set`: future content can be bounded by the clip geometry AABB.
  - `Intersect`: future content can be intersected with the clip geometry AABB.
  - `SetInverse`: future content is the parent/layer bounds minus geometry; represent as unbounded within parent unless a better region type is added.
- For inverse clips, fall back only to the parent/scissor bounds, not automatically to full framebuffer when a parent/scissor/content bound exists.
- Track distinct fallback reasons. A fallback must say why it happened.

Acceptance criteria:

- For the readback gallery, normal filters, gradients, saved mask content, and transformed clip content produce non-full-frame content bounds.
- `unbounded_layer_fallbacks` drops sharply in the readback gallery. The expected target is zero.
- Any remaining fallback has a named reason in the perf/debug log.
- Tests cover clip `Set`, `Intersect`, and `SetInverse` bound behavior.

## Phase 4: Bounded Layer Materialization and Replay

Goal: allocate child layer framebuffers only after content bounds are known.

Required changes:

- Add `materialize_layer(layer_handle, required_bounds)`.
- Materialization chooses allocation bounds from:
  - accumulated content bounds,
  - active or inherited scissor bounds,
  - parent layer bounds,
  - clip/mask requirements,
  - explicit filter expansion when materializing for filtered composite.
- Allocate the child framebuffer to the final bounded rectangle, not to the surface.
- Use per-layer projection so recorded geometry can remain in global logical coordinates while rendering into a bounded texture.
- Clear only the bounded layer texture.
- Replay commands into the materialized target in original order.
- Rebuild/replay stencil clip state inside the bounded target.
- Preserve WebGL feedback-loop checks.

Acceptance criteria:

- `max_child_layer` for the readback gallery is near the largest panel/effect region, not the framebuffer.
- `full_frame_child_layers = 0` for the readback gallery.
- `unbounded_layer_fallbacks = 0` for the readback gallery.
- `clear_px` is reduced by at least an order of magnitude from the current baseline, excluding the base/root clear.
- Linux readback capture/verify passes.
- Web smoke passes only with strict structural thresholds.

## Phase 4.5: Renderer Architecture Refactor And Reusable Boundary

Goal: preserve Phase 4 bounded behavior while splitting the bgfx renderer into clear ownership boundaries and making the renderer core reusable outside NovelTea before additional optimization work.

Detailed plan: see [`RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md`](RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md). Treat that document as the source of truth for Phase 4.5.

Required changes, summarized:

- Establish a reusable `rmlui_bgfx` core boundary before deeper subsystem extraction. Reusable-core files must not include NovelTea engine headers or directly depend on NovelTea AssetManager, SurfaceMetrics, shader loader, view IDs, SDL3, Lua, ImGui, runtime session, custom components, or editor preview code.
- Introduce generic config/provider inputs for surface metrics, bgfx view range, shader loading, texture loading, diagnostics, and perf logging.
- Move NovelTea-specific behavior into adapter code: surface conversion, AssetManager texture/path resolution, packaged shader lookup, runtime UI view range, and diagnostics output.
- Extract target/resource lifetime into a target cache module. Child layer targets and postprocess targets must be reused at steady state.
- Extract bgfx view/pass scheduling into a pass builder module. All `setViewRect`, `setViewFrameBuffer`, and view naming policy should be centralized.
- Extract low-level draw/composite/copy/stencil submission into a draw context module.
- Extract filter execution into a filter pipeline module using an explicit texture-region boundary.
- Extract virtual layer recording, bounded materialization, replay, saved texture, and saved mask-image handling into a layer system module.
- Keep the generic RmlUi `RenderInterface` adapter as the API adapter rather than the owner of every renderer policy; keep NovelTea integration as host adapter code.
- Add resize/readback regression coverage for the native flicker class found after Phase 4.

Acceptance criteria:

- No intended visual or perf structural change from Phase 4.
- No reusable-core header includes `noveltea/...`.
- No reusable-core source includes NovelTea-only asset, surface, shader, view ID, SDL3, Lua, ImGui, runtime session, custom component, or editor preview headers.
- Linux readback capture/verify passes.
- Full linux-debug test suite passes before merging the complete refactor.
- Web build and web smoke pass.
- Interactive Linux readback gallery remains stable after resize.
- Steady-state readback-gallery perf after warmup keeps `full_frame_child_layers=0`, `full_frame_postprocess_passes=0`, `rt_alloc=0`, `rt_destroy=0`, `layer_alloc=0`, and `layer_destroy=0`.

Do not start Phase 5, Phase 6, pass folding, or physical extraction to a separate repository until the Phase 4.5 in-repo reusable boundary is complete and verified.

## Phase 5: Transform Bounds Without Full-Frame Fallback

Goal: remove transform-driven full-frame fallback for normal CSS transforms.

Required changes:

- Implement conservative transformed AABB for affine 2D transforms.
- Include translation and matrix transform in the correct order matching shader behavior.
- Clip transformed bounds to parent/surface.
- Add debug fallback only for non-finite or unsupported transform cases.
- Ensure transform replay uses the same captured matrix used for bounds.

Acceptance criteria:

- `#transform_clip` in the readback gallery no longer causes a full-frame layer.
- Rotated, scaled, translated, and partially offscreen transformed elements produce bounded layer allocations.
- Visual readback still verifies transformed clipped output and escaped-region rejection.
- Tests cover rotated rectangle bounds and non-integer DPR.

Implementation note, 2026-06-22:

- The normal transform-bound path was already present after Phases 1 through 4.5. Phase 5 hardening added focused tests for shader-order translation-before-transform, negative scale, rotation with non-integer DPR, and zero homogeneous output.
- `PushLayer()` still computes provisional bounds for virtual-layer containment, inherited clips, saved masks, and empty-layer fallback, but final child target materialization uses recorded content bounds from captured per-command transforms.
- The readback gallery's rotated `#transform_clip` fixture keeps `unbounded_transform_fallbacks=0`, `full_frame_child_layers=0`, and `max_child_layer=114x96`; Phase 5 is therefore verified and no longer a blocking optimization phase.

## Phase 6: Filter Pipeline Uses Content Bounds, Not Layer Texture Bounds

Goal: make filter work proportional to filtered content.

Required changes:

- Change `apply_filters()` to accept a source texture plus valid source rect/content bounds distinct from allocation bounds.
- Compute filter output bounds from valid content bounds plus total filter expansion.
- Allocate primary/secondary postprocess targets to output bounds.
- Copy only the valid source rect into the padded work texture.
- Run opacity, color matrix, mask image, blur, and drop shadow over the work texture only.
- Composite the filtered result back to the destination using the output bounds.
- Ensure blur texel steps use work texture dimensions.
- Ensure `u_texCoordBounds` reflects valid source area inside the work texture.
- Ensure drop-shadow expansion accounts for offset and blur radius.

Acceptance criteria:

- A tiny `blur(3px)` element no longer produces a full-frame postprocess target.
- A tiny `drop-shadow(...)` element no longer produces full-frame extract/blur/composite passes.
- Color-only filters do not allocate full-frame targets.
- `max_rt` for the readback gallery is not the framebuffer.
- `post_px` drops by at least an order of magnitude from the current baseline.
- Visual readback remains correct for blur, drop shadow, opacity, color filters, and mask image.

## Phase 7: Saved Texture and Mask-Image Bounds

Goal: make saved layers and mask images use the same content-bound model.

Required changes:

- `SaveLayerAsTexture()` must materialize the current virtual layer if needed and copy only current save/content/scissor bounds.
- `SaveLayerAsMaskImage()` must not copy the entire layer texture by default. It should copy the current content/scissor bounds and store exact mask metadata.
- Saved texture records must store:
  - texture dimensions,
  - global framebuffer bounds,
  - logical bounds,
  - ownership/lifetime,
  - origin needed for later sampling.
- Mask-image filtering must map destination work bounds to saved mask UVs correctly.
- Releasing mask-image filters must destroy owned saved textures exactly once.

Acceptance criteria:

- Saved mask in the readback gallery remains visually correct.
- Saved mask copy pixels are bounded and visible in perf logs.
- Saved mask texture dimensions are near the mask panel size, not the framebuffer.
- Tests cover saved texture metadata and release lifetime.

## Phase 8: Real Structural Web Smoke Gates

Goal: prevent regressions back to full-frame child layers and filters.

Required changes:

- Update `scripts/web-smoke.mjs` to parse the exact perf keys printed by the renderer.
- Gate uses, not just allocations:
  - `full_frame_child_layers`
  - `unbounded_layer_fallbacks`
  - `full_frame_postprocess_passes`
  - `full_frame_composite_passes`
  - `full_frame_clear_passes`
  - `max_child_layer`
  - `max_rt`
  - `post_px`
  - `composite_px`
  - steady-state alloc/destroy churn
- Make thresholds scale with framebuffer size where appropriate.
- Keep FPS as informational only. Do not use FPS as the CI pass/fail gate.
- Add a second web smoke scene for a deliberately large full-screen filter so legitimate full-frame work remains possible and explicit.

Acceptance criteria:

- The current bad baseline fails the new smoke gate.
- The optimized readback gallery passes with strict thresholds.
- A deliberately full-screen filter scene passes only because it is marked and expected as full-frame.
- Console feedback-loop errors fail the gate.

## Phase 9: Pass Count Reduction After Bounds Are Correct

Goal: reduce overhead after pixel area is fixed.

Do not start this phase until full-frame child layers and full-frame postprocess targets are eliminated for the readback gallery.

Required changes:

- Fold `opacity` into final composite when semantically safe.
- Fold simple color matrices into final composite when no blur/mask/shadow ordering requires an intermediate texture.
- Combine consecutive color matrices before GPU work. The current simplifier already does part of this; extend it to composition sites.
- Bypass postprocess entirely for `BlendMode::Replace` with no filters/masks where a direct bounded composite is sufficient.
- Avoid scratch copies for same-layer composition unless source and destination would otherwise create a WebGL feedback loop.
- Reuse geometry passes more aggressively where framebuffer, view rect, scissor, stencil, and shader state allow it.

Acceptance criteria:

- Readback gallery `passes` drops materially from 121.
- Color-only filters no longer produce one postprocess pass per element when a composite shader can apply them.
- No correctness regressions in Linux readback or web smoke.

## Phase 10: Direct Base Presentation Revisited

Goal: make direct-to-backbuffer a real optimization, not a compatibility workaround.

This is intentionally after child-layer optimization. One root clear/final composite is acceptable; dozens of full-frame child passes are not.

Required changes:

- Decide base presentation before rendering using a reliable policy.
- Do not discover `root_requires_preservation` after direct rendering has already started and then fail the frame.
- Either pre-scan/record root operations or keep offscreen root for documents that may require root preservation.
- Remove the need for `--rmlui-base-direct-compat` in normal tests.
- Keep offscreen root available for WebGL or advanced root effects when required.

Acceptance criteria:

- Default Linux readback passes without compat flag.
- Default web readback passes without compat flag.
- Direct base path is enabled only when provably safe.
- Perf logs make base policy explicit but base policy no longer obscures child-layer optimization results.

## Phase 11: Blur Quality and Large-Sigma Strategy

Goal: improve blur correctness and avoid excessive work for larger blur radii.

Required changes:

- Current blur shader samples only seven taps even though CPU code computes wider kernels. Decide whether to implement true variable-radius blur or document the intentional approximation.
- For large sigma, consider downsample/blur/upsample similar to RmlUi GL3's strategy, but adapted to bgfx/WebGL constraints.
- Keep blur work bounded to the filter output region.
- Add visual tests for blur radius behavior.

Acceptance criteria:

- Blur quality is intentionally defined and tested.
- Large blur does not cause full-frame fallback unless the blurred content itself is genuinely full-screen.
- Shader and CPU kernel behavior agree.

## Phase 12: Android and WebGL Runtime Validation

Goal: verify performance architecture on strict platforms.

Required changes:

- Run the strict web smoke in headless Chromium.
- Add an Android emulator smoke if practical, or at least a packaged Android runtime run that captures perf logs.
- Verify no WebGL feedback-loop errors after virtual layer materialization.
- Verify no per-frame render-target allocation churn at steady state.
- Verify bgfx view range is not exhausted by replay/materialization.

Acceptance criteria:

- Linux tests pass.
- Web build passes strict smoke.
- Android build still packages required RmlUi shader assets.
- Android runtime smoke is added or the limitation is documented honestly.

## Phase 13: Documentation and Status Cleanup

Goal: make docs reflect real status.

Required changes:

- Update `docs/rendering/RMLUI_BGFX_STATUS.md` after each milestone.
- Do not mark a phase done unless its strict acceptance criteria pass.
- Keep the current failed baseline visible until the strict gate passes.
- Remove wording that implies the renderer is already a successful bounded compositor while perf logs show full-frame child layers.
- Document any remaining legitimate full-frame fallback cases.

Acceptance criteria:

- Future agents can distinguish implemented plumbing from measured performance success.
- The active status file points to the next failing gate and the next implementation step.
- The optimization plan and smoke thresholds agree.

## Current Progress

As of the current checkout, Phase 0 through Phase 4 are complete and verified on the Linux debug test suite. Phase 1 added CPU-side indexed geometry bounds, transform-bound helpers, DPR-aware framebuffer conversion, and tests for identity, translation, scaling, rotation, negative/offscreen coordinates, non-integer DPR, and invalid/non-finite input. Phase 2 added virtual child-layer recording and on-demand materialization while preserving Linux readback correctness over a longer 40-frame capture so previous-frame layer-resource leaks are caught. Phase 3 added conservative recorded-layer content and mask bounds from recorded geometry/shader/clip-mask commands, and the readback-gallery perf line reports zero unbounded child-layer fallback counters. Phase 4 made materialization consume recorded content bounds plus required filter/composite bounds, replay into bounded targets with local scissor/stencil/copy/composite coordinates, and preserve saved texture/mask correctness.

Representative Linux Phase 4 perf at 1280x720:

```text
[perf] fps=96 passes=108 geom=27 clip=15 gradients=8 layers=13 full_layers=1 bounded_layers=13 full_frame_child_layers=0 bounded_child_layers=13 unbounded_layer_fallbacks=0 unbounded_no_scissor_fallbacks=0 unbounded_transform_fallbacks=0 unbounded_inverse_clip_fallbacks=0 filters=14 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=980004 copy_px=9216 composite_px=985744 post_px=38352 full_frame_passes=2 bounded_passes=55 full_frame_clear_passes=1 bounded_clear_passes=15 full_frame_composite_passes=1 bounded_composite_passes=25 full_frame_postprocess_passes=0 bounded_postprocess_passes=15 full_frame_postprocess_target_uses=0 bounded_postprocess_target_uses=24 full_frame_postprocess_targets=0 bounded_postprocess_targets=12 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1280x720 max_child_layer=114x96 max_child_rt=114x96 max_rt=114x96 fb=1280x720
```

Phase 4.5 is complete: the renderer now has a reusable `rmlui_bgfx` core boundary, NovelTea adapter services, extracted target cache, pass builder, draw context, filter pipeline, layer system, thin adapter cleanup, and resize/readback regression coverage. Resume Phase 5/6 by confirming normal CSS transforms remain bounded across Android and additional Web scenes, then making filters explicitly consume valid content bounds separately from allocation bounds and reduce postprocess pixel work. Do not start Phase 9 pass folding or a physical external repository split until Phase 5/6 semantics are tightened.

## Suggested Work Order for Codex

Use this order. Do not jump to pass folding or direct base presentation before content bounds are solved.

1. Phase 0: fix perf keys and make current web smoke fail structurally.
2. Phase 1: add CPU geometry bounds and transform-bound helpers with tests.
3. Phase 2: introduce virtual child layer recording, initially behind an internal flag if needed.
4. Phase 3: accumulate content/clip/scissor bounds for recorded layers.
5. Phase 4: materialize and replay bounded child layers. Done for Linux and Web readback.
6. Phase 4.5: establish the reusable `rmlui_bgfx` core boundary and refactor renderer structure using [`RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md`](RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md). Done for Linux/Web readback, including resize-readback coverage.
7. Phase 5: remove transform full-frame fallback.
8. Phase 6: make filters use valid content bounds.
9. Phase 7: fix saved texture/mask bounds.
10. Phase 8: tighten web smoke thresholds so the optimized shape is enforced.
11. Phase 9+: reduce pass count and revisit direct base.

Each implementation slice must report before/after perf lines for the readback gallery. The expected early win is not fewer passes; it is lower `full_layers`, lower `full_frame_passes`, lower `max_layer`, lower `max_rt`, lower `clear_px`, lower `composite_px`, and lower `post_px`.

## Prompt for the Next Implementation Session

Use this prompt to begin the next coding session:

```text
We need to resume docs/rendering/RMLUI_BGFX_OPTIMIZATION_PLAN.md after completed Phase 4.5. Phase 0 through Phase 4 of the restarted optimization plan are implemented, and Phase 4.5 has completed the reusable rmlui_bgfx boundary/subsystem split plus resize-readback regression coverage.

Start with Phase 5/6 planning. First verify whether transform-driven fallback is still a real issue in the current readback gallery and whether Phase 5 should be skipped, narrowed, or implemented. Then make the filter pipeline explicitly consume valid content bounds separately from allocation bounds so postprocess pixel work can drop further without changing visual output.

Preserve the Phase 4.5 structure: reusable-core files must remain free of NovelTea-only dependencies, child layer targets and postprocess targets must be reused at steady state, and readback-gallery perf must continue reporting full_frame_child_layers=0, full_frame_postprocess_passes=0, rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 after warmup.

Run linux-debug build, RmlUi readback and resize-readback tests, a 180-frame readback_gallery perf run, web build/smoke, and the reusable-boundary dependency search after each phase slice.
```
