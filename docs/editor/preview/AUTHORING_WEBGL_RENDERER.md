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
the authored Room through one browser-side spatial projection seam with two explicit stages: a
canonical authored projection and a display projection with editor-only precision navigation applied.
React authoring overlays consume the display projection, while WebGL feeds custom vertex stages the
same canonical, Camera-projected logical vertex coordinates that native world rendering submits.
Editor-only precision navigation is applied afterward through the authoring projection matrix, so it
cannot change shader-visible `a_position` coordinates. Material semantic facets such as paint
width/height and authored Camera zoom likewise come from the canonical projection. Room
Edit draws the Room background, Props,
exact Interactable occurrences, Character/cast layers, and Environments while React outlines every
`RoomPlacement`, including empty placements. Placement-attached Layouts stay editor metadata rather
than RmlUi documents: Edit shows a labeled placeholder at the exact projected placement bounds and
reduces its emphasis when rendered occupants share that placement. Native Preview/runtime realize the
attached RmlUi document at that same placement footprint, including the Room Camera transform; Edit's
placeholder therefore represents runtime spatial geometry rather than a merely illustrative region.

Room Edit deliberately reuses runtime world-presentation semantics for the authored default Camera
View, `contain` camera clamping, normalized placement/environment geometry, background
`cover`/`contain`/`stretch`/`center` fitting, Character layer composition, occurrence visibility,
Presentation Plane/order interleaving, engine-2d Material specialization, texture overrides,
Property-backed parameters, Character `bob`/`sway`/`pulse` idles, Environment opacity/UV motion, and
standard Material facets. Background
`cover` uses the same cropped UV rectangle as runtime rather than emulating the crop with a DOM image.
All Material draws receive the workbench-group frame timestamp, so animated Materials in Room Edit and
Material preview surfaces advance from the same authoring clock. Occurrence-bound animation state does
not use that absolute timestamp directly: Environment scrolling and the `occurrence-time` Material
facet establish a per-occurrence epoch in the authored clock domain and restart at zero when that
occurrence disappears and is later recreated, matching native world presentation.

Room Edit precision navigation is a second, editor-only transform applied after that authored Camera
projection. Wheel zoom is pointer-centered and owned by a non-passive native wheel listener so the
browser cannot also scroll the enclosing editor; middle-mouse drag and Space+left-drag pan the
projected surface with bounded overscroll; and Fit is exactly the identity navigation transform used
for parity with Preview. The Edit Fit frame uses the same full presentation rectangle as the Preview
surface; editor chrome must not shrink only the Edit side of that parity boundary. Escape cancels an
active pan before lower-priority tools. The navigation
transform is retained in the Room tab state rather than written to the Room or Camera View. WebGL
draws and DOM overlays both consume the display projection, so navigation cannot create a
renderer/selection-geometry split or alter authored Material semantic dimensions.

Room Edit selection is semantic rather than draw-index based. A selected Placement is distinct from
an exact Interactable occurrence, Prop, cast occurrence, Environment, placement-attached Layout,
Room overlay, or Hotspot. The viewport and Room Composition pane share that same tab-scoped selection
state. Ordinary click ignores Hotspots and resolves through an occupant to its containing Placement,
including when the occupant visual extends beyond the Placement rectangle; double-click selects the topmost exact
occupant. Right-click exposes every overlapping candidate plus associated containing Placements under
a dedicated `Select` submenu, while `Add` remains a separate submenu. Focus/hover within `Select` uses
a temporary candidate outline without replacing the committed selection. The Composition pane shows
a placement-oriented Room Contents hierarchy when selection is empty and switches to semantic entity
inspection when selection is present. Preview retains this pane and its selection state but makes it
inert while the engine surface owns presentation input.

The same authoritative ordinary-hit geometry drives a lightweight Placement hover emphasis. Hover does
not create selection state and is suppressed for the already-selected Placement. Direct-manipulation
capabilities are modeled independently: cast/Character occurrences are movable, but they do not expose
generic Placement-rectangle resize handles because their visible geometry is derived from Character
layer composition rather than from the Placement rectangle itself.

Direct manipulation uses the same semantic command rules as committed edits. Empty-space drag creates
a Placement-oriented marquee, while Ctrl/Cmd-click can extend that selection with exact occurrences
or other spatial Room entities. Moving a selection resolves shared-placement ownership before drawing:
an explicitly moved occurrence splits to a dedicated Placement when siblings must remain behind,
whereas selecting the Placement moves all of its occupants once. The requested translation is clamped
to Room bounds before semantic splitting; an effective zero-distance move is a no-op and cannot change
Placement topology or create undo history. Both WebGL and DOM consume that same clamped transient draft. Single spatial selections expose
resize handles and use the same draft path, including shared-placement splitting; a handle click with
no geometry change is a no-op and creates no command. Pointer-up commits the already-previewed semantic
operation as one undoable command, while Escape or switching to Preview discards the transient draft.
When a direct drag begins on an unselected entity, that entity is committed to the shared semantic
selection immediately (or added under Ctrl/Cmd), so the viewport, Room Contents hierarchy, and
inspector describe the same entity being moved throughout the gesture.

New rendered Room content also follows one semantic Add path. Composition-pane Add enters a positioned
ghost/drop flow, right-click Add seeds the clicked Room point, and the legacy Contents Add controls use
the same operation with a centered seed. Props, cast occurrences, and Interactable occurrences receive
a dedicated Placement by default; sharing an existing Placement is an explicit action. Multi-selection
Delete is one command, with confirmation only when deleting a selected Placement would remove multiple
occupants. That consequential delete uses the shared editor Dialog, enumerates the affected occupants,
and commits exactly one deletion command only after confirmation. Presentation reordering stays within
the selected entity's current Presentation Plane, and
editing the advanced numeric order inserts at an occupied order rather than authoring a duplicate.

Room Edit also follows the shared authoring WebGL last-good shader contract. If a Material draw reports
a stale shader while a last-good program is available, Room Edit keeps rendering subsequent draws,
copies the completed frame, and surfaces the current shader failure in the Edit UI. A hard
shader-program failure with no last-good state aborts that frame before it is copied and is surfaced
as a distinct hard render diagnostic, avoiding publication of a partially rendered Room image. Room
Edit reads WebGL2 availability and context-loss state from the same workbench-group authoring renderer
status used by Material Preview, so recovery clears the author-facing diagnostic without introducing a
second renderer authority. CPU-side preview compilation status is retained on the shared Material
resource: a stale last-good browser payload remains visibly stale, while a required custom shader stage
with no usable browser output fails hard instead of silently substituting the built-in authoring shader.
Preset stages that were not customized may still use their certified built-in browser fallback.

Shader parameter bindings are likewise resolved by the shared authoring backend from each parameter's
declared engine semantic rather than from a privileged uniform spelling. Material Preview and Room Edit
therefore share the same binding path for time, paint dimensions, reference/world raster scale,
logical/raster scale, viewport pixel dimensions, and the role-specific pointer/Hotspot/RmlUi semantics.
Room Edit derives the raster-scale and viewport inputs from the effective fitted framebuffer and the
Project world-raster policy instead of assuming a 1:1 reference surface. Author-settable reflected
uniforms are refreshed on every draw with native precedence: occurrence/draw override, Material
assignment, then reflected default. This prevents a shared WebGL program from inheriting a uniform
value from the preceding occurrence. Explicit Material Application or draw overrides remain
higher-precedence inputs than semantic defaults.

Condition truth is not reimplemented in the browser. While Edit is active, the Room's focused-preview
host stays logically connected but visually concealed and returns a native Room-resolution summary for
cast entries, Interactable occurrences, Props, and Environments. Cast and Interactable membership in
that summary represents final draw eligibility after runtime state and composition-hook mutation, not
mere structural presence. Room Edit uses that resolved result as its visibility authority, so Lua
predicates, nested boolean conditions, and composition changes to `enabled`/`visible` agree with focused
Preview. The retained native result is keyed by visibility/admission semantics rather than the broad
Project revision, so placement bounds, presentation order, and other geometry-only edits keep the last
valid native decision while condition, owner-state, Property/Variable, hook, or related admission
changes invalidate it. Until a native resolution exists for the current visibility key, conditions
that the browser cannot resolve deterministically are omitted rather than guessed.

The existing focused engine Room preview remains a separate persistent `Preview` mode. Only the
active direct-edit surface registers Room Edit scene work, and the focused preview continues to use
the existing dedicated-while-open preview-host ownership. In Edit the host is concealed and serves
only as the native semantic resolver; switching to Preview reveals that same host. Room Edit never
creates a private WebGL context and deliberately excludes RmlUi, runtime Hotspot highlights,
postprocess, transitions, and other player-facing runtime effects. Runtime Preview therefore remains
the authority for those complete gameplay-presentation concerns even though Edit now covers the
agreed base world composition subset.

Collapsing the Room visual pane suspends Room Edit scene work as well as its target-copy loop. The
prepared CPU resources and workbench-group GPU authority remain owned by their existing lifetimes, so
expanding the pane resumes rendering without constructing a parallel renderer or needlessly rebuilding
Project resources.

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
