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
- `SetEntrypoint` and `ApplyTestStep` remain editor/test-playback extension points.

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

## Remaining Work

Remaining work includes richer editor test-step playback, platform-specific slot persistence, and production RmlUi runtime save/load screens.
