# Hotspot Authoring, Feature Semantics, and Runtime Input

This document is the permanent cross-cutting contract for Room/Interactable Features and image-relative
Hotspots. Entity-specific field descriptions remain in `docs/engine/ROOM.md`,
`docs/engine/INTERACTABLE.md`, and `docs/engine/INTERACTION.md`.

## Semantic model

A **Feature** is a stable semantic part owned by exactly one Room or Interactable. Features are nested
content, not a top-level collection. Their runtime identity is therefore always owner-qualified:

- Room Feature: `(RoomId, FeatureId)`;
- Interactable Feature: `(InteractableId, FeatureId)`.

A bare `FeatureId` is never a project-wide reference. A Feature may attach compatible Traits and
assign compatible identity-scoped Properties. Those values use the same Property resolver, runtime
override, save/load, Lua, validation, and diagnostics machinery as other Property-bearing identities.

Features are admitted Interaction subjects alongside Characters and exact live Interactable Instances.
Final Interaction commands bind those exact subjects to stable named Verb slots. Subject
Selectors may admit a family, required Trait, Interactable Definition, qualified identity pattern, exact
identity, or any supported subject; Hotspot identity itself never participates in slot matching.

A **Hotspot** is geometry plus pointer-selection metadata. It does not own a Verb, an Interaction
program, or an exact Interaction context. A Hotspot maps pointer geometry to one semantic target:

- explicit `none`, which retains authored geometry but creates no runtime interaction target;
- a Feature owned by the same Room or Interactable;
- another admitted exact Interaction subject;
- the owning Interactable itself; or
- for Room Hotspots, one owner-local Room Exit.

Different Hotspots may intentionally map to the same semantic subject. Once hit testing resolves a
Hotspot, downstream runtime input contains the semantic subject or Room Exit, not the Hotspot ID.
This is the identity invariant that keeps pointer selection equivalent to keyboard, Layout, Lua,
preview/debugger, and authored-test selection.

## Authoring and compilation

Room and Interactable records own `features`. Feature IDs are stable and unique only within their
owner. The editor exposes Feature authoring beside Hotspot authoring; Feature IDs remain stable after
creation so references do not silently drift. Deleting a referenced Feature is surfaced through the
normal dependency/validation diagnostics rather than by inventing a replacement identity.

Room Hotspots use normalized rectangular bounds relative to the complete background source image.
Interactable Hotspots use either current-sample Visual alpha coverage or normalized custom rectangles
relative to the complete image/Animation Visual canvas. Every Hotspot retains a stable owner-local ID, label,
condition, input order, highlight policy, and target. `none` is a valid target for either owner kind;
new Room geometry defaults to `none`, while new Interactable Hotspots may continue to default to the
owner. Validation emits an informational diagnostic for the inert state instead of rejecting it.

The dependency graph indexes nested Feature ownership, Feature Trait/Property dependencies, Hotspot
targets, and owner-local Room Exit targets. There are no exact-Hotspot Interaction-context edges and
no authored-test Hotspot-activation edges because Hotspot identity is not a gameplay subject.

The compiled-project boundary is `noveltea.compiled.project` format version 1. Issue #70 was an atomic
replacement of the then-current development contract; it does not introduce a compatibility-version bump. Compiled
Room/Interactable definitions contain nested Features, Interaction subjects include owner-qualified
Feature references, and Hotspots contain semantic targets instead of behavior activations.

Project-aware validation rejects duplicate Feature IDs, missing Feature owners, owner-local Feature
or Exit mismatches, incompatible Feature Trait/Property assignments, invalid target subjects,
unsupported image/mask combinations, incompatible highlight Materials, and invalid normalized bounds.

## Editor behavior

Hotspot authoring separates geometry from semantics. The owning Room or Interactable editor keeps
the Hotspot collection and semantic fields such as target, condition, cursor, highlight, input order,
ID, and label. `Edit geometry` opens **Hotspot Focus**, a reusable temporary full-tab workspace over
the owner's source image. The shared React image stage inside Hotspot Focus provides selection,
rectangle creation, move, resize, entity deletion, zoom, pan, Fit, native 100% view, and
image-coordinate conversion. Visual-alpha Interactables use the same focused source-image workspace
for inspection without exposing rectangle creation. Focus derives an alpha-coverage overlay directly
from the full-resolution source image so transparent versus interactive pixels remain visible, while
the geometry-less visual-alpha Hotspot behavior still appears in the shared item list and can be
selected for inspection without manufacturing a fake rectangle.

Room Edit projects authored Room Hotspots back through the background's source-image UV mapping, so
cover cropping, contain/center geometry, stretch, authored Camera View, and editor navigation all
produce the same selectable screen bounds as the presented background. Hotspots use a distinct
non-runtime overlay and participate in the Contents tree and right-click candidate list. Ordinary
click selection remains placement-oriented when a Placement or rendered occurrence overlaps a
Hotspot. Selecting a Hotspot opens the normal semantic inspector and never exposes Room-space move or
resize handles. Both that inspector's `Edit geometry` action and the no-selection `Edit Hotspots`
action enter the same owner-local Hotspot Focus session.

Hotspot Focus keeps view state independently per owner/source target. Its native zoom basis makes
100% correspond to one source-image pixel per CSS pixel; first entry uses 100% when the complete
source fits and Fit otherwise. Select, Rectangle, and Pan are explicit geometry tools. Rectangular
geometry snaps to native source-image pixel boundaries by default for create, move, and resize;
Pixel snap is a Focus view-state toggle, and holding Alt during a drag temporarily inverts its current
setting. Snapping quantizes source-image edges while the persisted Hotspot contract remains normalized
floating-point bounds. Rectangle mode remains active after a successful draw so several Hotspots can
be created in sequence, while the newest rectangle becomes selected. While Focus owns the active tab,
Escape cancels the active draw/move/resize/pan gesture before mouse-up can commit it, and
Delete/Backspace removes the selected
rectangle from non-text-entry focus. Text-entry controls retain their ordinary editing keys.

For Room backgrounds, Focus transitions the full source image from the currently authored Room
presentation mapping (including source cropping/stretch and Camera rotation) through native-aspect
framing into the remembered Focus camera; exit runs those endpoints in reverse. Reduced-motion
preferences skip the animation. Entry from Preview derives this endpoint from canonical Room
presentation/background geometry rather than Room Edit navigation, while entry from Edit uses the
visible authored Edit presentation. Cropped Room background pixels stay clipped to the presented Room
viewport at the Room endpoint and are only allowed to expand after the transition leaves that endpoint.
Focus navigation remains independent from Room Edit navigation.

Geometry changes are session-local. Draw, move, resize, and delete participate in a local undo/redo
history, including Ctrl/Cmd+Z and Ctrl/Cmd+Y. While the Focus tab owns the active workbench group,
Focus captures those shortcuts at the window boundary regardless of whether DOM focus is on the
workspace root, toolbar, image stage, geometry handles, or document body, so they never also reach
project undo/redo. Inactive Focus tabs do not claim the shortcuts, and Terminal input remains outside
Focus shortcut ownership. Deleting required rectangle geometry removes the whole Hotspot entity from
the draft, while parent-editor composition shortcuts are suspended for the lifetime of Focus. `Done`
publishes geometry through one project command and therefore one project-level undo step. The session
captures the owner/source Asset relationship plus the source image identity used for image-space
coordinates. Before the geometry merge, `Done` verifies that the owner still references that Asset
and that the source path/content identity and image metadata still match. A stale-source mismatch
fails closed before project mutation and keeps the Focus session and local draft intact so the author
can cancel or restart against the current image. After that precondition succeeds, `Done` performs a
three-way merge against the geometry seen on entry and the latest Project geometry: untouched shapes
preserve concurrent changes, disjoint geometry edits compose, and conflicting edits to the same
shape—including move/resize versus concurrent deletion—fail closed. `Cancel` discards the draft.
Successful `Done` returns Room Edit with the most recently selected/created Hotspot selected when one
remains. Switching tabs may leave the focus session alive. Entry and exit animation work is owned by
the mounted Focus workspace; unmount cancels pending RAF/timers so an inactive editor instance cannot
later commit/discard or run its return callback. Remount reconstructs the same retained session and
return endpoint instead.
A modified session registers as a strict current-shape serializable workbench draft under the owning
editor-session compatibility boundary; it does not define an independent draft version. Geometry,
selection, active tool, and camera state are synchronized into that recovery entry while the draft is
dirty. Recovery preserves a source-stale draft so it can still be explicitly discarded or inspected;
the source-identity guard above continues to prevent applying it to a replacement source. Malformed
draft payloads are discarded. Closing the owning tab requires explicit apply/discard even when
another visual tab shares the same record save unit.

Hotspot semantic editing chooses a target rather than a Verb. Room targets include local Features,
other admitted subjects, and local Exits. Interactable targets additionally include the owning
Interactable directly. The target selector may also reference owner-qualified Features elsewhere in
the project when that is the intended semantic subject. New Room rectangles start at the inert
`none` target, while custom Interactable rectangles start at `owner`.

Room and Interactable editors also expose nested Feature editing: stable ID, label, compatible Trait
attachments, and compatible Property assignments. Feature mutation uses the ordinary command bus so
undo/redo, dirty state, dependency indexing, validation, and compilation remain atomic.

Focused Room preview remains passive and receives no world-Hotspot input. Full Play preview uses the
ordinary compiled runtime and publishes semantic clickable targets. The editor recorder stores the
accepted semantic selection/navigation input; it never stores pointer coordinates or a Hotspot ID.

## Runtime resources and rendering

Texture preparation may retain one-bit alpha occupancy in prepared CPU residency. Custom masks are
generated as binary runtime resources by the typed asset preparation pipeline. Both participate in
normal request coalescing, cancellation, reservation, residency, eviction, telemetry, structured
prefetch, and mandatory publication gates.

World presentation resolves immutable Hotspot projections in authored reference coordinates. An
Interactable projection retains the owner occurrence and Visual selection, not a changing frame Asset.
Mandatory preparation retains CPU coverage for every selected frame; realization updates hit-target
leases and overlay textures from the same sample. Unsupported alpha coverage fails explicitly without
rectangle fallback. Custom hit geometry does not depend on highlight-source support. Default
and custom highlights bind through the strict `hotspot-overlay` Material contract. The alpha preset
requires only the renderer-owned source image at reserved stage 0; the custom-mask preset requires
that image plus the renderer-owned mask at reserved stage 1. Their clamp/filter policies and
premultiplied-alpha composition are contract-owned and cannot be replaced with authored texture
sources. Bounds, hover/press state, and source dimensions remain optional standard semantic bindings
that a custom shader may consume without being required to declare them. `none` highlights remain
semantically selectable and allocate no overlay resources. Overlay ordering does not change semantic
target identity.

Hotspot IDs remain an internal presentation/hit-test identity so hover, press, capture, draw ordering,
and generation replacement are deterministic. That identity terminates at the hit-test boundary and
is not published as Interaction context or runtime input.

## Pointer routing and semantic dispatch

Host pointer coordinates are projected through the committed presentation transform. Presentation
bars and non-image owner margins are rejected. Rectangle containment is half-open on right/bottom
shared edges while the global source-image edge remains reachable. Cross-owner precedence reuses the
committed world draw tuple; within one owner, higher `inputOrder` wins and Hotspot ID is the final
deterministic tie-break.

RmlUi/Layout admission runs before world hit testing. Only the primary mouse button or first active
touch may capture. Movement slop is eight host CSS pixels and release must remain inside the captured
geometry. UI admission changes, focus/window/touch cancellation, presentation replacement, reset,
pause, and shutdown clear transient hover/press/capture state without dispatching gameplay input.
Every committed presentation-generation change invalidates an existing pointer gesture even when an
identical Hotspot exists in the replacement frame.

On successful release, the world controller returns the resolved semantic target:

- an `InteractionSubject` is dispatched through the same subject-selection input used by non-pointer
  selection; or
- a `RoomExitRef` is dispatched through the same selected-exit navigation path used elsewhere.

There is no `ActivateHotspotInput`, no Lua `Game.activate_hotspot`, no Layout
`Game.ui.activate_hotspot`, and no exact-Hotspot Interaction context. Generic Interaction invocation
cannot manufacture Hotspot identity because Hotspot identity is no longer part of Interaction
semantics.

Hotspots whose authored target is `none` are filtered before runtime presentation Hotspot projection.
Their conditions are not evaluated for pointer behavior, they allocate no world hit-test target, and
they cannot produce semantic selection or Exit navigation. Their authoring geometry remains available
to editor tooling for selection and later target assignment.

## Lua, preview, debugger, and tests

Lua `Game.run_action` accepts a map of stable Verb slot IDs to exact Character, Interactable,
or owner-qualified Feature subjects. Feature Properties are available through the typed
Feature Property helpers using `(owner_kind, owner_id, feature_id, property_id)`. A Feature reference
remains owner-qualified at every Lua/runtime boundary.

Runtime debug snapshots publish semantic clickable targets, not authored Hotspot definitions. A
clickable target is either a semantic subject plus label or a Room Exit plus label. Hidden, disabled,
absent, condition-false, or otherwise unavailable geometry does not publish an enabled target.

Preview command transport supports the same Feature subject shape used by runtime selection and
Interaction invocation. Recorder and authored-test playback store semantic `select-subjects`,
`run-interaction`, or `navigate` inputs. Two different Hotspots that map to the same Feature therefore
produce the same recorded/runtime subject identity.

Save state preserves named Interaction bindings, including owner-qualified Feature subjects, in
yielding Interaction frames and preserves Feature Property overrides. It does not persist Hotspot
invocation identity.

## Export and package behavior

Feature and Hotspot authoring data compile into strict `noveltea.compiled.project` format version 1.
Referenced images, shader variants, Materials, and built-in Hotspot resources are included by the
existing closure and package writers. Runtime-generated custom masks remain derived resources rather
than independent authoring assets.

## Verification

The durable historical certification record for the original Hotspot implementation remains in
`docs/architecture/certifications/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_CERTIFICATION.md`.
The superseded implementation plan is archived in
`docs/archive/plans/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_IMPLEMENTATION_PLAN.md`; current behavior
is defined by this document and the entity/runtime documents referenced above.
