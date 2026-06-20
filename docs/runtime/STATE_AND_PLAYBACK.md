# State and Playback

## Purpose

Define how runtime state, controller progression, entrypoints, save restoration, playback stepping, and UI-neutral commands should work in the new NovelTea runtime.

## Current Status

The backend-neutral session/controller foundation exists, and runtime driving now has a formal input/output boundary around `RuntimeSessionHost`. Save snapshotting, in-memory slot storage, manual save/load, autosave, and save-backed object placement are implemented in core.

## Runtime Input Contract

Runtime callers should drive playback through `RuntimeSessionHost::apply_input(const RuntimeInput&)`. This is the shared pathway for headless tests, editor preview injection, and RmlUi click handling.

Supported input types are:

- `Start`, `Stop`, and `Reset` for session lifecycle coordination.
- `Tick` for deterministic time advancement.
- `Continue`, `SelectDialogueOption`, `Navigate`, `SelectObject`, `ClearObjectSelection`, and `RunAction` for player/runtime interactions.
- `LoadSave` accepts either a slot id or a save payload and restores through the same host path used by manual load APIs.
- `SetEntrypoint` and `ApplyTestStep` remain runtime contract extension points. Recorded
  playback currently maps test steps to concrete runtime inputs in the editor API layer.

Mode-specific inputs validate their current runtime mode. Invalid inputs return `handled = false` and a structured warning diagnostic instead of silently routing through UI-specific behavior.

## Runtime Output Contract

`RuntimeInputResult` returns:

- `handled`: whether the input was accepted.
- `view`: the updated backend-neutral `RuntimeUIViewState`.
- `outputs`: deterministic observations derived from controller commands and diagnostics.
- `diagnostics`: structured runtime diagnostics for editor/test display.

`ControllerCommand` remains the internal controller event in this phase. `RuntimeSessionHost` converts command batches into `RuntimeOutput` values at the host boundary:

- `ModeChanged` commands become mode outputs.
- `ScriptDeferred` commands become script request outputs for the Lua execution phase.
- notification and text-log commands become explicit notification/text-log outputs.
- successful save/load/autosave operations emit `SaveMutationRequest` outputs.
- command batches that change presentation also emit a view update output.

## Save Policy

`RuntimeSessionHost` owns the runtime save boundary. It can snapshot the current `GameSession` and controller state into a `SaveDocument`, write/read `SaveSlotId` values through a bound `SaveSlotStore`, and use `MemorySaveSlotStore` for tests and editor preview. Platform file, browser, or Android storage is intentionally outside core.

Snapshots preserve recognized legacy save fields plus unknown JSON keys where possible. Runtime-owned controller state is stored under `_novelteaRuntime` so it does not collide with legacy fields.

Object placement resolves in this order: save `objectLocations`, project room membership, then project `startInv`. Runtime inventory is represented by object location `[CustomScript, "player"]`; `startInv` remains immutable project data.

## Diagnostics

`RuntimeDiagnostic` includes severity, category, optional source entity, script/hook context fields, message, optional Lua traceback, and optional playback step index. Load/save diagnostics are used for missing slots, invalid save documents, and stale saved entity references.

## Recorded Playback

`core::editor::RuntimePlaybackSession` is the backend-neutral recorded test runner. It accepts a `RuntimePlaybackSpec`, loads a project, emits an initial deterministic zero-delta tick, then applies each recorded step through `RuntimeSessionHost::apply_input()`.

Non-tick inputs are followed by a zero-delta drain tick using the same playback step index. This preserves the runtime controller's queued-command behavior while making recorded navigation/dialogue/action steps useful as single editor timeline steps.

Project-level tests live under `tests` and use `init`, `steps`, and `check`. Core records hook source and script-request outputs; the engine/script layer may provide a hook executor callback to run Lua setup/check code and return structured diagnostics.

Playback reports include pass/fail, per-step observations, outputs, diagnostics, final preview state, and stable JSON export for the future editor.

## Remaining Work

Remaining work includes richer branch/story traversal tooling, platform-specific slot persistence, and production RmlUi runtime save/load screens.
