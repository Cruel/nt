# Preview and Test Playback

## Purpose

Define the editor-facing runtime preview and test playback workflow for the Electron/TanStack/Vite editor direction.

## Current Status

Backend-neutral preview APIs exist for starting, stopping, resetting, stepping, overriding entrypoints, injecting runtime input, inspecting state, and capturing controller commands.

Recorded playback is implemented through `noveltea::core::editor::RuntimePlaybackSession`. It loads a project headlessly, drives steps through `RuntimeSessionHost::apply_input()`, captures outputs/diagnostics, evaluates assertions, and exports an editor-friendly JSON report.

Playback specs may be supplied directly as JSON or stored under the project `tests` key. The schema uses the existing project keys:

- `id`: stable test id.
- `entrypoint`: optional legacy entity ref array or `{ "type": <legacy-int>, "id": "..." }`.
- `fixed_delta_seconds`: optional default tick delta.
- `init`: optional setup hook source.
- `steps`: ordered recorded input steps.
- `check`: optional final check hook source.

Supported step inputs are `tick`, `continue`, `dialogue_option`, `navigate`, `select_object`, `clear_object_selection`, `run_action`, `load_save`, and `set_entrypoint`. Runtime inputs receive a deterministic step index so diagnostics and outputs can be displayed in editor timelines.

Assertions currently cover mode, current room, title, text-log contents, global properties, object locations, inventory membership, emitted output types, and diagnostic categories.

Lua setup/check hooks are executed by an optional host callback supplied by the engine/script layer. The core playback API stores hook source and reports hook requests without depending on Lua types.
