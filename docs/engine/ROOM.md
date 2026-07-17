# Room Component

## Contract

A `RoomDefinition` is immutable compiled gameplay content. It owns its background, conditional
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

The V2 editor uses strict Room records with typed descriptions, conditions/effects, exits and optional
transition overrides, placements, cast, props, environment loops, overlays, and composition hooks. Validation rejects
duplicate nested IDs, stale Room/Character/Layout/resource/Script references, invalid placement
ownership, invalid pose/expression/idle combinations, invalid environment resources/opacity/planes,
invalid transitions, bounds, and hook data. The
compiled transition precedence contract is explicit request, selected exit override, then project
default. Live realization uses the final revision-bound Room-navigation operation contract described
above.

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
