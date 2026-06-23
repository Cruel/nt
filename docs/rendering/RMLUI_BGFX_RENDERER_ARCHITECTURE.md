# RmlUi bgfx Renderer Architecture

This document describes the intended end-state architecture of the reusable RmlUi bgfx renderer used by NovelTea. It is written as an architecture overview for future developers and as the reference target during the Phase 4.5 renderer refactor.

This is not a status report. If the implementation is still mid-refactor, use this document as the desired shape. If the final implementation intentionally differs from this document, update the document in the same change that changes the architecture. For method-by-method RmlUi render-interface coverage, see [`RMLUI_RENDER_INTERFACE_AUDIT.md`](RMLUI_RENDER_INTERFACE_AUDIT.md). For user-provided shaders/materials and the RmlUi `shader(<string>)` material bridge, see [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md).

The desired end state is a renderer that can live in a separate `rmlui-bgfx` project. NovelTea should consume it through a small integration adapter. The renderer core should not require NovelTea engine headers, NovelTea asset namespaces, SDL3, Lua, ImGui, custom NovelTea UI components, or NovelTea runtime concepts.

## Purpose

The RmlUi bgfx renderer implements RmlUi's advanced rendering interface on top of bgfx while preserving correctness for clipping, masks, transforms, gradients, filters, saved layers, saved mask images, premultiplied alpha, high-DPI framebuffers, WebGL feedback-loop rules, and cross-platform bgfx backend behavior. NovelTea is one integration target, not an architectural dependency of the renderer core.

The renderer is a content-bounded compositor. Child layers and filter work are bounded to the affected UI content rather than to the full framebuffer whenever the content itself is not full-screen. This is the central performance property of the renderer and must not be regressed.

The upstream RmlUi GL3 and DX12 backends are semantic references for expected rendering behavior, filter ordering, clip behavior, shader behavior, and premultiplied color math. They are not the architectural model for this renderer. The GL3 backend is simpler largely because it can use immediate OpenGL state changes and full-viewport layer/postprocess targets. The bgfx renderer deliberately keeps a more explicit bounded architecture because high-DPI WebGL and mobile targets cannot afford many full-frame layer, clear, composite, and postprocess passes for small UI effects.

## Reusable Library Boundary

The renderer core is intended to be extractable into a standalone `rmlui-bgfx` library. During Phase 4.5, the first architecture step is to make this boundary explicit inside the current repository before moving files to a separate repository.

The reusable core may depend on:

```text
RmlUi Core
bgfx
bx
bimg or a pluggable image decoder, if texture loading remains bundled
standard C++
```

The reusable core must not depend on:

```text
NovelTea engine headers
NovelTea AssetManager or project:/system:/cache: asset namespaces
NovelTea SurfaceMetrics
NovelTea bgfx view ID constants
NovelTea shader loader or SystemShader enum
SDL3 platform/input/windowing code
RmlUi Lua integration
Dear ImGui/debug UI
NovelTea custom RmlUi components, runtime session, scripting, or editor preview code
```

Integration-specific concerns enter through narrow public configuration and provider interfaces:

```cpp
namespace rmlui_bgfx {

struct SurfaceMetrics {
    int logical_width = 0;
    int logical_height = 0;
    int framebuffer_width = 0;
    int framebuffer_height = 0;
    float scale_x = 1.0f;
    float scale_y = 1.0f;
};

struct ViewRange {
    bgfx::ViewId begin = 0;
    bgfx::ViewId end = 0;
};

enum class SystemProgram {
    RmlUi,
    Composite,
    Copy,
    Opacity,
    ColorMatrix,
    MaskMultiply,
    Blur,
    DropShadow,
    Gradient,
};

class ShaderProvider {
public:
    virtual ~ShaderProvider() = default;
    virtual bgfx::ProgramHandle load_program(SystemProgram program) = 0;
};

struct LoadedTexture {
    int width = 0;
    int height = 0;
    const std::byte* rgba8 = nullptr;
    size_t size = 0;
};

class TextureLoader {
public:
    virtual ~TextureLoader() = default;
    virtual bool load_rgba(const char* source, LoadedTexture& out) = 0;
};

class Diagnostics {
public:
    virtual ~Diagnostics() = default;
    virtual void warning(const char* message) = 0;
    virtual void error(const char* message) = 0;
};

struct RendererConfig {
    SurfaceMetrics surface;
    ViewRange views;
    ShaderProvider* shaders = nullptr;
    TextureLoader* textures = nullptr;
    Diagnostics* diagnostics = nullptr;
    bool enable_perf_logging = false;
};

} // namespace rmlui_bgfx
```

Exact names can change during implementation, but the dependency direction cannot: NovelTea adapts to the renderer, not the renderer to NovelTea. NovelTea should provide a `ShaderProvider`, a `TextureLoader`, a surface conversion helper, a view range, and diagnostics/perf-log hooks.

The standalone library may include optional convenience integrations later, such as a filesystem texture loader or CMake shader compilation helpers, but the core renderer must remain usable by other engines with their own asset systems, material systems, and bgfx view layouts. If generic RmlUi `shader(<string>)` support is added, the reusable core should expose a provider seam for decorator-material submission while NovelTea owns project/game schema shader and material records, material registry lookup, inferred shader variant selection, shader-binary assets, and editor/package compilation policy.

## Non-Negotiable Renderer Contract

For small filtered and masked UI content such as `project:/rmlui/readback_gallery.rml`, the steady-state renderer contract is:

```text
full_frame_child_layers=0
unbounded_layer_fallbacks=0
unbounded_no_scissor_fallbacks=0
unbounded_transform_fallbacks=0
unbounded_inverse_clip_fallbacks=0
full_frame_postprocess_passes=0
rt_alloc=0 rt_destroy=0 after warmup
layer_alloc=0 layer_destroy=0 after warmup
max_child_layer and max_rt are near the largest affected effect region, not framebuffer size
```

One full-frame root layer and one final root composite may be legitimate when the root presentation policy selects an offscreen base layer. Full-frame work is also legitimate when the actual UI content or effect region is full-screen. Any other full-frame fallback must have a named reason and should be treated as a performance or correctness bug until proven otherwise.

Correctness has priority over performance. Do not remove clips, masks, filters, transforms, WebGL feedback-loop protection, premultiplied alpha handling, or saved texture metadata to improve counters.

## High-Level Components

The renderer is split into a small RmlUi-facing adapter plus focused internal subsystems. The reusable library owns the renderer core. NovelTea owns only the integration providers and surrounding RmlUi runtime glue.

```text
NovelTea engine or another host application
        |
        +-- host ShaderProvider / TextureLoader / Diagnostics / ViewRange
        |
        v
rmlui-bgfx reusable library
        |
        +-- rmlui_bgfx::RenderInterface : Rml::RenderInterface
        |       +-- RmlUi API adapter and subsystem orchestration
        |
        +-- BgfxLayerSystem
        |       +-- virtual child layer recording
        |       +-- conservative content/mask bounds
        |       +-- bounded materialization/replay
        |       +-- saved texture and mask-image metadata
        |
        +-- BgfxFilterRegistry
        |       +-- compiled filter lifetime and lookup
        |
        +-- BgfxFilterPipeline
        |       +-- bounded TextureRegion filter transforms
        |       +-- blur, drop-shadow, opacity, color matrix, mask image
        |
        +-- BgfxTargetCache
        |       +-- child layer framebuffer/texture reuse
        |       +-- postprocess framebuffer/texture reuse
        |
        +-- BgfxPassBuilder
        |       +-- bgfx view allocation and configuration
        |
        +-- BgfxDrawContext
        |       +-- low-level bgfx submissions
        |       +-- geometry, gradients, clip masks, copy, composite
        |
        +-- Geometry/Texture/Shader storage
                +-- compiled RmlUi resources and bgfx handles
```

`rmlui_bgfx::RenderInterface` owns and wires these subsystems. It remains the only public RmlUi render interface implementation in the reusable library, but it does not directly contain large layer, filter, target-cache, or view-setup logic.

## File Layout

The final reusable project should have a layout similar to:

```text
include/rmlui_bgfx/render_interface.hpp      public RmlUi RenderInterface implementation
include/rmlui_bgfx/config.hpp                public config, surface, view range, provider interfaces
include/rmlui_bgfx/diagnostics.hpp           optional perf/log callback interfaces
src/rmlui_bgfx_types.hpp                     private renderer data types and aliases
src/rmlui_bgfx_target_cache.hpp/.cpp         framebuffer/texture target ownership and reuse
src/rmlui_bgfx_passes.hpp/.cpp               bgfx pass/view construction
src/rmlui_bgfx_draw.hpp/.cpp                 low-level bgfx draw/copy/composite/stencil submission
src/rmlui_bgfx_filters.hpp/.cpp              filter registry and bounded filter pipeline
src/rmlui_bgfx_layers.hpp/.cpp               layer stack, recording, bounds, materialization, replay
src/rmlui_bgfx_bounds.hpp/.cpp               geometry/filter/bounds math helpers
src/rmlui_bgfx_planning.hpp/.cpp             small pure planning helpers
src/rmlui_bgfx_pass_scheduler.hpp/.cpp       low-level reusable view-id scheduler
shaders/bgfx/*                               backend shader sources and varying definitions
cmake/*                                      optional shader compilation/package helpers
```

While the code still lives inside `Cruel/nt`, use an in-repository staging layout that mirrors the eventual library boundary:

```text
engine/src/ui/rmlui/bgfx_renderer/           reusable renderer core, no NovelTea headers
engine/src/ui/rmlui/rmlui_render_interface_bgfx.hpp/.cpp
                                             temporary forwarding/adapter files, or removed after engine adoption
engine/src/ui/rmlui/rmlui_bgfx_noveltea_adapter.*
                                             NovelTea ShaderProvider, TextureLoader, SurfaceMetrics conversion,
                                             and view range configuration
```

The exact paths can differ, but the dependency direction is mandatory: files in the reusable core may include RmlUi and bgfx headers, but must not include `noveltea/...` headers. NovelTea-specific adapters may include both NovelTea headers and the reusable renderer public headers.

No public engine header exposes renderer-private bgfx/RmlUi implementation records. Renderer-private headers may include bgfx and RmlUi types because they are internal to the RmlUi/bgfx implementation boundary.

## Core Data Concepts

### GeometryRecord

`GeometryRecord` owns the bgfx vertex/index buffers for compiled RmlUi geometry and stores a CPU-side local-space axis-aligned bounding box. The CPU bounds are required for virtual layer content-bounds accumulation.

Geometry bounds are computed at compile time from indexed vertices. During recording, local bounds plus translation plus optional transform are converted to conservative framebuffer bounds. Normal affine transforms are handled by transforming the four AABB corners and taking the enclosing rectangle. Invalid, non-finite, or unsupported transforms produce explicit fallback reasons.

### TextureRecord

`TextureRecord` owns or references bgfx textures created for RmlUi images, saved layers, and saved mask images. It stores texture dimensions and, when relevant, the global framebuffer bounds represented by the texture. Saved texture and saved mask-image records must preserve enough origin and bounds metadata for later sampling to be correct.

### TextureRegion

`TextureRegion` is the boundary type for copy, composite, and filter operations.

```cpp
struct TextureRegion {
    bgfx::TextureHandle texture = BGFX_INVALID_HANDLE;
    GlobalFbRect global_bounds;
    LocalFbRect local_rect;
    int texture_width = 0;
    int texture_height = 0;
};
```

A texture handle without bounds is not enough. Filter and composite code must know what global area the texture represents, what sub-rectangle inside the texture is valid, and how large the backing texture is. `TextureRegion` prevents bugs where code accidentally treats a bounded texture as if it represented the full framebuffer.

### LayerRecord

`LayerRecord` is owned by `BgfxLayerSystem`, not by the target cache. It stores layer-stack policy and logical layer state:

```text
layer kind: root or virtual child
parent layer handle
recording/materialized flags
recorded geometry/shader/clip commands
current and inherited clip state
conservative content bounds
conservative mask bounds
saved texture/mask metadata
pointer or handle to a materialized target when one exists
```

A virtual child layer begins without GPU attachments. It records commands and accumulates conservative bounds. It materializes only when a later operation needs the layer as a texture.

### Target Records

Target records are owned by `BgfxTargetCache`. They contain bgfx resource ownership only:

```text
framebuffer handle
color texture handle
depth/stencil texture handle when needed
width and height
format and creation flags
cache key and lifetime metadata
```

The target cache does not own `LayerRecord` and does not decide layer policy. It answers resource requests from the layer system and filter pipeline.

## Coordinate Spaces

The renderer uses explicit coordinate names in private APIs:

```cpp
using GlobalFbRect = FbRect;
using LocalFbRect = FbRect;
```

The aliases do not create compile-time type safety, so function names and parameter names must still identify the coordinate space.

Important spaces:

```text
Rml logical coordinates       CSS/RmlUi layout units in the context coordinate system.
Global framebuffer rect       Physical framebuffer pixels relative to the top-left framebuffer origin.
Local target rect             Physical pixels relative to the current bounded framebuffer/texture.
Texture UV coordinates        Normalized sampler coordinates for a texture or valid sub-region.
```

Required helpers:

```cpp
LocalFbRect local_rect_for_layer(GlobalFbRect global_rect, const LayerRecord& layer);
GlobalFbRect global_rect_for_layer(LocalFbRect local_rect, const LayerRecord& layer);
LocalFbRect full_local_rect(const LayerRecord& layer);
Rml::Rectanglei rectangle_from_fb(FbRect rect);
```

Offscreen layer and postprocess passes use local target coordinates. A bounded child layer at global framebuffer bounds `{500, 300, 114, 96}` usually renders into a `114x96` texture with local view rect `{0, 0, 114, 96}`. Backbuffer passes use framebuffer coordinates. Global-to-local conversion happens before calling low-level draw and pass APIs for offscreen targets.

Scissor rectangles captured from RmlUi are global framebuffer rectangles. Before submitting work into a bounded layer, they are converted to local target coordinates and intersected with the local target bounds.

## BgfxRenderInterface

`rmlui_bgfx::RenderInterface` is the adapter between RmlUi's `RenderInterface` API and the internal renderer subsystems. In NovelTea, any class still named `BgfxRenderInterface` should become either this generic implementation or a thin compatibility typedef/wrapper around it.

It owns:

```text
renderer configuration copied from RendererConfig
borrowed ShaderProvider, TextureLoader, and Diagnostics interfaces
shader programs and uniforms, unless moved into a dedicated draw resource object
compiled geometry records
texture records
shader records
filter registry
current render state: scissor, transform, clip-mask enabled flag, current stencil reference
layer system
target cache
pass builder
draw context
filter pipeline
perf counters
```

It must not own or include NovelTea asset managers, NovelTea surface types, NovelTea shader enums, SDL windows, or engine runtime objects. Those belong to the host adapter.

Its methods are thin:

```text
CompileGeometry       creates GeometryRecord and CPU bounds
RenderGeometry        records into virtual child layer or delegates immediate draw
ReleaseGeometry       destroys geometry buffers
CompileShader         creates ShaderRecord
RenderShader          records or delegates gradient/custom shader draw
LoadTexture           reads through RmlUi file interface and delegates texture creation
GenerateTexture       creates premultiplied bgfx texture records
ReleaseTexture        releases texture records
EnableScissorRegion   updates adapter render state
SetScissorRegion      updates adapter render state
SetTransform          updates adapter render state
EnableClipMask        updates adapter/layer clip state
RenderToClipMask      records or submits clip-mask draw
PushLayer             delegates to BgfxLayerSystem
PopLayer              delegates to BgfxLayerSystem
CompositeLayers       delegates source materialization, filter pipeline, destination materialization, composite
SaveLayerAsTexture    delegates to BgfxLayerSystem
SaveLayerAsMaskImage  delegates to BgfxLayerSystem and filter registry
BeginFrame/EndFrame   reset frame state, setup root, present root, log perf
```

The adapter does not contain long target creation logic, pass setup logic, filter ping-pong internals, or layer replay internals.

## Host Integration Adapters

NovelTea integrates the reusable renderer through adapter objects. Other engines should be able to provide equivalent adapters without carrying NovelTea code.

Required NovelTea-side adapters:

```text
Surface adapter        converts noveltea::SurfaceMetrics to rmlui_bgfx::SurfaceMetrics
Shader provider        maps rmlui_bgfx::SystemProgram to NovelTea's packaged shader binaries
Texture loader         resolves RmlUi texture paths through NovelTea AssetManager and decodes RGBA8 data
View range config      supplies bgfx view range currently reserved for runtime UI
Diagnostics adapter    routes warnings, failures, and optional perf lines to NovelTea logging/tests
```

NovelTea's RmlUi file interface, SDL3 input translation, system interface, template resolver, Lua integration, and custom runtime components remain NovelTea code. They are not part of the reusable bgfx renderer.

The generic renderer may provide a default filesystem texture loader later, but `project:/rmlui/...`, `system:/...`, and packaged NovelTea shader lookup stay in the NovelTea adapter.

## BgfxTargetCache

`BgfxTargetCache` owns reusable bgfx render targets. It has no knowledge of RmlUi layer-stack policy.

Responsibilities:

```text
create child layer targets on demand
reuse same-size child layer targets after warmup
create postprocess targets on demand
reuse postprocess targets by kind, size, format, and flags
keep returned target handles stable for the current frame
destroy all targets on shutdown or surface resize
update allocation/destroy perf counters
```

Postprocess targets are not stored as one mutable target per kind. The same frame may need multiple bounded targets of the same kind with different sizes. The cache key includes at least:

```text
PostprocessTargetKind
width
height
texture format
creation flags
```

The cache uses stable storage such as `std::deque`, stable indices, or explicit target handles. It does not return pointers into a vector that may invalidate during later acquisitions in the same frame.

Surface resize destroys cached targets because the target dimensions and coordinate mappings are no longer reliable. Warmup after resize may allocate resources, but steady-state rendering after warmup should return to zero target allocation and destruction churn.

## BgfxPassBuilder

`BgfxPassBuilder` is the only subsystem that configures bgfx views for RmlUi rendering.

Responsibilities:

```text
begin frame with framebuffer dimensions
allocate or acquire view IDs through RmlUiRenderPassScheduler
set bgfx view name
set bgfx view mode
set bgfx view rect
bind view framebuffer
set default clear state
track pass exhaustion
update pass counters
```

All RmlUi passes use `bgfx::ViewMode::Sequential` unless a later explicit pass-folding phase changes that policy. RmlUi draw order is semantic; accidental view sorting changes can break clipping, compositing, or filter ordering.

No direct calls to these functions should appear outside the pass builder except unrelated renderer initialization or non-RmlUi renderer code:

```cpp
bgfx::setViewName(...);
bgfx::setViewMode(...);
bgfx::setViewRect(...);
bgfx::setViewFrameBuffer(...);
bgfx::setViewClear(...);
```

Pass builder APIs accept already-resolved local target rectangles for offscreen targets. They do not infer coordinate spaces from global rectangles.

## BgfxDrawContext

`BgfxDrawContext` performs low-level bgfx submissions. It does not decide layer policy, filter policy, or target-cache policy.

Responsibilities:

```text
submit ordinary geometry
submit gradient/custom shader geometry
submit clip-mask geometry
clear color or stencil targets
normalize stencil state when required
copy texture regions to framebuffers or textures
composite TextureRegion sources into destination framebuffers
protect against WebGL feedback loops
respect bgfx per-draw state lifetime rules
```

The draw context receives explicit state objects. It does not query mutable adapter state such as current scissor, current transform, active layer, or active filter chain.

Typical inputs:

```cpp
struct DrawState {
    ScissorState scissor;
    bool transform_valid;
    std::array<float, 16> transform;
    Rml::TextureHandle texture;
    bool clip_mask_enabled;
    uint8_t stencil_ref;
};

struct CompositeState {
    Rml::BlendMode blend_mode;
    ScissorState scissor;
    bool apply_destination_stencil;
    uint8_t stencil_ref;
    RmlUiPassKind pass_kind;
    const char* pass_name;
};
```

Bgfx clears per-draw state after `bgfx::submit`. Therefore every draw path validates early, sets all required state, and then either submits or returns before setting per-draw state. Paths must not set uniforms, textures, vertex buffers, index buffers, scissor, or stencil and then return without submit.

## BgfxFilterRegistry

`BgfxFilterRegistry` owns compiled filter records and their RmlUi handles.

Responsibilities:

```text
compile RmlUi filter parameters into FilterRecord values
release filter records
lookup filter records by Rml::CompiledFilterHandle
own saved mask-image filter metadata when a saved mask image creates a filter
```

The registry handles lifetime. The filter pipeline handles execution.

## BgfxFilterPipeline

`BgfxFilterPipeline` applies resolved filter records to bounded `TextureRegion` inputs.

Responsibilities:

```text
resolve handles through BgfxFilterRegistry
simplify filter chains
compute total filter expansion
copy valid source regions into bounded work textures
apply opacity
apply color matrices in premultiplied-alpha space
apply mask images using saved mask metadata
apply blur over bounded work regions
apply drop shadows with offset and blur expansion
return a new TextureRegion for the filtered output
```

Filter input and output are always `TextureRegion` values. The pipeline never infers source dimensions from the global framebuffer. It uses the region's texture width, texture height, global bounds, and valid local rect.

The pipeline may acquire temporary targets from `BgfxTargetCache` and submit work through `BgfxDrawContext` and `BgfxPassBuilder`. It does not own target resources directly.

Filter expansion is computed before source layer materialization when possible so child layers can allocate enough content for blur and drop-shadow output. For example:

```text
blur expands by its kernel radius
drop-shadow expands by offset plus blur radius
opacity and color matrix do not expand geometry
mask image does not expand geometry, but it constrains sampling
```

Color matrices preserve the renderer's premultiplied-alpha convention. Constant RGB terms are applied in premultiplied space in the same convention as the upstream RmlUi renderer.

Mask-image filtering uses saved mask bounds and texture metadata to map the destination work region to mask UVs. Saved mask textures do not implicitly represent the full framebuffer.

The filter pipeline must never sample from a texture while rendering into a framebuffer whose color attachment is the same texture. When a WebGL feedback loop would occur, the pipeline routes through a separate bounded scratch target.

## BgfxLayerSystem

`BgfxLayerSystem` owns RmlUi layer semantics.

Responsibilities:

```text
manage active layer handle and layer stack
create root layer state at frame start
create virtual child layers on PushLayer
record child-layer geometry, shader, and clip-mask commands
accumulate conservative content bounds
accumulate conservative mask bounds
track named fallback reasons
materialize virtual source layers only when a texture is required
materialize destination layers when composite output requires bounded storage
replay recorded commands into bounded targets
replay inherited clip masks into bounded targets
save bounded layer regions as textures
save bounded layer regions as mask-image filters
restore logical render state after replay
```

`PushLayer()` is allocation-free for normal child layers. It creates a virtual layer record, captures push-time render state, and starts recording. It does not allocate a framebuffer just because RmlUi pushed a layer before content bounds were known.

`RenderGeometry()`, `RenderShader()`, and `RenderToClipMask()` record commands while the active layer is a virtual child. The recorded command includes all state needed for faithful replay:

```text
command kind
geometry handle
texture handle or shader handle
translation
scissor state
transform state
clip-mask enabled flag
stencil reference
clip-mask operation and stencil transition metadata when applicable
```

Content bounds are updated as commands are recorded. Geometry and shader commands union their transformed geometry bounds, intersected by active scissor and conservative mask constraints. Clip-mask commands update conservative mask bounds. Inverse clips are bounded by the best known parent, scissor, or layer limit; they do not automatically force a full-frame fallback when a narrower safe bound exists.

A virtual source layer materializes when one of these operations requires a texture:

```text
CompositeLayers(source, destination, blend, filters)
SaveLayerAsTexture()
SaveLayerAsMaskImage()
a nested layer operation requiring an already-rendered parent texture
```

Materialization chooses bounded allocation bounds from:

```text
accumulated content bounds
filter expansion
parent layer bounds
push-time scissor bounds
conservative mask bounds
explicit required composite or save bounds
surface bounds
```

The layer system then requests a target from `BgfxTargetCache`, clears only the bounded target, replays inherited clip masks, and replays recorded commands in original order using local target coordinates.

Destination materialization is separate from source materialization. When compositing into a virtual or bounded destination, the destination target is large enough to include the composite output region plus any already-known destination content that must be preserved.

## Frame Flow

A typical frame proceeds as follows.

### BeginFrame

```text
reset perf counters
reset frame-failure state
begin target-cache frame
begin pass-builder frame
choose root presentation policy
create or reuse root target if offscreen root is selected
initialize root layer state
clear root target when required
```

The root layer may be full-frame. That is acceptable when root presentation is offscreen. The performance-critical rule is that child layers and small filters remain bounded.

### Ordinary Root Drawing

When RmlUi renders geometry directly into the root layer, the adapter delegates immediate draws to `BgfxDrawContext` unless root recording is explicitly enabled by a future root-prescan policy.

Root geometry uses the root projection and the current render state. Root clip masks use root-local stencil state.

### Child Layer Recording

When RmlUi calls `PushLayer()`, the layer system creates a virtual child layer and makes it active. Later geometry, shader, and clip-mask operations are recorded rather than immediately submitted to bgfx.

No child framebuffer is allocated at push time.

### Source Materialization

When RmlUi calls `CompositeLayers()`, the layer system materializes the source if it is virtual. The materialization request includes filter expansion so the source target can include all pixels needed by blur/drop-shadow/filter output.

The source materialization returns a `TextureRegion` describing the source texture and valid content region.

### Filter Application

The filter pipeline applies the requested filter chain to the source `TextureRegion`. It allocates or reuses bounded postprocess targets and returns a filtered `TextureRegion`.

If the filter chain is empty or simplifies to a no-op, the original source region may be returned directly.

### Destination Materialization And Composite

The layer system ensures the destination can receive the filtered output. If the destination is a virtual layer, it materializes or grows/reuses a bounded target that covers the output region and any content that must be preserved.

The draw context composites the filtered `TextureRegion` into the destination using the correct blend mode, local destination rectangle, scissor, and stencil state.

### Saved Texture And Saved Mask Image

`SaveLayerAsTexture()` materializes the current layer if required, converts the requested global save bounds to local texture coordinates, copies only the bounded region, and stores texture metadata.

`SaveLayerAsMaskImage()` materializes the current layer if required, copies only the bounded mask region, stores saved mask metadata, and returns a mask-image filter handle owned by the filter registry.

### EndFrame

```text
present or composite root to the backbuffer
end any frame-local target-cache bookkeeping
emit perf counters when enabled
clear transient state
```

## Base Presentation Policy

The renderer supports two root presentation modes:

```text
DirectToBackbuffer
OffscreenRoot
```

`OffscreenRoot` is always safe and may require one full-frame root clear and one full-frame final composite. `DirectToBackbuffer` is used only when the renderer can prove it is safe for the document and platform constraints.

The direct-base path is not used as a workaround for child-layer or filter performance. Child layer and filter work must remain bounded regardless of root presentation mode.

If direct presentation is not safe, the perf log records the fallback reason. A compatibility flag may exist for bisecting behavior, but the default renderer must pass correctness tests without requiring a compatibility flag.

## Clip And Stencil Model

RmlUi clip masks are implemented with stencil state inside the current render target.

The layer system records clip-mask commands for virtual child layers. During materialization, clip commands are replayed into the bounded target using local target coordinates.

Clip operations behave as follows:

```text
Set         establishes a new clip region
SetInverse  establishes the inverse of a region, bounded by the best known parent/scissor/layer limit
Intersect   intersects with the existing clip region
```

The renderer may normalize or remap stencil references as needed inside bounded targets. The final logical clip-mask enabled flag and stencil reference after replay must match the state RmlUi expects for subsequent commands.

Stencil clears are bounded whenever possible. A full-target stencil clear is allowed for a small bounded child target; a full-frame stencil clear for a tiny child layer is not acceptable.

## Transform Model

The adapter stores the current RmlUi transform matrix. Recorded commands capture the transform active at the time of recording.

Bounds calculation and shader submission use the same transform data and the same ordering:

```text
local geometry position
+ RmlUi translation
then optional RmlUi transform
then renderer projection
```

Normal 2D affine transforms are bounded conservatively by transforming rectangle corners. Non-finite or unsupported transforms produce named fallback reasons. A transform fallback should fall back to the narrowest known safe parent/scissor/layer bound, not automatically to the full framebuffer.

## Resource Lifetime

Compiled geometry, textures, shaders, and filters are owned by the adapter or narrow registries and released through the corresponding RmlUi release calls.

Layer targets and postprocess targets are owned by `BgfxTargetCache`. They may persist across frames for reuse and are destroyed on renderer shutdown or surface resize.

Virtual layer command buffers are frame-local logical state owned by `BgfxLayerSystem`. They do not own bgfx resources except through target handles acquired from the cache after materialization.

Saved textures and saved mask images are RmlUi-visible resources. Their texture ownership and release path must be explicit. A saved mask-image filter must destroy its owned saved mask texture exactly once when the filter is released.

No subsystem returns pointers into containers that can invalidate during later acquisitions in the same frame.

## Perf Counters And Diagnostics

Perf counters are structural diagnostics, not user-facing telemetry. They are used to prevent regressions in the renderer's architecture.

Important counters include:

```text
passes
geom
clip
gradients
layers
full_layers
bounded_layers
full_frame_child_layers
bounded_child_layers
unbounded_layer_fallbacks
unbounded_no_scissor_fallbacks
unbounded_transform_fallbacks
unbounded_inverse_clip_fallbacks
filters
blur
shadow
mask
base_direct
base_offscreen
base_fallback
clear_px
copy_px
composite_px
post_px
full_frame_passes
bounded_passes
full_frame_clear_passes
bounded_clear_passes
full_frame_composite_passes
bounded_composite_passes
full_frame_postprocess_passes
bounded_postprocess_passes
full_frame_postprocess_target_uses
bounded_postprocess_target_uses
rt_alloc
rt_destroy
layer_alloc
layer_destroy
max_layer
max_child_layer
max_child_rt
max_rt
fb
```

FPS is useful for local investigation but should not be the primary CI gate. Structural counters are more stable and identify the actual architectural regression.

The readback gallery should fail smoke tests if small effects produce full-frame child layers, full-frame postprocess passes, unbounded fallbacks, or steady-state target allocation churn.

## WebGL And bgfx Constraints

The renderer treats WebGL feedback-loop rules as mandatory. It never samples from a texture while rendering into a framebuffer that has the same texture attached as a color target.

The renderer also respects bgfx's state model:

```text
set all per-draw state explicitly for every draw
submit after setting draw state
validate before setting state on paths that can early-return
use bgfx capabilities before assuming blit support
centralize view setup and ordering
keep RmlUi views sequential
```

Texture blit is optional. Paths that rely on blitting check bgfx capabilities and use draw-copy fallbacks when needed.

## Adding Or Changing Renderer Features

When adding a renderer feature, decide first which subsystem owns it:

```text
New RmlUi API surface                 BgfxRenderInterface adapter
New layer-stack/materialization rule  BgfxLayerSystem
New framebuffer reuse rule            BgfxTargetCache
New bgfx view/pass shape              BgfxPassBuilder
New low-level draw operation          BgfxDrawContext
New filter type or filter ordering    BgfxFilterRegistry / BgfxFilterPipeline
New bounds math                       rmlui_render_bounds
New pure policy helper                rmlui_render_planning
```

Do not add new behavior by reaching across subsystem boundaries into another object's private state. If a module needs to reach back into `BgfxRenderInterface::Impl` internals to do its job, the boundary is wrong.

Do not introduce new full-frame fallback behavior without a named reason, perf counter visibility, and a test scene proving the fallback is legitimate.

## Verification

Narrow checks after renderer changes inside `Cruel/nt`:

```sh
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug -R readback
./build/linux-debug/apps/sandbox/noveltea-sandbox --demo none --rmlui-document project:/rmlui/readback_gallery.rml --frames 180 --no-imgui --render-perf
pnpm run web:smoke:debug
```

Reusable-boundary checks during Phase 4.5:

```text
No reusable-core header includes noveltea/... headers.
No reusable-core source includes NovelTea AssetManager, SurfaceMetrics, shader loader, view IDs, SDL3, Lua, ImGui, or runtime custom component headers.
NovelTea-specific shader, texture, surface, view-range, and diagnostic behavior lives in adapter files.
The engine links against the reusable renderer target or staged reusable-core files instead of compiling the monolithic renderer directly into engine.
```

Full checks before merging renderer architecture changes:

```sh
clang-format --dry-run --Werror engine/src/ui/rmlui/*.cpp engine/src/ui/rmlui/*.hpp
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug
cmake --build --preset web-debug
pnpm run web:smoke:debug
cmake --preset web-profile
cmake --build --preset web-profile
pnpm run web:smoke:profile
```

Resize regression coverage should exercise at least:

```text
frame 1: 1280x720
frame 2: 1423x1869
frames 3-10: 1423x1869 steady
capture and verify
```

After resize warmup, target allocation/destroy counters should return to zero in steady state.

## Relationship To The Optimization Plan

`RMLUI_BGFX_OPTIMIZATION_PLAN.md` tracks phased performance and correctness work. This architecture document describes the intended shape of the renderer after the Phase 4.5 refactor.

The Phase 4.5 refactor is behavior-preserving for rendering output and structural perf. It also establishes the reusable-library boundary before or alongside subsystem extraction. It does not complete later optimization phases by itself.

After the architecture is in place, continue with the optimization plan in this order:

```text
Phase 5: transform bounds without full-frame fallback
Phase 6: filter pipeline uses valid content bounds, not allocation bounds
Phase 7: saved texture and mask-image bounds hardening
Phase 8: strict structural web smoke gates
Phase 9: pass count reduction and safe pass folding
Phase 10: direct base presentation revisited
Phase 11: blur quality and large-sigma strategy
Phase 12: Android and WebGL runtime validation
Phase 13: documentation and status cleanup
```

Do not start pass folding or direct-base tuning to hide unresolved full-frame child-layer or filter behavior. Pixel-area correctness comes first; pass-count reduction comes after bounded semantics are stable.
