# Room Component

## Contract

A `RoomDefinition` is immutable compiled gameplay content. It owns its background and overlays,
description, ordered enter/leave hooks, exits, and `RoomPlacement` records. A Room may `extends`
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

## Placements and view

An Interactable's geometry is a nested `RoomPlacement`, while the Interactable's unique mutable
location, enabled state, and visible state live in `SessionState`. A placement cannot transfer
ownership or create a second location.

`RoomView` publishes visit count, resolved description text/markup, background, overlays, placement
bounds and labels, live Interactable state, and resolved exits. RmlUi and other presentation code
consume this value view only; they do not own navigation, flow, or saves.

## Authoring and validation

The V2 editor uses strict Room records with typed descriptions, conditions/effects, exits, placements,
and overlays. It supports creation, editing, ordering, deletion, preview, undo/redo, and save/reload.
Validation rejects invalid same-type inheritance, duplicate nested IDs, invalid Room/Interactable/Layout
references, invalid bounds, and invalid hook conditions/effects. Preview state remains outside runtime
content.

## Implementation evidence

- `CompiledProject`, `SessionState`, `FlowExecutor`, and `TypedRuntimeSession` own final runtime
  loading, state, execution, and input/output behavior.
- `tests/core/flow_executor_tests.cpp` covers hook ordering, commit behavior, and failed transitions.
- `tests/script/typed_room_execution_tests.cpp` and
  `tests/script/typed_runtime_session_tests.cpp` cover Room views, navigation, and typed inputs.
- `tests/core/session_state_tests.cpp` covers Room state, placements, and property inheritance.

Legacy Room/Object/Map records, raw hook scripts, controller bridges, and runtime exporters are not
supported paths.
