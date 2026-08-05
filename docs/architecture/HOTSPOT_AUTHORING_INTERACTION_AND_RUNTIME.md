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

The compiled-project boundary is strict and versioned. Image metadata is mandatory for image assets;
shader samplers declare explicit engine bindings; hotspot owner, activation, shape, and exact runtime
context are closed typed variants. Project-aware validation rejects missing owners, invalid Room exits,
unsupported image/mask combinations, incompatible material roles, and author assignments to
engine-bound hotspot samplers.

## Editor behavior

The shared React hotspot image stage provides selection, create, move, resize, delete, zoom, pan,
fit, and image-coordinate conversion. The Room editor composes Room hotspot editing with existing
Interactable placement. The Interactable editor authors alpha/custom mask behavior. Pointer capture,
minimum sizes, normalized clamping, and one command transaction per completed gesture are required.
Focused previews receive complete immutable payloads through the existing preview host protocol; no
parallel editor-only runtime contract exists.

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
half-open outer edges are rejected. Eligible hotspots are tested in descending input order with stable
declaration order as the tie-break. Rectangular Room shapes, Interactable alpha occupancy, and custom
binary masks use the same projected reference-space point. A hit emits one owner-qualified hotspot
activation and stops lower gameplay pointer routing.

Activation is admitted by the existing runtime command gateway. It validates active Room ownership,
current visibility/enabled state, condition truth, and exact hotspot identity. Verb activations enter
the canonical Interaction resolver with exact hotspot context; Room-exit activations reuse canonical
navigation and transition processing. Lua, RmlUi, editor preview, debugger, and recorded playback all
route through the same typed activation command.

## Export and package behavior

Hotspot authoring data compiles into the normal V2 project document. Referenced images, shader
variants, materials, and built-in hotspot resources are included by the existing closure and package
writers. Runtime-generated custom masks are derived resources and are not serialized as independent
authoring assets. Web and Android fixture materialization must work without caller-supplied output
roots; explicit CI roots remain supported.

## Verification

The durable certification record is
`docs/architecture/certifications/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_CERTIFICATION.md`.
Historical sequencing and implementation findings are archived in
`docs/archive/plans/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME_IMPLEMENTATION_PLAN.md`.
