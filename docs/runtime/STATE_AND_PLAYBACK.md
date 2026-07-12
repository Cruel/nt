# Runtime State and Playback

## Target contract

`RuntimeSessionHost` owns one immutable `CompiledProject` by value, one `FlowExecutor`, and mutable `SessionState`. Top-level gameplay mode is exactly Room, Flow, or Ended. Loading/error UI is host state, not persisted gameplay mode.

`SessionState` owns typed globals, property overrides, active frames and stable cursors, visits/history/show-once markers, actor state, unique Interactable state/location, queues, timers, and logical waits. Definitions and decoded JSON are never mutable state.

`SaveState` is an explicitly versioned subset. It stores logical progress and stable flow positions, not renderer, RmlUi, audio backend, tween, or Lua VM state. Save-policy property overrides serialize once on their actual owner; inherited values and Session-policy overrides do not. Explicit duration waits save remaining logical time. Visual/audio operations restore to logical post-step state.

Manual save fails with typed diagnostics at nonserializable suspension points. Autosaves occur only at compiler-marked safe points after associated effects complete. Engine-defined serializable wait tokens are the only saveable script suspensions.

## Flow and startup

Entrypoint is exactly Room, Scene, or Dialogue. A separate synchronous startup Lua hook must succeed before it begins. One `FlowExecutor` runs Scene, Dialogue, Interaction, and RoomHook frame variants. Child Scene/Dialogue calls push and Return resumes; terminal targets tail-replace, enter Room, Return, or End according to the fixed continuation contract.

Playback, RmlUi, editor preview, tests, debugger, and C ABI adapters decode boundary input into typed internal commands and expose typed events/views. Internal command/event/state payloads contain no JSON.

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
