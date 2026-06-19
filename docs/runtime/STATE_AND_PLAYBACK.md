# State and Playback

## Purpose

Define how runtime state, controller progression, entrypoints, save restoration, playback stepping, and UI-neutral commands should work in the new NovelTea runtime.

## Current Status

The backend-neutral session/controller foundation exists, and runtime driving now has a formal input/output boundary around `RuntimeSessionHost`.

## Runtime Input Contract

Runtime callers should drive playback through `RuntimeSessionHost::apply_input(const RuntimeInput&)`. This is the shared pathway for headless tests, editor preview injection, and RmlUi click handling.

Supported input types are:

- `Start`, `Stop`, and `Reset` for session lifecycle coordination.
- `Tick` for deterministic time advancement.
- `Continue`, `SelectDialogueOption`, `Navigate`, `SelectObject`, `ClearObjectSelection`, and `RunAction` for player/runtime interactions.
- `SetEntrypoint`, `LoadSave`, and `ApplyTestStep` are part of the contract but remain minimal/stubbed until the editor playback and save-slot phases define their full behavior.

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
- command batches that change presentation also emit a view update output.

## Diagnostics

`RuntimeDiagnostic` includes severity, category, optional source entity, script/hook context fields, message, optional Lua traceback, and optional playback step index. Lua traceback is reserved for Phase 2 script execution; Phase 1 uses diagnostics primarily for invalid runtime inputs.

## Remaining Work

Remaining work includes full Lua execution integration, save/autosave mutation policy, persisted object placement behavior, and richer editor test-step playback.
