# Authoring WebGL Renderer

## Purpose

Browser-native editor rendering that needs WebGL2 shares one GPU authority per workbench group. The
authority is deliberately below any one editor feature: Material thumbnails, Room Edit, and future
authoring surfaces register scene work against the same context, caches, and animation clock instead
of allocating parallel WebGL renderers.

The authority is for authoring rendering only. Full engine previews retain their separate runtime
ownership and remain authoritative for gameplay state and complete player presentation.

## Workbench-Group Ownership

`AuthoringWebGlGroupRenderer` owns the group-level scheduling and lifecycle contract. Its backend owns:

- one WebGL2 context and scratch canvas;
- shader-program and failed-program caches, including per-Material last-good programs;
- decoded GPU texture objects and sampling variants;
- shared geometry buffers;
- Material binding and role-owned pipeline state;
- one `requestAnimationFrame` scheduler and animation timestamp;
- one WebGL context-loss and restoration boundary.

The normal workbench creates one `AuthoringWebGlGroupProvider` around each rendered group. The
authority is lazy: no WebGL context is requested until the first scene consumer registers. The
authority is recreated when active Project-session authority changes and is disposed with the group.

Persistent editors are physically hosted outside the group subtree. `workbench-group-services.tsx`
therefore publishes the owning group's authoring renderer and bridges that exact renderer into the
persistent host. Moving a persistent editor does not justify a second GPU authority.

## Scene Work Interface

Consumers register `AuthoringWebGlSceneWork` with:

- an explicit numeric order;
- current visibility;
- a render callback receiving the shared frame object;
- a required consumer-local error callback.

Visible work is sorted by order, with registration sequence as the deterministic tie-breaker. Every
consumer in one animation frame receives the same `timeSeconds`. When no registered work is visible,
the group stops scheduling frames.

The frame interface exposes target setup/copy plus shared Material drawing. Material drawing accepts
an authoring Material resource, common geometry, an optional model-view-projection matrix, texture
overrides, renderer-owned textures, and uniform/parameter overrides. It does not know about Material
preview backgrounds, hotspot fixtures, thumbnail visibility, or other preview-harness semantics.
Room Edit can therefore submit ordered scene draws through this interface without importing the
Material preview renderer or allocating its own program/texture caches.

## GPU Invalidation and Recovery

Project-resource invalidation clears Project-derived GPU textures while retaining reusable shader
programs and last-good-program state. Consumers are responsible for refreshing their CPU-side inputs
for the new Project generation before they submit new work.

WebGL context loss is owned once at the group authority. Pending animation work stops and the
authority reports `authoring-webgl.context-lost`. On restoration, shared programs, textures, and
geometry buffers are reset centrally, the existing authority becomes available again, and visible
scene work resumes on the same group scheduler. Intentional disposal marks the authority disposed
before releasing WebGL, so the resulting browser context-loss event cannot publish a false retained
status.

If WebGL2 cannot be created, the authority reports `authoring-webgl.webgl2-unavailable` and does not
schedule scene work. Feature adapters translate that group-level state into their own user-facing
diagnostics where necessary.

## Material Preview Adapter

Material previews are the first consumer of the generalized authority. `MaterialPreviewGroupRenderer`
still owns Material-surface registration, Project-resource lookup, visibility suspension, preview
fixtures, checker/light/dark backgrounds, hotspot pointer uniforms, standard-facet preview values,
and per-surface shader diagnostics. It no longer owns a WebGL context, animation scheduler, or GPU
caches.

The Material adapter registers one group scene-work item regardless of how many Material surfaces are
mounted. Within that item it renders each visible surface through the shared frame and copies the
scratch result to the surface's ordinary canvas. This preserves the existing lightweight-preview
lifecycle while leaving the lower-level authority reusable by Room Edit and other scene renderers.

## Room Edit Adapter

The Room editor's `Edit` mode is the second production consumer of the shared authority. It resolves
the authored Room through one browser-side spatial projection seam, then uses that exact projection
for both WebGL world draws and React authoring overlays. Room Edit draws the Room background, Props,
exact Interactable occurrences, Character/cast layers, and Environments while React outlines every
`RoomPlacement`, including empty placements. Placement-attached Layouts stay editor metadata rather
than RmlUi documents: Edit shows a labeled placeholder at the exact projected placement bounds and
reduces its emphasis when rendered occupants share that placement.

Room Edit deliberately reuses runtime world-presentation semantics for the authored default Camera
View, `contain` camera clamping, normalized placement/environment geometry, background
`cover`/`contain`/`stretch`/`center` fitting, Character layer composition, occurrence visibility,
Presentation Plane/order interleaving, engine-2d Material specialization, texture overrides,
Property-backed parameters, Environment opacity/UV motion, and standard Material facets. Background
`cover` uses the same cropped UV rectangle as runtime rather than emulating the crop with a DOM image.
All Material draws receive the workbench-group frame timestamp, so animated Materials in Room Edit and
Material preview surfaces advance from the same authoring clock.

Room Edit precision navigation is a second, editor-only transform applied after that authored Camera
projection. Wheel zoom is pointer-centered; middle-mouse drag and Space+left-drag pan the projected
surface with bounded overscroll; and Fit is exactly the identity navigation transform used for parity
with Preview. The navigation transform is retained in the Room tab state rather than written to the
Room or Camera View. WebGL draws and DOM overlays both consume the already-navigated projection, so
navigation cannot create a renderer/selection-geometry split.

Room Edit selection is semantic rather than draw-index based. A selected Placement is distinct from
an exact Interactable occurrence, Prop, cast occurrence, Environment, placement-attached Layout,
Room overlay, or Hotspot. The viewport and Room Composition pane share that same tab-scoped selection
state. Ordinary click resolves through an occupant to its containing Placement, including when the
occupant visual extends beyond the Placement rectangle; double-click selects the topmost exact
occupant. Right-click exposes every overlapping candidate plus associated containing Placements and
uses a temporary hover outline without replacing the committed selection. The Composition pane shows
a placement-oriented Room Contents hierarchy when selection is empty and switches to semantic entity
inspection when selection is present. Preview retains this pane and its selection state but makes it
inert while the engine surface owns presentation input.

Condition truth is not reimplemented in the browser. While Edit is active, the Room's focused-preview
host stays logically connected but visually concealed and returns the native `RoomPresentationResolution`
membership for cast entries, Interactable occurrences, Props, and Environments. Room Edit uses that
resolved membership as its visibility authority, so Lua predicates and nested boolean conditions run
through the same sandbox/query-provider path as focused Preview. Until a native resolution exists for
the current Project revision, conditions that the browser cannot resolve deterministically are omitted
rather than guessed.

The existing focused engine Room preview remains a separate persistent `Preview` mode. Only the
active direct-edit surface registers Room Edit scene work, and the focused preview continues to use
the existing dedicated-while-open preview-host ownership. In Edit the host is concealed and serves
only as the native semantic resolver; switching to Preview reveals that same host. Room Edit never
creates a private WebGL context and deliberately excludes RmlUi, runtime Hotspot highlights,
postprocess, transitions, and other player-facing runtime effects. Runtime Preview therefore remains
the authority for those complete gameplay-presentation concerns even though Edit now covers the
agreed base world composition subset.

Mode switching preserves one visible/input-owning surface. Edit → Preview cancels any active pan,
animates editor navigation to Fit over 180 ms, and only then reveals the retained engine Preview.
Preview → Edit reveals Edit at Fit and animates back to that tab's remembered precision navigation.
`prefers-reduced-motion: reduce` skips the interpolation while preserving the same final states. The
retained preview host lifecycle is unchanged by these visual transitions.

## Implementation

Primary files:

```text
editor/src/renderer/authoring-renderer/authoring-webgl-renderer.ts
editor/src/renderer/authoring-renderer/authoring-webgl-backend.ts
editor/src/renderer/authoring-renderer/authoring-webgl-provider.tsx
editor/src/renderer/material-preview/material-preview-renderer.ts
editor/src/renderer/material-preview/material-preview-provider.tsx
editor/src/renderer/editors/rooms/RoomCompositionPane.tsx
editor/src/renderer/editors/rooms/RoomEditSurface.tsx
editor/src/renderer/editors/rooms/room-edit-navigation.ts
editor/src/renderer/editors/rooms/room-edit-projection.ts
editor/src/renderer/editors/rooms/room-edit-selection.ts
editor/src/renderer/workbench/workbench-group-services.tsx
```

The group authority contract is covered by `authoring-webgl-renderer.test.ts`. Material binding,
preview lifecycle, invalidation, and recovery remain covered by `material-preview-renderer.test.ts`.
`room-edit-projection.test.ts` covers the Room spatial seam,
`room-edit-selection.test.ts` covers placement-first semantic hit resolution, and
`shader-material-preview-pooling.test.tsx` proves that Material Preview and Room Edit share one
provider-owned GPU authority.
