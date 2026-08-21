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

Features are admitted Interaction subjects alongside Characters and Interactables. Exact Interaction
operands may therefore target a Character, an Interactable, or an owner-qualified Feature. `AnySubject`
matches all three subject families; the narrower Character/Interactable wildcards remain narrow.

A **Hotspot** is geometry plus pointer-selection metadata. It does not own a Verb, an Interaction
program, or an exact Interaction context. A Hotspot maps pointer geometry to one semantic target:

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
Interactable Hotspots use either the sprite alpha footprint or normalized custom rectangles relative
to the complete Interactable sprite image. Every Hotspot retains a stable owner-local ID, label,
condition, input order, highlight policy, and semantic target.

The dependency graph indexes nested Feature ownership, Feature Trait/Property dependencies, Hotspot
targets, and owner-local Room Exit targets. There are no exact-Hotspot Interaction-context edges and
no authored-test Hotspot-activation edges because Hotspot identity is not a gameplay subject.

The compiled-project boundary remains `noveltea.compiled.project` version 4. Issue #70 is an atomic
replacement of the already-selected V4 contract; it does not introduce a schema-version bump. Compiled
Room/Interactable definitions contain nested Features, Interaction subjects include owner-qualified
Feature references, and Hotspots contain semantic targets instead of behavior activations.

Project-aware validation rejects duplicate Feature IDs, missing Feature owners, owner-local Feature
or Exit mismatches, incompatible Feature Trait/Property assignments, invalid target subjects,
unsupported image/mask combinations, incompatible highlight Materials, and invalid normalized bounds.

## Editor behavior

The shared React Hotspot image stage provides selection, create, move, resize, delete, zoom, pan,
fit, and image-coordinate conversion. Its normal interaction state has no persistent select/pan tool
switch. `Add hotspot` temporarily changes the next drag into rectangular creation, then returns to
normal interaction after a successful create; Escape or Cancel exits creation without mutation.

Hotspot editing chooses a semantic target rather than a Verb. Room targets include local Features,
other admitted subjects, and local Exits. Interactable targets additionally include the owning
Interactable directly. The target selector may also reference owner-qualified Features elsewhere in
the project when that is the intended semantic subject.

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

World presentation resolves immutable Hotspot projections in authored reference coordinates. Default
and custom highlights bind through the Material system using engine-owned image/mask samplers and
hover/press uniforms. `none` highlights remain semantically selectable and allocate no overlay
resources. Overlay ordering does not change semantic target identity.

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

## Lua, preview, debugger, and tests

Lua `Game.run_action` accepts Character, Interactable, and owner-qualified Feature subjects. Feature
Properties are available through the typed Feature Property helpers using `(owner_kind, owner_id,
feature_id, property_id)`. A Feature reference remains owner-qualified at every Lua/runtime boundary.

Runtime debug snapshots publish semantic clickable targets, not authored Hotspot definitions. A
clickable target is either a semantic subject plus label or a Room Exit plus label. Hidden, disabled,
absent, condition-false, or otherwise unavailable geometry does not publish an enabled target.

Preview command transport supports the same Feature subject shape used by runtime selection and
Interaction invocation. Recorder and authored-test playback store semantic `select-subjects`,
`run-interaction`, or `navigate` inputs. Two different Hotspots that map to the same Feature therefore
produce the same recorded/runtime subject identity.

Save state preserves owner-qualified Feature operands in yielding Interaction frames and Feature
Property overrides. It does not persist Hotspot invocation identity.

## Export and package behavior

Feature and Hotspot authoring data compile into strict `noveltea.compiled.project` version 4.
Referenced images, shader variants, Materials, and built-in Hotspot resources are included by the
existing closure and package writers. Runtime-generated custom masks remain derived resources rather
than independent authoring assets.

## Verification

The durable historical certification record for the original Hotspot implementation remains in
`docs/architecture/certifications/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_CERTIFICATION.md`.
The superseded implementation plan is archived in
`docs/archive/plans/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_IMPLEMENTATION_PLAN.md`; current behavior
is defined by this document and the entity/runtime documents referenced above.
