# Rendering Stack

## Purpose

This document records NovelTea's rendering ownership boundaries. Detailed RmlUi renderer implementation notes live in the standalone `rmlui-bgfx` repository, not in this repository.

## Runtime Layers

- `Renderer` owns bgfx initialization, frame lifecycle, view setup, engine 2D draws, screenshots, resize handling, and shader/material resource caches.
- `RuntimeUI` owns RmlUi documents, input forwarding, runtime UI binding, and the NovelTea adapter around the external `rmlui-bgfx` renderer package.
- `DebugUI` owns Dear ImGui developer/debug overlay only.
- Engine-owned text rendering remains independent from RmlUi text. It now renders ActiveText glyph visuals produced by `ActiveTextLayout`, including per-glyph color/alpha/offset/scale/glow metadata, object hit rectangles, reveal clipping, and deterministic effect state.

The typed snapshot/coordinator, clock domains, mounted-Layout policies, RmlUi lifecycle contexts,
scoped desired-presentation storage, and effective-presentation assembly are implemented.
The immutable snapshot combines the settled resolved-Room baseline with authoritative Character and
Interactable world state plus active Scene/current-Room/named-Room/session/shell records. It contains
fully resolved actors, Interactables, props, environments, complete mounted Layout policy, text/choice,
Map and stable desired-audio instances. Room overlays lower to
ordinary Room-owned mounted Layout records; the old overlay and coarse Layout-slot snapshot families
no longer exist. Backends consume this snapshot and narrow asset/Layout source resolvers rather than
SessionState or Flow internals. Full-world and targeted finite presentation now run through the
coordinator-backed world transition backend. Final audio reconciliation and the system-menu stack
use the same typed publication and realization boundaries.

The engine presents game content through a centered 16:9 viewport inside the complete host surface.
The renderer clears the host to the presentation-bar color, restricts game, text, ActiveText, and
runtime-UI views to the fitted framebuffer rectangle, and retains Dear ImGui as a host-surface
overlay. Logical layout uses the fitted game dimensions; swapchain reset and screenshots use the
complete host dimensions.

## External Renderer Package

NovelTea consumes `rmlui-bgfx` as an external package through `rmlui_bgfx::rmlui_bgfx`. The NovelTea side should only document and maintain the integration boundary:

- shader-program loading from NovelTea's staged bgfx shader assets;
- texture loading through NovelTea's asset system;
- diagnostics/perf forwarding into NovelTea logging;
- material shader provider integration for NovelTea project materials used by RmlUi decorators;
- preservation of engine-rendered backbuffer color when RmlUi is composited as a transparent
  overlay;
- runtime view-range assignment.

RmlUi renderer internals, effects probes, renderer refactor plans, and optimization notes belong in the `rmlui-bgfx` repository.

## Engine 2D Rendering

NovelTea keeps a small engine-owned 2D draw layer for sprites, quads, room/object presentation, render layers, clipping, and material-backed engine geometry. The shader/material asset pipeline is documented in [`docs/rendering/plans/SHADER_MATERIAL_PLAN.md`](plans/SHADER_MATERIAL_PLAN.md).

Current view ownership:

- `Background`: room/background presentation.
- `Main`: primary scene/object presentation.
- `Foreground`: foreground overlays.
- `UIOverlay`: runtime UI and UI-adjacent presentation.
- debug UI uses its own high-numbered bgfx views.

RmlUi adapters reserve disjoint contiguous ranges for every `PresentationPlane`. GameUi owns the
largest general UI/filter range; direct ActiveText uses its final reserved view below MenuOverlay and
Modal. Contexts in a plane share that plane adapter and render by deterministic composition group,
allowing different clock/input lifecycle runs to interleave while keeping each RmlUi pass range
contiguous.

## Snapshot-Driven World Presentation

`WorldPresentationBackend` is the only production realization path for the ordinary engine-owned
world. `RuntimePresentationBridge` supplies the immutable `RuntimePresentationSnapshot`; the backend
does not inspect SessionState, Flow frames, or compiled gameplay definitions while drawing.

At project bind time, `AssetWorldPresentationResourceResolver` copies the narrow image catalog and
uses `AssetManager` only to prepare typed textures and `engine-2d` materials. Reconciliation prepares
a complete candidate frame before publishing it. A failed texture/material/color/plane resolution
retains the previous complete frame, while an identical snapshot and logical viewport performs no
resource work.

The copied catalog includes the image sampling policy. Ordinary artwork defaults to linear filtering;
pixel-art records request nearest filtering. The typed bgfx loader generates RGBA8 mip levels for
linear image assets, and both default and material-backed quad submission apply the image filter while
retaining the material's clamp/repeat address mode. World-raster, transition-scene, and postprocess
target composites are explicitly linear. The RmlUi image path continues to use bgfx's ordinary linear
filtering default.

The backend centralizes:

- background color/image/material realization with cover, contain, stretch, and native-size center
  fitting;
- normalized Interactable and prop bounds;
- Character, Room-cast, Scene, and scoped actor identity plus logical slot/Room-bound placement,
  pose anchors, offsets, scale, and expression overlay;
- typed environment visuals with optional image, material, bounds, opacity, plane/order, clock, and
  UV-scroll parameters;
- deterministic `PresentationPlane`, family, authored order, stable identity, and sublayer sorting;
- Map imagery as an engine-rendered `GameUi` underlay below the ordinary RmlUi Map Layout.

`Engine::render()` submits this batch before runtime UI. The built-in Game HUD document root is
transparent. NovelTea enables the external renderer's opt-in `preserve_backbuffer` mode, which uses
an offscreen RmlUi root and alpha-composites it over the engine world instead of clearing or replacing
the destination.

`WorldTransitionBackend` owns transient realization for both complete world transitions and typed
targeted operations. Scene `TransitionGroup` and Room navigation bind explicit source/target snapshot
revisions. Background cross-fade, actor fade/slide, and Layout fade use the same coordinator
lifecycle, engine clock, skip/reset handling, and exact terminal acknowledgement. The current target
snapshot remains authoritative while the backend retains only the exact source/target revisions and
source Layout documents required for interpolation. Same-target replacement is scoped to the
singleton background, one `ActorPresentationKey`, or one `MountedLayoutPresentationKey`; unrelated
actors and Layouts may animate concurrently.

Interpolation is supplied by backend-local `animation::TweenService` instances, privately backed by
Twink. The world backend owns separate gameplay and unscaled-presentation services and stores only
opaque handles in active realization records. The coordinator still owns operation identity,
replacement, barriers, and completion; tween samples never enter snapshots, runtime state, or saves.
See [`ANIMATION_AND_TWEENING.md`](ANIMATION_AND_TWEENING.md).

Reconstructible long-lived visuals are ordinary snapshot state, not finite coordinator operations.
Resolved actors may carry one compiled `bob`, `sway`, or `pulse` idle definition. Environment records
carry a stable owner-plus-instance identity, stop key, resource/geometry parameters, and selected
clock. `WorldPresentationBackend` owns disposable loop epochs and realizes actor motion, UV scroll,
and per-material shader time each frame. Reset/load discards those epochs; reconciliation starts the
same target at phase zero. No epoch, shader time, GPU resource, or loop phase enters runtime state or
save data.

Actor slide interpolates resolved world bounds. Show/hide derives the nearest horizontal offscreen
endpoint from those bounds, while pose/resource/plane/order changes are rejected as unsupported slide
semantics. Layout fades operate on retained source and current target RmlUi documents rather than CSS
animation ownership. Resize reconstructs retained world frames from snapshots, and reset/load/project
replacement discards transient progress before reconciling the current target.

Targeted realization failures use structured `WorldPresentation` diagnostics, including unavailable
exact revisions, unsupported operation kinds, absent actor/Layout targets, invalid slide semantics,
unavailable slide bounds, and mismatched actor visual layers. Runtime preview surfaces those failures
through the ordinary runtime diagnostic channel.

## Shader and Material Runtime Policy

Runtime code loads compiled bgfx shader binaries from staged assets. It does not compile shader source. User-authored shader/material metadata is project/game schema data; exported packages include the compiled variants needed by the runtime. The package boundary strictly decodes the separate shader/material document, verifies every selected material program against declared shader role bindings and packaged binary variants, and closes typed gameplay Material references before publishing prepared registries. Authoring material inheritance is validated and flattened by the existing editor manifest builder; runtime package definitions do not retain inheritance edges.

Material-backed engine 2D quads use `ShaderRole::Engine2D`. RmlUi decorator materials use `ShaderRole::RmlUiDecorator` through the NovelTea adapter for `rmlui-bgfx`. ActiveText rich-text material tags attempt `ShaderRole::ActiveText` material resolution, and low-level vertex/fragment shader metadata attempts direct shader-pair resolution; both paths fall back to default text rendering with deduped diagnostics when unavailable.

## Runtime UI Usage

RmlUi is NovelTea's general runtime UI layer. Runtime visual slots such as cover, background, room, object, inventory, and action UI are exposed through backend-neutral view state and bound by `RuntimeUI`. Complex widgets such as ActiveText, MapView, and TextLog may be C++-backed RmlUi elements when ordinary RML/RCSS is insufficient.

For ActiveText, RmlUi hosts `nt-active-text` as a layout/input component only. After RmlUi updates
layout, `RuntimeUI` collects a direct render snapshot with the resolved content box and a
FreeType/HarfBuzz-shaped glyph layout mapped back to rich-text metadata. `Engine::render()` submits
that snapshot through `Renderer::draw_active_text()` after RmlUi has rendered the runtime UI. ActiveText
does not generate RML glyph fallback markup. RuntimeUI owns backend playback state while the
coordinator owns typed reveal/fade identity and causal-barrier lifetime:
new text instances reveal by glyph rate and fade in, empty text fades the last displayed document out,
local rich-text page breaks and wait-for-click spans split playback into page segments, body clicks skip
an in-progress reveal without continuing in the same click, and the bgfx text renderer draws a small
prompt marker only after the current page is fully revealed and waiting for input.

ActiveText effect visuals are V1 CPU-side projections applied after stable full-text layout. `Fade`
and `FadeAcross` multiply glyph alpha; `FadeAcross` uses run-local stagger from `animation.value` or a
20 ms default. `Pop` scales only the rendered glyph quad and the bgfx renderer pivots scaling around
the glyph center. `Nod`, `Shake`, and `Tremble` apply deterministic sine/cosine offsets. `Glow` writes
a normalized intensity consumed by the bgfx text renderer as a simple warm color boost. `Test` remains
a diagnostic-only nod/glow combination. High-quality halo/blur glow and outline/border rendering remain
future work.

## Verification

For renderer or UI integration changes, use the relevant subset of:

```sh
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --build --preset web-debug
pnpm run web:smoke:debug
```

When validating tandem local changes in the standalone renderer package, configure with
`linux-debug-local-rmlui-bgfx` and `web-debug-local-rmlui-bgfx` before running the corresponding build
commands.

Use the sandbox for manual behavior checks:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180
```

For detailed RmlUi renderer visual parity or effects debugging, work in the standalone `rmlui-bgfx` repository and compare against upstream RmlUi samples there.
