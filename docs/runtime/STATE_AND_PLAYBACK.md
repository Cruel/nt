# Runtime State and Playback

## Target contract

`RuntimeSessionHost` owns one immutable `CompiledProject` by value, one `FlowExecutor`, and mutable `SessionState`. Top-level gameplay mode is exactly Room, Flow, or Ended. Loading/error UI is host state, not persisted gameplay mode.

`SessionState` owns typed globals, property overrides, active frames and stable cursors, visits/history/show-once markers, actor state, unique Interactable state/location, queues, timers, and logical waits. Definitions and decoded JSON are never mutable state.

`SaveState` is an explicitly versioned subset. It stores logical progress and stable flow positions, not renderer, RmlUi, audio backend, tween, or Lua VM state. Save-policy property overrides serialize once on their actual owner; inherited values and Session-policy overrides do not. Explicit duration waits save remaining logical time. Visual/audio operations restore to logical post-step state.

Manual save fails with typed diagnostics at nonserializable suspension points. Autosaves occur only at compiler-marked safe points after associated effects complete. Engine-defined serializable wait tokens are the only saveable script suspensions.

## Flow and startup

Entrypoint is exactly Room, Scene, or Dialogue. A separate synchronous startup Lua hook must succeed before it begins. `SessionState` owns the authoritative stack and blocker, while one `FlowExecutor` is the sole mutation service for Scene, Dialogue, Interaction, and RoomTransition frame variants. Child Scene/Dialogue calls advance the caller before pushing and Return resumes it; terminal Scene/Dialogue targets tail-replace, Room targets begin the shared Room transition pipeline, and End clears flow according to the fixed continuation contract.

Playback, RmlUi, editor preview, tests, debugger, and C ABI adapters decode boundary input into typed internal commands and expose typed events/views. Internal command/event/state payloads contain no JSON.

## Additive typed kernel state

Phases 6A and 6B add a JSON-free `SessionState` and execution kernel beside the shipped path. Session
creation initializes declared variables and one typed entrypoint frame: Scene and Dialogue roots use
`NoReturn`, while Room entry starts the shared pre-entry `RoomTransitionFrame`. The public mode,
stack, blocker, and fault views are read-only; `FlowExecutor` is the only mutation service after
initial construction.

The session-owned `FlowStack` is a closed Scene/Dialogue/Interaction/RoomTransition variant with
opaque fresh frame IDs, stable typed positions, and Caller/ResumeRoom/NoReturn destinations. Child
calls validate and advance their caller before an atomic push. Return, terminal tail replacement,
Room transition, rejection, completion, and End enforce the fixed mode/stack contract. Owner-bound
blockers require an exact frame, handle, and kind match. Execution faults are fail-stop without an
Error gameplay mode, and explicit discard selects the captured Room, the pre/post-commit transition
Room, or Ended according to the frame contract. The bounded non-reentrant driver currently returns a
typed not-yet-migrated fault for positive-budget feature execution; Phase 7 owns those frame visitors.

`PropertyResolver` remains the sole typed property read/mutation path for this state. It validates the
property declaration, owner existence and kind, nullability, enum membership, scalar type, and finite
numbers. Reads traverse the immutable same-type parent indexes directly in runtime-override,
authored-assignment order at each level, then use the declaration default or return a typed missing
value. Overrides remain sparse on their actual owners, so ancestor changes are immediately visible
without a resolved-value cache.

This path is test-facing and additive. Feature execution, script invocation, persistence, concrete
host request queues, and consumer cutover remain owned by later phases. It does not adapt compiled
data back into legacy data or reroute Engine, preview, package launch, editor playback, Lua, or
runtime UI consumers.

## Current scaffold

The shipped path still uses `GameSession`, `RuntimeController`, JSON-bearing `RuntimeInput`/`RuntimeOutput`, `SaveDocument`, controller snapshots, numeric entities, and `ProjectModel`. `RuntimeSessionHost::apply_input`, deterministic playback, slot-store abstraction, and editor test integration are useful seams to retain, but their payloads and internals are replaced in Phases 6--10.

Current save preservation of unknown legacy keys, fake player-object inventory locations, Script entrypoints, and controller JSON are temporary behavior, not future policy. Platform slot persistence and production save/load RmlUi remain deferred implementation work.

## Relevant consumers and tests

Consumers include Engine loading/ticking, RmlUi runtime UI, Lua execution, editor preview/test playback, debugger mutation/snapshots, and package players. Existing coverage includes runtime host/controller/session/save/editor API/UI-view tests and editor playback/export tests; later phases replace assertions as each seam migrates.

## Current input/output boundary to retain

The existing backend-neutral driving seam is
`RuntimeSessionHost::apply_input(const RuntimeInput&)`. Headless tests, editor preview injection, and
RmlUi actions already converge on it. Current inputs include lifecycle Start/Stop/Reset, deterministic
Tick, Continue, Dialogue choice, navigation, Object selection/clearing, Action execution, save load,
entrypoint changes, and editor test steps.

The concrete names and JSON-bearing payloads are transitional, but these properties are useful:

- mode-specific input validation happens in runtime code rather than UI handlers;
- invalid input returns `handled = false` plus diagnostics;
- all callers receive the same deterministic state transition path;
- recorded playback can reuse exactly the same input API.

`RuntimeInputResult` currently returns `handled`, a backend-neutral `RuntimeUIViewState`, deterministic
outputs, and diagnostics. `RuntimeSessionHost` translates internal `ControllerCommand` batches into
mode, script-request, notification, text-log, save-mutation, and view-update outputs. Phase 9 replaces
the string/JSON variants, not the host boundary or the principle that controllers do not directly
drive RmlUi/editor code.

## Current save behavior to migrate

The current host can snapshot `GameSession` plus controller state into `SaveDocument`, store/load
typed slot IDs through `SaveSlotStore`, and use `MemorySaveSlotStore` for tests and preview. Platform
file, browser, and Android persistence deliberately remains outside core.

Current saves preserve recognized legacy fields and unknown JSON keys, store controller data under
`_novelteaRuntime`, and represent inventory through a fake player/Object location. Object placement
falls back through save locations, project Room membership, then `startInv`.

Those representations are explicitly replaced, but the working capabilities must remain covered:

- snapshot and restore live progress;
- manual save/load and reserved autosave;
- stale-reference diagnostics;
- backend-neutral slot storage;
- save-backed Interactable placement;
- deterministic restoration of the active flow/UI view.

The target `SaveState` removes unknown-key preservation, fake entity locations, and controller JSON,
then represents the same capabilities with strong IDs, typed Interactable locations, typed flow
frames, and declared persistent properties.

## Current recorded playback behavior

`core::editor::RuntimePlaybackSession` currently accepts a `RuntimePlaybackSpec`, loads a project,
emits an initial zero-delta tick, and applies each recorded step through `RuntimeSessionHost`.
Non-tick inputs receive a zero-delta drain tick using the same playback-step index so queued controller
commands settle deterministically.

Project test records use `init`, `steps`, and `check`. Core records hook source and script-request
outputs; the engine/script layer may execute setup/check Lua and return diagnostics. Reports contain
pass/fail, per-step observations, outputs, diagnostics, final preview state, and stable JSON export.

This runner is a valuable acceptance harness for the migration. Each typed feature slice should
replace its assertions and payloads while preserving deterministic step execution and reportability,
rather than introducing a separate test-only runtime path.
