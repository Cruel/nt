# Room Component

## Contract

A `RoomDefinition` is immutable compiled gameplay content. It owns its background, owner-local
Features, image-relative Hotspots, conditional world-overlay Layout mounts, declarative cast, props,
and reconstructible environment loops, an optional typed composition Script hook, description,
ordered declarative enter/leave effect programs, direct Script Hook mappings, exits, and generic
`RoomPlacement` anchors. Room is a Property-bearing identity and may declare an ordered set of
owner-local typed Properties directly on the Room authoring record. Those Properties belong to the
exact Room identity, carry their own type/nullability/enum contract plus concrete authored Value,
and do not require a project-wide identity Property declaration. The same Property key may therefore
mean something unrelated on another Room. Rooms may also attach compatible Traits; Trait-backed
Properties derive their typed schema directly from those Trait contracts and compile as exact-owner
Property declarations for the Room runtime identity
slice and do not merge Features, exits, placements, overlays, resources, or programs.

A declared Room authoring record may attach one same-kind Archetype. The editor resolves the complete
single-base Archetype chain for editing and preview, stores instance edits as explicit overrides, and
materializes the effective Room configuration when the Archetype is detached. The compiler emits only
the flattened `RoomDefinition`; Archetypes never become runtime Room identities or mutable state.

`SessionState` owns mutable Room state: the active and previous Room, visit counts, presentation
state, and sparse Property overrides addressed by exact Room identity plus Property key. Categories,
tags, selections, graph coordinates, and preview state are editor-only metadata.

## Navigation and lifecycle

The current Room-transition path is `FlowExecutor`. It validates the source/target and ordered
before-leave, before-enter, after-leave, and after-enter declarative effect programs. Script Hook
selection is a separate frozen-registry contract: each Room may map supported lifecycle kinds to a
stable Script Module/named export, while Bootstrap may add exact, qualified-prefix, or catchall
mappings. #79 owns invoking those registry handlers in the canonical navigation lifecycle; #74 only
establishes and validates the deterministic registry boundary. The Room switch, visit increment, and
view publication occur at the defined commit point. Failed pre-commit work resumes the source;
post-commit fault handling preserves the target. Yielding effects retain their exact lifecycle stage
and effect index.

Every exit has a stable ID, a typed target Room, and a direction that is unique within its owning
Room, including `custom`. The built-in HUD presents one fixed control per direction; alternative
choices must therefore use distinct directions or another authored interaction surface. Lua, Map,
player, editor playback, and tests all lower navigation into the same typed input and lifecycle
transaction.

Room Features are stable semantic parts with IDs unique within their owning Room. A Feature may attach
compatible Traits and Properties and may appear as an exact Interaction subject through the
owner-qualified `(RoomId, FeatureId)` identity. Features are nested content, not a top-level
collection.

Room Hotspots have stable IDs within their Room, normalized rectangular image bounds, a condition,
signed input priority, highlight policy, and one semantic target. A Room Hotspot may select an
owner-local Feature, another exact admitted subject, or one of the Room's exits. Hotspots own no Verb
or Interaction behavior. Exit targets reuse the selected-exit navigation path above; subject targets
reuse ordinary semantic subject selection. Different Hotspots may intentionally select the same
Feature and therefore produce the same runtime subject identity.

The final animated request contract is `RoomNavigationTransitionOperation`. It is deliberately
distinct from `SceneTransitionGroupOperation`, but both embed the same
`FinitePresentationOperationCommon`: operation ID, positive duration, skippability, gameplay clock,
easing, and exact source/target `PresentationSnapshotRevision` binding. The navigation target carries the
source Room when present and the target Room, and the request always carries an exact
`PresentationFlowCompletion`; animated Room navigation is therefore a `CausalBarrier`. `Fade` and
`Dissolve` are finite kinds, while `Cut` is immediate and allocates no lifecycle.

The live navigation executor prepares and publishes the complete destination presentation snapshot,
submits the exact operation through the engine-owned presentation bridge/coordinator, and suspends
Flow on the matching completion identity. Failure before the commit point restores the source;
cancellation or backend failure after commit preserves the committed target without fabricating a
successful completion.

## Placements and view

Each Room also owns a logical `WorldPresentationSpace`. Its authored size defines camera coordinates,
its optional world-space bounds constrain framing, and its edge policy is either `contain` or
`overscan`. `contain` clamps the effective Camera View so rotated/zoomed framing remains inside the
authored bounds when possible; `overscan` allows the camera to reveal space outside them. The Room
owns one reconstructible default `CameraView { center, zoom, rotationDegrees }` plus zero or more
stable named Camera Views. These are presentation data only: changing camera coordinates never changes
Character or Interactable Location.

A Room may additionally own stable `RoomAnchor` regions. Anchors use normalized Room-space bounds and
exist only as reusable presentation targets. Captured Focus resolves an occurrence or Anchor once at
operation acceptance and stores those captured world bounds in the finite operation; it does not track
the source live while the effect is running.

A `RoomPlacement` is an occupant-free anchor with stable nested identity, normalized bounds,
presentation metadata, and deterministic order. Character and Interactable initial declarations may
reference the same valid anchor. Interactable location, enabled state, and visible state remain in
`SessionState`; the current Room view derives occupants by matching those locations and never stores
a hidden placement owner. Character and declarative Room-cast occupants are resolved through the
same Room-presentation resolver.

`RoomView` publishes visit count, resolved description text/markup, background, overlays, placement
bounds and labels, live Interactable state, and resolved exits. RmlUi and other presentation code
consume this value view only; they do not own navigation, flow, or saves.

Room environment records are immutable definition-derived desired presentation. Each record has a
stable nested `RoomEnvironmentId`, condition, optional image, required material, normalized bounds,
world plane/order, clock domain, UV scroll rate, opacity, and visibility. Room resolution derives
these records after load; they are not duplicated in save bytes. Runtime-selected environment records
with explicit presentation owners use the scoped desired-state path and are persisted separately.

## Authoring and validation

The current version-4 authoring schema uses strict Room records with typed descriptions,
conditions/effects, owner-local Features, semantic Hotspot targets, exits and optional transition
overrides, World Presentation Space, default/named Camera Views, Anchors, placements, cast, props,
environment loops, overlays, composition hooks, and required `scriptHooks` storage for zero or more
direct lifecycle handler mappings. The current compiled-project format atomically contains the resulting
Room shape: every producer emits World Presentation Space and Anchor fields, and both TypeScript and native
consumers require that same shape. The canonical default remains a
1920×1080 centered View with no Anchors. Validation
rejects duplicate nested IDs, stale Room/Character/Interactable/Feature/Layout/resource/Script
references, incompatible Feature Trait/Property assignments, invalid owner-local Feature or Exit
Hotspot targets, invalid placement ownership, invalid pose/expression/idle combinations, invalid
environment resources/opacity/planes, invalid transitions, bounds, direct Script Hook module references/exports, and hook data. The compiled
transition precedence contract is explicit request, selected exit override, then project default.
Live realization uses the final revision-bound Room-navigation operation contract described above.

The Room editor uses the shared categorized-editor shell also used by Settings and Project Settings.
General, Camera, Composition, Hotspots, Navigation, Contents, and Behavior categories keep only the
selected group mounted, retain the selected category as Room tab state, and route workbench targets
to their owning category before reveal. Camera edits the logical presentation-space size, optional
bounds, Contain/Overscan policy, default/named Views, and Anchors; focused Room preview consumes the
same values immediately. Composition contains the command-backed Interactable placement editor.
Hotspots contains both nested Feature authoring and the shared React image stage. Feature editing
covers stable ID, label, compatible Traits, and compatible Properties. The image stage uses direct
manipulation: click a Hotspot to select it, drag a rectangular Hotspot or its handles to move/resize
it, drag empty image space to pan, and use the temporary `Add hotspot` action to draw one new rectangle
before returning to normal interaction. The selected Hotspot edits geometry, condition, highlight,
input order, and semantic target rather than a Verb activation.
Room background `cover`,
`contain`, `stretch`, and `center` transforms use the same normalized image-coordinate policy consumed
by runtime projection. No editor-preview-only manipulation contract exists.

## Editor preview

Derived Room preview is graph-backed and does not compile or load a complete project or runtime
package. The editor queries the current Room closure, including incoming Character and Interactable
placement relationships, and builds one strict `noveltea.room-preview` document plus an explicit
hash-verified resource manifest. The document carries deterministic preview query state, resolved
non-Lua text, deferred condition/text expressions, composition source, exact material metadata,
World Presentation Space, current Camera View, Anchors, mounted Layout definitions, Game HUD state,
and the native display environment.

The native `FocusedPreviewPresenter` prepares typed asset leases, an isolated Lua environment,
focused query capabilities, Layout realizations, RuntimeUI values, passive input, and a complete
`RuntimePresentationSnapshot`. World, Layout, UI, environment, and resource ownership commit as one
focused-owner swap. A failed or superseded candidate releases its temporary state and cannot disturb
the prior same-root visual. Room-to-Room and Room-to-Layout/Shader changes use the same pooled-host
generation and freshness rules as other focused previews.

The Room editor presents exit destinations through the shared searchable record selector filtered to
Rooms, so large projects can find targets by room name, ID, or tag without rendering every Room in a
field menu. Exit directions use a compact visual compass selector for the eight directional values
and the custom-direction value. The Exits heading lists each destination as a link that opens or
focuses that Room’s editor tab. The card has no separate heading row; its centered compass sits on
the left, the delete action is centered at the far right, and the remaining fields use inline labels
in the content column between them. Availability uses a condition-type dropdown and only reveals the
condition-specific Lua or variable controls when needed. When a destination Room has no exit back to
the source in the opposite direction, the exit card warns the author and can add that reciprocal exit
to the destination Room as an undoable manual-save edit. If a return exit already targets the source
but uses a different direction, the warning identifies the mismatch and can correct the existing
exit instead of adding a duplicate.

## Implementation evidence

- `CompiledProject`, `SessionState`, `FlowExecutor`, and `runtime::RuntimeSession` own final runtime
  loading, state, execution, and input/output behavior.
- `tests/core/flow_executor_tests.cpp` covers hook ordering, commit behavior, and failed transitions.
- `tests/script/typed_room_execution_tests.cpp` and
  `tests/script/typed_runtime_session_tests.cpp` cover Room views, navigation, and typed inputs.
- `tests/core/session_state_tests.cpp` covers Room state, placements, Trait-backed Property resolution,
  and owner-local overrides.
- `tests/core/save_state_tests.cpp` covers definition-derived Room-loop reconstruction, desired Camera
  View persistence without interpolation progress, scoped environment persistence,
  stale-owner/missing-resource rejection, and failure-atomic restore.
- `tests/core/presentation_coordinator_tests.cpp` covers typed Camera operation validation,
  replacement, skippability, and checkpoint classification.
- `tests/render/world_transition_tests.cpp` covers exact-revision Camera View interpolation and
  temporary Focus/Flash realization over unchanged desired framing.
- `tests/render/world_presentation_tests.cpp` covers typed environment realization and phase-zero
  backend restart.

Legacy Room/Object/Map records, raw hook scripts, controller bridges, and runtime exporters are not
supported paths.
