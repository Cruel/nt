# RmlUi bgfx Renderer Refactor Plan

This is Phase 4.5 of [`RMLUI_BGFX_OPTIMIZATION_PLAN.md`](RMLUI_BGFX_OPTIMIZATION_PLAN.md). It is a behavior-preserving architecture refactor inserted after bounded layer materialization and before additional optimization phases.

Status note, 2026-06-23: Phase 4.5 is complete in the current checkout. Keep this document as the historical refactor plan and architectural rationale. For current performance truth and feature-coverage gaps, see [`RMLUI_BGFX_STATUS.md`](RMLUI_BGFX_STATUS.md) and [`RMLUI_RENDER_INTERFACE_AUDIT.md`](RMLUI_RENDER_INTERFACE_AUDIT.md).

Phase 4 proved the important performance direction: child layers and postprocess work can be bounded to affected UI content instead of framebuffer size. It also exposed that the current implementation is too concentrated in `engine/src/ui/rmlui/rmlui_render_interface_bgfx.cpp`. Resource lifetime, pass scheduling, layer recording, materialization, clip/stencil replay, filter execution, copy/composite submission, perf accounting, and RmlUi API adaptation are all interleaved in one file. That made native-only bugs easy to introduce: first child layer framebuffer churn, then postprocess framebuffer churn, and then pointer invalidation in the target cache.

This phase also establishes the renderer as a reusable RmlUi/bgfx backend that NovelTea consumes through adapters. The renderer core should be extractable into a standalone `rmlui-bgfx` project after this refactor. NovelTea-specific surface metrics, asset paths, shader loading, view IDs, SDL input/system glue, Lua integration, custom components, and editor/runtime concepts must stay outside the reusable renderer core.

The purpose of this refactor is to preserve the Phase 4 behavior while making ownership, coordinate-space rules, and the reusable-library boundary explicit enough that Phase 5/6/9 can be implemented safely.

## Current Working Contract

Preserve this contract throughout the refactor:

```text
full_frame_child_layers=0
unbounded_layer_fallbacks=0
unbounded_no_scissor_fallbacks=0
unbounded_transform_fallbacks=0
unbounded_inverse_clip_fallbacks=0
full_frame_passes=2
full_frame_postprocess_passes=0
rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 after warmup
max_child_layer and max_rt near the largest affected effect region, not framebuffer size
```

Representative steady-state Linux/Web readback-gallery perf at 1280x720 after Phase 4 and target-cache fixes:

```text
[perf] fps=96 passes=108 geom=27 clip=15 gradients=8 layers=13 full_layers=1 bounded_layers=13 full_frame_child_layers=0 bounded_child_layers=13 unbounded_layer_fallbacks=0 unbounded_no_scissor_fallbacks=0 unbounded_transform_fallbacks=0 unbounded_inverse_clip_fallbacks=0 filters=14 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=980004 copy_px=9216 composite_px=985744 post_px=38352 full_frame_passes=2 bounded_passes=55 full_frame_clear_passes=1 bounded_clear_passes=15 full_frame_composite_passes=1 bounded_composite_passes=25 full_frame_postprocess_passes=0 bounded_postprocess_passes=15 full_frame_postprocess_target_uses=0 bounded_postprocess_target_uses=24 full_frame_postprocess_targets=0 bounded_postprocess_targets=0 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1280x720 max_child_layer=114x96 max_child_rt=114x96 max_rt=114x96 fb=1280x720
```

Do not use this phase to pursue new perf thresholds. If a change improves counters incidentally, that is fine, but the primary requirement is that the structural contract above does not regress.

## Non-Goals

Do not implement new RmlUi features in this phase.

Do not start pass folding.

Do not change direct-base presentation policy except to preserve existing behavior.

Do not replace the bounded compositor with the upstream GL3 full-frame model. The upstream GL3 backend is much simpler because it can use immediate OpenGL framebuffer binding and full-viewport layer/postprocess targets. This bgfx renderer must keep the bounded model because the measured Web/high-DPI/full-filter baseline is otherwise too expensive.

Do not change shader math, filter visual semantics, premultiplied alpha behavior, clip/mask semantics, saved texture/mask metadata, or WebGL feedback-loop protection.

Do not physically split a new external repository before the in-repository boundary is proven. The first goal is to make the code separable by dependency direction and CMake target shape. The later repository extraction should be mostly mechanical.

## Target Architecture

Split the monolithic bgfx renderer into a reusable core plus NovelTea adapter code, then split the reusable core into five explicit subsystems plus the RmlUi adapter:

```text
NovelTea integration adapter
    SurfaceMetrics conversion
    AssetManager-backed TextureLoader
    packaged shader ShaderProvider
    runtime UI bgfx ViewRange
    diagnostics/perf hook
        |
        v
rmlui_bgfx::RenderInterface        RmlUi API adapter only
BgfxLayerSystem                    layer stack, virtual recording, materialization, saved layers/masks
BgfxTargetCache                    child and postprocess framebuffer ownership/reuse
BgfxPassBuilder                    bgfx view/pass allocation, view rects, clears, framebuffer binding
BgfxFilterPipeline                 filter execution over bounded texture regions
BgfxDrawContext                    low-level draw, composite, copy, gradient, clip/stencil submission
```

The generic adapter should orchestrate calls between these subsystems. It should not own low-level resource lifetime or low-level bgfx view configuration. It also must not include NovelTea headers or know NovelTea asset/shader/view/runtime concepts.

## Proposed Files

During in-repository staging, create a reusable-core area that mirrors the eventual external project:

```text
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_config.hpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_render_interface.hpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_types.hpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_target_cache.hpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_target_cache.cpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_passes.hpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_passes.cpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_draw.hpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_draw.cpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_filters.hpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_filters.cpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_layers.hpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_layers.cpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_bounds.hpp/.cpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_planning.hpp/.cpp
engine/src/ui/rmlui/bgfx_renderer/rmlui_bgfx_pass_scheduler.hpp/.cpp
```

NovelTea-specific adapter files may remain beside the existing UI runtime code:

```text
engine/src/ui/rmlui/rmlui_bgfx_noveltea_adapter.hpp/.cpp
engine/src/ui/rmlui/rmlui_render_interface_bgfx.hpp/.cpp
```

The existing `rmlui_render_bounds`, `rmlui_render_planning`, and `rmlui_render_pass_scheduler` files may be moved or renamed gradually. The important rule is that reusable-core files do not include `noveltea/...` headers.

Do not attempt to land all splits in one giant patch. Use the stages below.

## Stage 0: Establish Reusable-Core Boundary

Goal: make the renderer core separable from NovelTea before deeper subsystem extraction.

Required changes:

- Introduce generic renderer public/private types under a `rmlui_bgfx` namespace:
  - `SurfaceMetrics`
  - `ViewRange`
  - `RendererConfig`
  - `SystemProgram`
  - `ShaderProvider`
  - `TextureLoader`
  - diagnostics/perf callback interface
- Replace direct use of `noveltea::SurfaceMetrics` in reusable renderer code with `rmlui_bgfx::SurfaceMetrics`.
- Replace direct use of `noveltea::assets::AssetManager` in reusable renderer code with `TextureLoader`.
- Replace direct use of `noveltea::bgfx_backend::BgfxShaderLoader`, `SystemShader`, and NovelTea shader paths with `ShaderProvider` and `SystemProgram`.
- Replace direct use of `noveltea::bgfx_backend::ViewRuntimeUIBegin/End` with `RendererConfig::views`.
- Move or wrap current NovelTea behavior in adapter code:
  - NovelTea surface conversion
  - NovelTea AssetManager texture decode/path resolution
  - NovelTea packaged shader lookup
  - NovelTea runtime UI view range
  - NovelTea diagnostics/perf output
- Create a separate in-repo CMake target for the staged reusable renderer core if practical. The engine should link to that target instead of treating the reusable core as ordinary engine-private sources.

Acceptance for Stage 0:

- No reusable-core header includes `noveltea/...`.
- No reusable-core source includes NovelTea AssetManager, SurfaceMetrics, shader loader, view ID, SDL3, Lua, ImGui, runtime session, custom component, or editor preview headers.
- NovelTea still renders the readback gallery through adapter-provided shader, texture, surface, view-range, and diagnostic services.
- Linux readback passes.
- Web smoke passes or any skipped web verification is documented honestly.
- Rendering perf structural counters are unchanged from the Phase 4 baseline except for harmless naming/logging changes.

## Stage 0.5: Shared Types and Coordinate Discipline

After Stage 0 establishes the reusable-core boundary, move shared renderer-private structs into `rmlui_bgfx_types.hpp`.

Move or define:

```cpp
struct GeometryRecord;
struct ShaderRecord;
struct TextureRecord;
struct ScissorState;
struct RecordedDrawCommand;
struct ClipCommand;
struct LayerRecord;
struct RenderTargetRecord;
struct CompositeOp;
struct TextureRegion;
struct FilterApplyResult;
struct PerfCounters;
```

The important new type is `TextureRegion`:

```cpp
struct TextureRegion {
    bgfx::TextureHandle texture = BGFX_INVALID_HANDLE;
    FbRect global_bounds;
    FbRect local_rect;
    int texture_width = 0;
    int texture_height = 0;
};
```

Use `TextureRegion` anywhere code currently passes a texture handle plus several independent bounds and size values. This is especially important for `CompositeLayers()` and filter execution.

Add explicit helper names for coordinate conversion:

```cpp
FbRect local_rect_for_layer(FbRect global_rect, const LayerRecord& layer);
FbRect global_rect_for_layer(FbRect local_rect, const LayerRecord& layer);
FbRect full_local_rect(const LayerRecord& layer);
Rml::Rectanglei rectangle_from_fb(FbRect rect);
```

If possible, use aliases in the private API to document intent:

```cpp
using GlobalFbRect = FbRect;
using LocalFbRect = FbRect;
```

These aliases do not provide compile-time safety by themselves, but they make function signatures and review easier. Avoid APIs that accept multiple unlabeled `FbRect` values without making coordinate space clear in the parameter name.

Acceptance for this step:

- The renderer builds with no behavior changes.
- No public engine headers expose these private bgfx/RmlUi implementation structs.
- All helper names make global-vs-local coordinate intent clear.

## Stage 1: Extract Target Caches

Create `BgfxTargetCache` in `rmlui_bgfx_target_cache.hpp/.cpp`.

Responsibilities:

- Own child layer framebuffer/color/depth-stencil attachments.
- Own postprocess framebuffer/color attachments.
- Reuse child layer targets at steady state.
- Reuse postprocess targets by `{kind, width, height}` at steady state.
- Destroy all resources at shutdown and surface resize.
- Keep returned target pointers/handles stable for the duration of the frame.
- Update allocation/destroy perf counters.

Required API shape:

```cpp
class BgfxTargetCache {
public:
    LayerRecord& prepare_virtual_layer_slot(uint32_t slot);
    bool ensure_layer_target(uint32_t slot, const RenderBounds& bounds);
    LayerRecord* layer(uint32_t slot);

    RenderTargetRecord* acquire_postprocess_target(PostprocessTargetKind kind, FbRect bounds,
                                                   const SurfaceMetrics& surface);

    void destroy_layers();
    void destroy_postprocess_targets();
    void resize(const SurfaceMetrics& surface);
};
```

Exact naming can differ, but the ownership contract must not differ.

Critical rules:

- `PushLayer()` must not destroy the previous frame's materialized child target when reusing the same layer slot. It may reset logical command/state fields, but it must preserve compatible GPU attachments until `ensure_layer_target()` knows whether size changed.
- A same-size child target must produce `layer_alloc=0 layer_destroy=0` after warmup.
- Postprocess targets must not be stored as one resizable target per `PostprocessTargetKind`. That causes repeated destroy/create when the same kind is used for multiple bounded sizes in one frame.
- Postprocess targets must be cached by at least `{kind, width, height}`. Including format/flags in the key is acceptable.
- Do not return pointers into a container that can invalidate them during later target acquisitions in the same frame. `std::deque`, stable indices, or explicit target handles are acceptable. `std::vector<RenderTargetRecord>*` return values are not acceptable unless capacity is fixed before use.
- Surface resize destroys all cached resources and resets the pool/resource metadata.

Acceptance for Stage 1:

- Linux readback passes.
- Web smoke passes.
- Interactive Linux readback gallery remains visually stable after resize.
- Steady-state perf after warmup reports `layer_alloc=0 layer_destroy=0 rt_alloc=0 rt_destroy=0`.
- No bgfx invalid-handle assertions occur in a 180-frame gallery run.

## Stage 2: Extract Pass Builder

Create `BgfxPassBuilder` in `rmlui_bgfx_passes.hpp/.cpp`.

Responsibilities:

- Own `RmlUiRenderPassScheduler` interaction.
- Configure bgfx view names, view modes, view rects, framebuffers, and default clear state.
- Provide typed methods for the renderer's pass categories instead of open-coded `make_pass_request()` calls everywhere.

Required API shape:

```cpp
class BgfxPassBuilder {
public:
    void begin_frame(int framebuffer_width, int framebuffer_height);
    std::optional<RmlUiPass> geometry(bgfx::FrameBufferHandle target, int width, int height);
    std::optional<RmlUiPass> layer_clear(bgfx::FrameBufferHandle target, int width, int height);
    std::optional<RmlUiPass> stencil_clear(bgfx::FrameBufferHandle target, FbRect local_rect);
    std::optional<RmlUiPass> composite(bgfx::FrameBufferHandle target, FbRect destination_rect,
                                       RmlUiPassKind kind, const char* name);
    std::optional<RmlUiPass> copy(bgfx::FrameBufferHandle target, int width, int height,
                                  const char* name);
    std::optional<RmlUiPass> postprocess(bgfx::FrameBufferHandle target, int width, int height,
                                         const char* name);
    bool exhausted() const;
};
```

Critical rules:

- All bgfx view setup must go through this class.
- `setViewRect()` coordinate choices must be centralized. This avoids repeating the native GL/WebGL ambiguity around local target coordinates and sub-rect view coordinates.
- The pass builder must keep `bgfx::ViewMode::Sequential` unless a later explicit pass-folding phase changes it.
- Existing pass counter behavior must be preserved.

Acceptance for Stage 2:

- Linux readback passes.
- Web smoke passes.
- Perf pass counts remain explainable and do not regress structurally.
- No direct `bgfx::setViewRect`, `bgfx::setViewFrameBuffer`, or `bgfx::setViewName` calls remain outside the pass builder, except unrelated renderer initialization if needed.

## Stage 3: Extract Draw Context

Create `BgfxDrawContext` in `rmlui_bgfx_draw.hpp/.cpp`.

Responsibilities:

- Submit ordinary geometry.
- Submit gradients/shader geometry.
- Composite texture regions into a destination framebuffer.
- Copy texture regions to framebuffer or texture.
- Clear color/stencil for a target.
- Submit clip-mask geometry and stencil normalization passes.

Move these routines or their equivalents:

```cpp
submit()
submit_gradient()
composite()
copy_region_to_framebuffer()
copy_region_to_texture()
clear_active_stencil()
normalize_stencil_if_needed()
submit_to_clip_mask()
```

Required API direction:

```cpp
class BgfxDrawContext {
public:
    void submit_geometry(const GeometryRecord& geometry, const LayerRecord& layer,
                         const DrawState& state);
    void submit_gradient(const ShaderRecord& shader, const GeometryRecord& geometry,
                         const LayerRecord& layer, const DrawState& state);
    bool composite(TextureRegion source, bgfx::FrameBufferHandle destination,
                   FbRect local_destination_rect, CompositeState state);
    bgfx::TextureHandle copy_to_texture(bgfx::TextureHandle source, FbRect local_source_rect,
                                        int source_width, int source_height, const char* name);
};
```

`DrawState` and `CompositeState` can be simple structs containing scissor, transform, texture, blend mode, stencil flag/ref, and pass kind/name.

Critical rules:

- The draw context may set uniforms, textures, vertex buffers, index buffers, stencil state, and submit bgfx work.
- The draw context must not decide when layers materialize.
- The draw context must not own target caches.
- The draw context must not know RmlUi layer stack policy.
- Bgfx's per-draw state invariant must remain respected: validate early before setting per-draw state when a path can return without submit.

Acceptance for Stage 3:

- `BgfxRenderInterface::RenderGeometry()` and `RenderShader()` become thin record-or-submit methods.
- Low-level bgfx submission details are not scattered across layer/filter/composite policy code.
- Linux readback and web smoke pass.

## Stage 4: Extract Filter Pipeline

Create `BgfxFilterPipeline` in `rmlui_bgfx_filters.hpp/.cpp`.

Responsibilities:

- Resolve compiled filter handles to filter records.
- Simplify filter chains.
- Compute total filter expansion.
- Apply opacity, color matrix, mask image, blur, and drop shadow to a bounded `TextureRegion`.
- Acquire postprocess targets through `BgfxTargetCache`.
- Submit filter passes through `BgfxDrawContext` and `BgfxPassBuilder`.

Target API:

```cpp
class BgfxFilterPipeline {
public:
    std::vector<FilterRecord> resolve(Rml::Span<const Rml::CompiledFilterHandle> handles) const;
    FilterExpansion expansion_for(Rml::Span<const Rml::CompiledFilterHandle> handles) const;
    TextureRegion apply(TextureRegion source,
                        Rml::Span<const Rml::CompiledFilterHandle> handles);
};
```

Critical rules:

- Filter input and output must use `TextureRegion`.
- The pipeline must never infer source texture dimensions from global framebuffer bounds.
- The pipeline must preserve saved `mask-image` metadata and sampling behavior.
- The pipeline must retain WebGL feedback-loop protection by never sampling from a texture attached to the active destination framebuffer.
- The pipeline must preserve premultiplied color matrix behavior.
- The pipeline must continue to run bounded, with `full_frame_postprocess_passes=0` for the readback gallery.
- Postprocess target reuse must remain steady-state zero allocation/destroy after warmup.

Acceptance for Stage 4:

- `CompositeLayers()` no longer manually coordinates the internals of filter execution.
- Filter execution is readable as a sequence of bounded `TextureRegion` transformations.
- Linux readback and web smoke pass.
- The readback gallery's blur, drop shadow, opacity/color filters, saved texture, and saved mask-image panels remain visually correct.

## Stage 5: Extract Layer System

Create `BgfxLayerSystem` in `rmlui_bgfx_layers.hpp/.cpp`.

Responsibilities:

- Own active layer handle and layer stack.
- Own virtual layer recording state.
- Record geometry/shader/clip-mask commands while a child layer is virtual.
- Accumulate content and conservative mask bounds.
- Choose materialized bounds from content, parent/provisional limits, scissor, mask, and explicit required bounds.
- Materialize layers through `BgfxTargetCache`.
- Replay recorded commands through `BgfxDrawContext`.
- Preserve saved texture and saved mask-image bounds metadata.
- Restore active scissor/transform/clip state after replay.

Target API direction:

```cpp
class BgfxLayerSystem {
public:
    void begin_frame();
    Rml::LayerHandle push_layer(const RenderState& current_state);
    void pop_layer();

    bool active_layer_is_recording() const;
    void record_geometry(...);
    void record_shader(...);
    void record_clip_mask(...);

    TextureRegion materialize_source(Rml::LayerHandle source,
                                      Rml::Span<const Rml::CompiledFilterHandle> filters);
    LayerRecord* materialize_destination(Rml::LayerHandle destination,
                                         FbRect required_global_bounds);

    Rml::TextureHandle save_layer_as_texture(...);
    Rml::CompiledFilterHandle save_layer_as_mask_image(...);
};
```

Critical rules:

- `PushLayer()` should become allocation-free in the normal child path.
- `materialize_source()` should be the only path that turns a virtual source layer into a texture for composite/filter/save consumers.
- `materialize_destination()` should union required composite output bounds with any destination content bounds before allocation.
- Saved texture copies must convert global save bounds to local layer texture coordinates.
- Saved mask copies must keep saved mask bounds in global framebuffer coordinates.
- Clip/stencil replay must run inside the bounded target using local work rects.
- The final clip-mask enabled/ref state must match pre-materialization logical state after inherited clip replay and recorded command replay.

Acceptance for Stage 5:

- `BgfxRenderInterface::PushLayer()`, `PopLayer()`, `CompositeLayers()`, `SaveLayerAsTexture()`, and `SaveLayerAsMaskImage()` are adapter-level functions, not large implementations.
- Bounded materialization behavior is unchanged.
- Linux readback and web smoke pass.
- Interactive Linux resize remains stable.

## Stage 6: Thin RmlUi Adapter Cleanup

After the subsystems exist, reduce `rmlui_render_interface_bgfx.cpp` to the RmlUi-facing adapter plus initialization/shutdown.

It should retain:

- Constructor/destructor.
- bgfx program/uniform/texture initialization and shutdown, unless those are moved into a dedicated context object.
- `CompileGeometry`, `RenderGeometry`, `ReleaseGeometry` as thin wrappers.
- `CompileShader`, `RenderShader`, `ReleaseShader` as thin wrappers.
- `LoadTexture`, `GenerateTexture`, `ReleaseTexture` as thin wrappers around texture storage.
- `EnableScissorRegion`, `SetScissorRegion`, `SetTransform`, `EnableClipMask`, and `RenderToClipMask` as state updates or delegation calls.
- Layer/filter methods as delegation calls.
- Perf logging orchestration.

It should no longer directly contain:

- Long target creation/destroy logic.
- Postprocess ping-pong implementation.
- Layer materialization/replay implementation.
- Low-level composite/copy draw routines.
- Bgfx view setup logic.

Acceptance for Stage 6:

- `rmlui_render_interface_bgfx.cpp` is substantially smaller and reads like an adapter.
- Each subsystem has one clear ownership responsibility.
- No behavior or perf structural regression.

## Stage 7: Resize and Flicker Regression Coverage

The current readback test verifies a steady frame at one size. It did not catch the native resize flicker. Add an explicit regression path.

Preferred option: add a sandbox/readback mode that can run a resize sequence before capture:

```text
--resize-sequence 1280x720,1423x1869,1280x720
--readback-after-resize-frames 3
```

Alternative: add a dedicated test utility that drives `BgfxRenderInterface::resize()` and RmlUi update/render for several sizes before readback.

Minimum sequence:

```text
frame 1: 1280x720
frame 2: 1423x1869
frames 3-10: 1423x1869 steady
capture and verify
```

Acceptance:

- Linux readback after resize passes.
- The captured image includes the blur/drop-shadow/filter panels that previously flickered.
- Steady-state perf after resize still reports `rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0` after warmup.
- Web smoke remains green.

## Stage 8: Documentation Update

After the refactor lands, update:

```text
docs/rendering/RMLUI_BGFX_OPTIMIZATION_PLAN.md
docs/rendering/RMLUI_BGFX_STATUS.md
docs/migration/STATUS.md
```

Document:

- New reusable-core boundary and NovelTea adapter responsibilities.
- New subsystem responsibilities.
- The current steady-state perf line.
- Verification commands run.
- Any remaining reasons Phase 5/6 is still needed.

Do not mark Phase 5/6/9 complete as part of this refactor unless those phases' separate acceptance criteria are explicitly implemented and verified.

## Required Verification After Every Stage

Run the narrow checks after each stage:

```sh
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug -R readback
./build/linux-debug/apps/sandbox/noveltea-sandbox --demo none --rmlui-document project:/rmlui/readback_gallery.rml --frames 180 --no-imgui --render-perf
node scripts/web-smoke.mjs
```

Run the full checks before merging the full Phase 4.5 refactor:

```sh
clang-format --dry-run --Werror engine/src/ui/rmlui/*.cpp engine/src/ui/rmlui/*.hpp
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug
cmake --build --preset web-debug
node scripts/web-smoke.mjs
```

If the environment blocks the `format-check` target, use `clang-format --dry-run --Werror` directly on changed C++ files.

For reusable-boundary changes, also verify with search or include checks that reusable-core files do not include `noveltea/...`, SDL3, Lua, ImGui, runtime session, custom component, or editor preview headers.

## Hard Stop Conditions

Stop and fix before continuing if any of these occur:

- Native bgfx reports invalid framebuffer or texture handles.
- The readback gallery visually flickers after resize.
- `full_frame_child_layers` becomes non-zero for the readback gallery.
- `full_frame_postprocess_passes` becomes non-zero for the readback gallery.
- `rt_alloc`, `rt_destroy`, `layer_alloc`, or `layer_destroy` remains non-zero after warmup.
- Web smoke passes but Linux interactive output is visibly wrong. Web success alone is not sufficient.
- A reusable-core file includes NovelTea engine headers or directly depends on NovelTea AssetManager, SurfaceMetrics, shader loader, view IDs, SDL3, Lua, ImGui, runtime session, custom components, or editor preview code.
- A new module needs to reach back into `BgfxRenderInterface::Impl` internals to do its job. That means the boundary is wrong.

## Suggested Implementation Order

Use this exact order:

0. Establish the reusable-core boundary: generic config/provider interfaces, NovelTea adapter, no NovelTea headers in reusable-core files, and an in-repo reusable renderer target if practical.
1. Add `rmlui_bgfx_types.hpp` and move passive structs/helper aliases only.
2. Extract `BgfxTargetCache` and preserve current target reuse behavior.
3. Extract `BgfxPassBuilder` and centralize bgfx view setup.
4. Extract `BgfxDrawContext` and move low-level submit/copy/composite/stencil calls.
5. Extract `BgfxFilterPipeline` using `TextureRegion` as the filter boundary.
6. Extract `BgfxLayerSystem` and move virtual recording/materialization/replay.
7. Reduce `rmlui_render_interface_bgfx.cpp` to the adapter role or remove it in favor of `rmlui_bgfx::RenderInterface` plus the NovelTea adapter.
8. Add resize/readback regression coverage.
9. Update status docs and only then resume Phase 5/6 optimization planning.

Each step must be independently buildable and should preserve the current perf shape. The physical split to a separate external repository should happen only after the in-repo reusable target has passed Linux readback, web smoke, and dependency-boundary checks.

## Prompt for the Next Coding Session

```text
Phase 4.5 from docs/rendering/RMLUI_BGFX_RENDERER_REFACTOR_PLAN.md is complete. The renderer has a reusable rmlui_bgfx core boundary, NovelTea adapter services, extracted target cache, pass builder, draw context, filter pipeline, layer system, thin adapter cleanup, and resize/readback regression coverage.

Resume docs/rendering/RMLUI_BGFX_OPTIMIZATION_PLAN.md at Phase 5/6. First verify whether transform-driven full-frame fallback is still a real issue in the current gallery and narrow or skip Phase 5 if the current implementation already satisfies its acceptance criteria. Then implement Phase 6's explicit split between allocation bounds and valid content bounds in the filter pipeline.

Preserve the Phase 4.5 contracts: reusable-core files must not include NovelTea-only dependencies, readback and resize-readback must pass, web smoke must pass, and steady-state perf must keep full_frame_child_layers=0, full_frame_postprocess_passes=0, rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 after warmup.
```
