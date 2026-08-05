# Room Component

## Contract

A `RoomDefinition` is immutable compiled gameplay content. It owns its background, image-relative
hotspots, conditional
world-overlay Layout mounts, declarative cast, props, and reconstructible environment loops, optional typed composition Script hook,
description, ordered enter/leave hooks, exits, and generic `RoomPlacement` anchors. A Room may `extends`
another Room only for declared custom-property lookup; exits, placements, overlays, resources, and
programs do not merge.

`SessionState` owns mutable Room state: the active and previous Room, visit counts, presentation
state, and sparse property overrides. Categories, tags, selections, graph coordinates, and preview
state are editor-only metadata.

## Navigation and lifecycle

The sole Room-transition path is `FlowExecutor`. It validates the source/target and ordered
before-leave, before-enter, after-leave, and after-enter hooks. The Room switch, visit increment, and
view publication occur at the defined commit point. Failed pre-commit work resumes the source;
post-commit fault handling preserves the target. Yielding effects retain their exact lifecycle stage
and effect index.

Every exit has a stable ID and a typed target Room. Lua, Map, player, editor playback, and tests all
lower navigation into the same typed input and lifecycle transaction.

Room hotspots have stable IDs within their Room, normalized rectangular image bounds, a condition,
signed input priority, highlight policy, and either a zero-arity Verb or one of the Room's exits.
Exit activation reuses the selected-exit navigation path above; it does not create a second
transition or lifecycle implementation. Exact hotspot activation enters runtime only through the
owner-qualified typed activation input.

The final animated request contract is `RoomNavigationTransitionOperation`. It is deliberately
distinct from `SceneTransitionGroupOperation`, but both embed the same
`FinitePresentationOperationCommon`: operation ID, positive duration, skippability, gameplay clock,
and exact source/target `PresentationSnapshotRevision` binding. The navigation target carries the
source Room when present and the target Room, and the request always carries an exact
`PresentationFlowCompletion`; animated Room navigation is therefore a `CausalBarrier`. `Fade` and
`Dissolve` are finite kinds, while `Cut` is immediate and allocates no lifecycle.

The live navigation executor prepares and publishes the complete destination presentation snapshot,
submits the exact operation through the engine-owned presentation bridge/coordinator, and suspends
Flow on the matching completion identity. Failure before the commit point restores the source;
cancellation or backend failure after commit preserves the committed target without fabricating a
successful completion.

## Placements and view

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

The current version-3 authoring schema uses strict Room records with typed descriptions,
conditions/effects, exits and optional
transition overrides, placements, cast, props, environment loops, overlays, and composition hooks. Validation rejects
duplicate nested IDs, stale Room/Character/Layout/resource/Script references, invalid placement
ownership, invalid pose/expression/idle combinations, invalid environment resources/opacity/planes,
invalid transitions, bounds, and hook data. The
compiled transition precedence contract is explicit request, selected exit override, then project
default. Live realization uses the final revision-bound Room-navigation operation contract described
above.

The Room editor uses the shared React image stage for hotspot create/move/resize/delete and composes it
with command-backed Interactable placement editing. Room background `cover`, `contain`, `stretch`, and
`center` transforms use the same normalized image-coordinate policy consumed by runtime projection.
No editor-preview-only manipulation contract exists.

## Editor preview

Derived Room preview is graph-backed and does not compile or load a complete project or runtime
package. The editor queries the current Room closure, including incoming Character and Interactable
placement relationships, and builds one strict `noveltea.room-preview` document plus an explicit
hash-verified resource manifest. The document carries deterministic preview query state, resolved
non-Lua text, deferred condition/text expressions, composition source, exact material metadata,
mounted Layout definitions, Game HUD state, and the native display environment.

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
- `tests/core/session_state_tests.cpp` covers Room state, placements, and property inheritance.
- `tests/core/save_state_tests.cpp` covers definition-derived Room-loop reconstruction, scoped
  environment persistence, stale-owner/missing-resource rejection, and failure-atomic restore.
- `tests/render/world_presentation_tests.cpp` covers typed environment realization and phase-zero
  backend restart.

Legacy Room/Object/Map records, raw hook scripts, controller bridges, and runtime exporters are not
supported paths.
