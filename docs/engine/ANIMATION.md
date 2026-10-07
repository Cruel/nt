# Animation Resource

## Purpose and current status

Animation is immutable reusable raster content, separate from source Assets and gameplay identities.
Phase 1 has one canonical image/Animation Visual contract across Room Environments, Interactable
presentation, and Character visual layers. Interactables use current-frame `visual-alpha` hit testing,
while Character semantic composition and choreography remain separate from reusable Animation content.

## Authoring and validation

Records live in the `animations` collection and segmented workspace `records/animations/` directory.
The authoritative shape is
[`authoring-animations.ts`](../../editor/src/shared/project-schema/authoring-animations.ts).
An Animation owns one stable logical canvas, a default motion, and Animation-local unique motion IDs.
Usable motions contain one or more Image Asset frames with explicit positive integer millisecond
durations; a one-frame motion is valid. The default and any use-site selected motion must exist.
Asset references participate in the ordinary dependency graph, rename/delete safety, validation,
compilation, and resource closure. Localization remains at the Asset layer.
Empty manual Animations start with a `default` motion with no frames. They are saveable authoring
drafts with a warning, omitted from compiled resources, and rejected when selected as a Visual.
Adding an Image frame in the timeline makes the draft usable; partially empty multi-motion resources
remain validation errors.

## Raster import

The Animations category context menu offers **Import Animation…** beside ordinary **Create Animation**.
Select a naturally filename-ordered image sequence (equal oriented dimensions), one GIF, or one APNG
(`.png` or `.apng`). Sequence frames receive explicit 100 ms durations, editable in the timeline.
GIF frame delays are retained; APNG rational delays are rounded cumulatively to integer milliseconds,
with a 1 ms minimum. A zero source delay uses the sequence/fallback duration. Source loop counts do
not become runtime policy. Other animated containers are not admitted by this workflow.

Main-process import coalesces disposal/blending and normalizes every sample into a full-canvas RGBA
PNG. Existing Sharp handles still images and composited GIF pages; the bounded APNG adapter rebuilds
PNG subframes and composites them without a new dependency. Limits live in
`editor/src/main/services/raster-import-limits.ts`; source input is limited to 128 MiB.
All generated frames and original bytes are staged by one workspace transaction. The existing
`asset.importFiles` command inserts Image Assets, preserved binary source Assets, and the Animation
atomically, using ordinary structural persistence and file trash/restore on Undo/Redo.

The optional record-level `import` field (see `authoring-records.ts`) stores ordered original names,
project-relative preserved source paths and hashes, import time, format, and fallback duration. These
paths/bytes plus the canonical editable frame data support provenance and rerunning import; there is
no automatic source watcher/reimport overwrite. Provenance is not Animation runtime data or playback
authority. Original source Assets are excluded from default dependency-pruned packages; generated
Image Assets use ordinary localization, focused staging, dependency safety, and package preparation.
The timeline shows provenance and allows manual image-frame insertion and logical canvas editing.

## Runtime and preview

Compilation emits a separate Animation resource table, not an Asset kind. Room Environments select
an image or Animation Visual; a null motion selection uses the resource default. Placement, opacity,
Material remains a use-site concern. Animation Visuals carry required nullable `playback`: null
uses the use site's default loop, rate 1, semantic start, and clock (Environment clock or gameplay).
Explicit policy selects once/loop, positive finite rate, gameplay/unscaled-presentation clock, and
nullable semantic `initialMarker`, and optional `loopRange: { start, end }` naming markers.
A range is valid only with loop repetition and strictly increasing resolved marker times. Without a
range, looping wraps the whole motion. With a range, playback traverses any initial intro before the
exclusive range endpoint once, then wraps to its start. Once holds the final sample.
Motion-local `markers` are required arrays of unique non-reserved IDs and absolute integer `timeMs`
within the motion; `start` and `end` are implicit markers. Markers never invoke gameplay.

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

Animation records open a specialized timeline editor with motion selection, absolute-time markers,
frame-duration editing, scrub/play/pause/restart, and sprite frame stepping. Reserved start/end
markers are shown but cannot be edited. Preview-only loop ranges use the same canonical sampling
rules as runtime through `editor/src/shared/animation-timeline.ts`. This lightweight source-image
preview is explicitly labeled, not certified runtime rendering. Interactable Visual editing also
exposes durable playback policy, initial marker, rate/clock, and marker-bounded loop selection;
loop policy is never stored on the reusable Animation resource. Project edits use the normal command
bus, undo/redo, and manual-save record unit. Tab restoration keeps authoring view position but never
a running playback anchor. Focused Room preview stages the referenced Environment, Interactable, and Character-layer Animations
and their frame Assets through production focused resource preparation, not a browser animation
interpreter. Room Environments author and compile only nullable `visual`; the temporary image `asset`
expand-contract field is retired and rejected rather than aliased.

Interactable Definition and exact Instance targets admit owner-scoped `DesiredMotionSelection`,
through the Presentation command gateway and Lua `set_motion_selection` / `clear_motion_selection`.
An exact Instance selection precedes the Definition selection; within a target, active owner scope
uses the same precedence as Material selection. Invalid targets, motions, policies, and markers fail
without mutating prior intent. Owner expiry removes its records. Character Profile/Pose/Expression/
Appearance/idle state remains unchanged; no universal motion state is added to gameplay instances.

Save/checkpoint records contain only admitted owner, target, motion, and policy. Immutable snapshots
carry the selected Animation Visual/policy, never phase, frame, pause/seek anchors, or decoder state.
Compatible occurrences retain backend epochs across unrelated and prepared publications. Motion or
policy replacement, Room re-entry, reset/load, and reconstruction start at semantic start/marker.

Explicit reusable playback policy is admitted on ordinary Environment, Interactable, and resolved
Character-layer Visuals, not Character clip-frame Visual overrides: those retain choreography timing
and require null playback until an explicit coordination contract is implemented.

Finite named motion is coordinated through the ordinary Presentation Operation lifecycle. `PlayMotion`
temporarily replaces one exact Environment, Interactable-placement, or Character-layer occurrence
with a named motion and leaves the underlying desired Visual/motion/policy untouched.
`TransitionMotion` requires its durable target motion to already be present in the exact target
snapshot revision, then realizes an operation-local transition motion over that committed target.
Finite motion is once-only, uses gameplay or unscaled-presentation time, admits a positive rate and
optional initial marker, and derives its deterministic duration from the selected motion endpoint.
Loop ranges are not finite-operation semantics.

The coordinator remains authoritative for replacement, skip/cancel, checkpoint barriers, and
terminal acknowledgement. The world backend owns only prepared temporary samples and progress.
Required finite-motion frames join the existing mandatory publication gate before delivery, so a
causal operation cannot begin with an unprepared motion. The final authored sample must be realized
successfully before completion is acknowledged. While a finite motion owns an occurrence, transient
pause/restart/seek controls are rejected rather than mutating the underlying playback anchor.

`WorldPresentationBackend::control_motion` targets one live `WorldVisualOccurrence` with typed
pause, resume, restart, seek-time, or seek-frame commands; `motion_position` exposes sprite frame
index/count and motion time. Static Visuals fail with `Unsupported`, absent occurrences with
`MissingOccurrence`, and non-finite/out-of-bounds addressing with `InvalidPosition`, without
mutating prior realization. Restart uses the authored initial marker and preserves pause status.
Compatible publication/prepared swaps retain control anchors; selection replacement, disposal,
reset/load/reconstruction discard them. These are host/backend controls, not new durable Lua
commands. Finite named-motion operations are separate coordinator-owned requests and transient
controls cannot override them.

Custom Interactable Hotspots may own motion-local normalized rectangle tracks without putting
interaction data on the reusable Animation resource. Runtime samples those tracks from the same
backend-local motion phase used for the realized raster frame: missing tracks use static bounds,
`hold` and `linear` are the initial interpolation modes, and inactive samples do not hit. Hotspot
Focus uses the shared authoring timeline helpers for play/pause/scrub/frame-step/marker inspection and
can author keys for any motion in the selected Animation.

Video and animated Inventory icons remain later work. The Phase 1 world-presentation sprite-to-Visual
cutover is complete, and Interactable world Hotspots can already sample a selected raster Animation
frame's CPU coverage.

## Verification

Feature Lab's **World Composition → Reusable Animation occurrences** check shows two Environment
occurrences sharing `guide-expression-loop`, using gameplay and unscaled clocks. Its `still` motion
is a one-frame source example. The catalog carries the manual procedure; added coverage is not a claim
that every interactive check has been performed.

Feature Lab's Hotspots & Cursors contextual Inventory exposes once/rate/clock/initial-marker
selection and clearing for the alpha board (`desired-motion`), including an authored marker-bounded
range that excludes the first/last half-frame segments. This is a manual procedure, not a
claim of completed save/load or player interaction certification.

- Editor schema/compiler/dependency/Room-preview tests cover authoring and focused staging.
- `raster-animation-import.test.ts` covers sequence ordering, GIF timing, APNG poster/blend/disposal,
  invalid-input atomicity, source preservation, imported/manual compiled equivalence, focused closure,
  localized frames, and dependency-pruned package preparation. Editor component/command tests cover
  import entry points, empty manual creation, frame insertion, and atomic Undo. Existing Feature Lab
  sprite-motion checks cover the normalized runtime result; import itself is editor-only.
- Native preview protocol tests reject malformed resources and missing motion selections.
- `tests/assets/structured_prefetch_tests.cpp` exercises selected-frame mandatory publication,
  production lease resolution, and raster texture sampling.
- `tests/host/layout_realizer_tests.cpp` exercises focused publication, republish phase retention,
  and missing-manifest rejection through the real resolver/backend.
- `tests/render/world_presentation_tests.cpp` covers independent occurrences, retained incompatible
  revisions, prepared publication, clocks, and reconstruction.
- `tests/render/world_transition_tests.cpp` covers finite play/transition realization, endpoint
  completion, desired-state restoration, backend failure, reset, and transient-control exclusion.
- `tests/core/presentation_coordinator_tests.cpp` covers finite-motion target replacement,
  placement identity, skip/cancel, barrier classification, and clock/policy validation.
- `tests/assets/structured_prefetch_tests.cpp` covers exact-target-revision mandatory preparation,
  missing motion rejection, and asynchronous readiness before finite delivery.

The tracer was verified with Linux CTest, Linux/Web C++ policy and formatting checks, Web structural
smoke, editor check/build/tests, and scoped ASan/UBSan decoder/presenter/resource/renderer tests.
Feature Lab package export (acknowledging its existing localization warnings) and a 300-frame native
World Composition rendering capture passed using a disposable direct-start package variant. This
certifies the production rendering path, not manual pause/re-entry interaction or the complete editor
application workflow; those remain catalog checks.
