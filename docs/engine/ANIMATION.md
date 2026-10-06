# Animation Resource

## Purpose and current status

Animation is immutable reusable raster content, separate from source Assets and gameplay identities.
The first tracer (#394) supports named sprite-sequence motions and closed image/Animation Visual
references on Room Environments. Interactable presentation also selects canonical image/Animation
Visuals (#395), including current-frame `visual-alpha` hit testing. Character Pose layers and sparse
Expression/Appearance/CharacterAnimationClip overrides also select Visuals (#396); Character semantic
composition and choreography remain separate from reusable Animation content.

## Authoring and validation

Records live in the `animations` collection and segmented workspace `records/animations/` directory.
The authoritative shape is
[`authoring-animations.ts`](../../editor/src/shared/project-schema/authoring-animations.ts).
An Animation owns one stable logical canvas, a default motion, and Animation-local unique motion IDs.
Every motion contains one or more Image Asset frames with explicit positive integer millisecond
durations; a one-frame motion is valid. The default and any use-site selected motion must exist.
Asset references participate in the ordinary dependency graph, rename/delete safety, validation,
compilation, and resource closure. Localization remains at the Asset layer.

## Runtime and preview

Compilation emits a separate Animation resource table, not an Asset kind. Room Environments select
an image or Animation Visual; a null motion selection uses the resource default. Placement, opacity,
Material, and clock remain Environment concerns. For this tracer, selected motions loop as
reconstructible Environment presentation.

`StructuredPrefetch` expands the selected motion into ordinary Image Asset dependencies. Mandatory
publication pins all selected frames and the Engine2D Material before realization.
`AssetWorldPresentationResourceResolver` resolves those leases, and `WorldPresentationBackend`
samples the texture through the existing raster quad/Engine2D Material path. Source frame dimensions
do not change occurrence placement.

See [Animation and Tweening](../rendering/ANIMATION_AND_TWEENING.md#raster-animation-realization)
for epoch ownership and reconstruction, and
[preview communication](../editor/preview/ENGINE_PREVIEW_COMMUNICATION.md#editor-managed-authoring-previews)
for focused publication (the focused-document section describes the owning transport).

## Editor behavior and known gaps

Animation records currently use Project source/record editing; there is no Animation wizard or
specialized timeline editor in this tracer. Focused Room preview stages the referenced Environment, Interactable, and Character-layer Animations
and their frame Assets through production focused resource preparation, not a browser animation
interpreter. Temporary Environment `asset` input remains for the explicitly scoped expand-contract
slice; Visual takes precedence during realization.

Video, finite motion operations, transient playback controls, mutable desired motion, animated
Inventory icons, and broader sprite-field cutover remain later work. Interactable world Hotspots can
already sample a selected raster Animation frame's CPU coverage.

## Verification

Feature Lab's **World Composition → Reusable Animation occurrences** check shows two Environment
occurrences sharing `guide-expression-loop`, using gameplay and unscaled clocks. Its `still` motion
is a one-frame source example. The catalog carries the manual procedure; added coverage is not a claim
that every interactive check has been performed.

- Editor schema/compiler/dependency/Room-preview tests cover authoring and focused staging.
- Native preview protocol tests reject malformed resources and missing motion selections.
- `tests/assets/structured_prefetch_tests.cpp` exercises selected-frame mandatory publication,
  production lease resolution, and raster texture sampling.
- `tests/host/layout_realizer_tests.cpp` exercises focused publication, republish phase retention,
  and missing-manifest rejection through the real resolver/backend.
- `tests/render/world_presentation_tests.cpp` covers independent occurrences, retained incompatible
  revisions, prepared publication, clocks, and reconstruction.

The tracer was verified with Linux CTest, Linux/Web C++ policy and formatting checks, Web structural
smoke, editor check/build/tests, and scoped ASan/UBSan decoder/presenter/resource/renderer tests.
Feature Lab package export (acknowledging its existing localization warnings) and a 300-frame native
World Composition rendering capture passed using a disposable direct-start package variant. This
certifies the production rendering path, not manual pause/re-entry interaction or the complete editor
application workflow; those remain catalog checks.
