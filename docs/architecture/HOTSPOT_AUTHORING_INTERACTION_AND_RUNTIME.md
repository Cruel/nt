# Hotspot Authoring, Interaction, and Runtime

This document is the permanent cross-cutting contract for image-relative Room and Interactable
hotspots. Entity-specific field descriptions remain in `docs/engine/ROOM.md`,
`docs/engine/INTERACTABLE.md`, `docs/engine/INTERACTION.md`, and `docs/engine/VERB.md`.

## Authoring and compilation

Hotspots use normalized image coordinates. Room hotspots own rectangular shapes and may activate a
Verb or a Room exit. Interactable hotspots inherit the Interactable image footprint and may use the
image alpha channel or an explicit binary custom mask. Every hotspot has stable identity, label,
condition, input order, highlight policy, and owner-qualified references. Mutations go through the
existing command bus so undo/redo, dirty state, dependency indexing, validation, and compilation
remain atomic.

Hotspot deletion, mode switching, and rename use the structural dependency graph's exact nested
hotspot edges. Interaction contexts and authoring-test `activate-hotspot` steps therefore participate
in the same reference preflight. Deletion or a destructive mode switch is blocked while either kind
of reference exists. Rename first verifies that the exact source hotspot still exists, then rewrites
the owner and every confirmed reference in one command transaction; stale rename commands produce no
patches.

The compiled-project boundary is strict and versioned. Image metadata is mandatory for image assets;
shader samplers declare explicit engine bindings; hotspot owner, activation, shape, and exact runtime
context are closed typed variants. Project-aware validation rejects missing owners, invalid Room exits,
unsupported image/mask combinations, incompatible material roles, and author assignments to
engine-bound hotspot samplers.

## Editor behavior

The shared React hotspot image stage provides selection, create, move, resize, delete, zoom, pan,
fit, and image-coordinate conversion. Its normal interaction state has no select/pan tool switch:
clicking a hotspot selects it, dragging a rectangular hotspot moves it, dragging a selected handle
resizes it, and dragging empty image space pans the camera. `Add hotspot` temporarily changes the
next drag into rectangular creation, then returns to normal interaction after a successful create;
Escape or the cancel action exits creation without mutation. The Room editor composes Room hotspot
editing with existing Interactable placement. The Interactable editor authors alpha/custom mask
behavior. Desktop gestures use lifetime-installed window mouse listeners so move/up remain reliable
when the cursor leaves SVG geometry or the stage. Minimum sizes, normalized clamping, and one command
transaction per completed gesture are required.
Focused Room preview remains protocol version 2 and deliberately receives no hotspot values or world
hotspot input. Play preview uses the ordinary compiled runtime, immutable presentation projection,
and typed activation path; no parallel editor-only runtime contract exists.

## Runtime resources and rendering

Texture preparation optionally retains one-bit alpha occupancy in prepared CPU residency. Custom
masks are generated as binary `R8` resources by the typed asset preparation pipeline. Both participate
in normal request coalescing, cancellation, reservation, residency, eviction, telemetry, structured
prefetch, and mandatory publication gates. Direct-next Room prediction prefetches required hotspot
masks; demand joins in-flight prefetched work.

World presentation resolves immutable hotspot projections in authored reference coordinates. Default
and custom highlights bind through the material system using engine-owned image/mask samplers and
hover uniforms. `none` highlights remain semantic and allocate no overlay resources. Overlay ordering
is deterministic and does not alter input precedence.

## Input and activation

Host pointer coordinates are projected through the presentation transform. Presentation bars and
non-image owner margins are rejected. Rectangle containment is half-open on right and bottom shared
edges, while the global source-image edge remains reachable. Cross-owner precedence reuses the exact
committed world draw tuple; within one owner, higher `inputOrder` wins and the lexicographically
smallest hotspot ID breaks a tie. Rectangular Room shapes, Interactable alpha occupancy, and custom
rectangles use the same projected reference-space point. A hit emits one owner-qualified hotspot
activation and stops lower gameplay pointer routing.

RmlUi and mounted Layout admission runs before world hit testing. Only the primary mouse button or
first active touch can capture; activation movement slop is exactly eight host CSS pixels and release
must remain inside the captured target. UI admission changes, focus/window/touch cancellation,
presentation replacement, reset, pause, and shutdown clear transient hover/press/capture state without
activation.

Every committed presentation-generation change invalidates an existing pointer gesture even when an
identically qualified hotspot remains at the same coordinates. Mouse hover may be recomputed from the
new committed frame, but the old press/capture is never transferred to the replacement frame.

Activation is admitted by the existing runtime command gateway. It validates active Room ownership,
current visibility/enabled state, condition truth, and exact hotspot identity. Verb activations enter
the canonical Interaction resolver with exact hotspot context; Room-exit activations reuse canonical
navigation and transition processing. Lua, RmlUi, editor preview, debugger, and recorded playback all
route through the same typed activation command.

Play-preview player-input controls are projected from the current runtime presentation rather than
from the authored project. The debug snapshot exposes only hotspots whose owner is currently
presented and whose condition and activation availability are true. Recorder actions are appended
only after the typed runtime command reports success, so a rejected or stale hotspot activation is
not persisted into an authoring test.

## Export and package behavior

Hotspot authoring data compiles into strict `noveltea.compiled.project` version 4. Referenced images, shader
variants, materials, and built-in hotspot resources are included by the existing closure and package
writers. Runtime-generated custom masks are derived resources and are not serialized as independent
authoring assets. Web and Android fixture materialization must work without caller-supplied output
roots; explicit CI roots remain supported.

## Verification

The durable certification record is
`docs/architecture/certifications/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_CERTIFICATION.md`.
Historical sequencing and implementation findings are archived in
`docs/archive/plans/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_IMPLEMENTATION_PLAN.md`.
