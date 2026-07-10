# Preview and Test Playback

## Purpose

Define the editor-facing runtime preview and test playback workflow for the Electron/TanStack/Vite editor direction.

## Current Status

Backend-neutral preview APIs exist for starting, stopping, resetting, stepping, overriding entrypoints, injecting runtime input, inspecting state, and capturing controller commands.

Recorded playback is implemented through `noveltea::core::editor::RuntimePlaybackSession`. It loads a project headlessly, drives steps through `RuntimeSessionHost::apply_input()`, captures outputs/diagnostics, evaluates assertions, and exports an editor-friendly JSON report.

The Electron editor calls these APIs through the `noveltea-editor-tool` helper
executable instead of linking native code into Electron. The helper accepts JSON
on stdin and supports project load/import, validation, test listing, playback
execution, raw entity edits, and package export.

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

## Editor V1 Integration

The current editor workspace is project-backed rather than mock-data-backed:

- project open loads `game.json`, `project.json`, or legacy `game` from a
  selected directory;
- entity collections are grouped into a browser for rooms, objects, verbs,
  actions, maps, dialogues, cutscenes, scripts, assets, and tests;
- selected entities are shown as raw JSON records while typed editors mature;
- validation diagnostics, playback results, export results, and preview events
  are surfaced in the inspector/timeline;
- runtime preview controls send runtime-named input commands over the existing
  MessageChannel protocol.

Editor preview preferences can follow the project display profile or supply a custom ratio and
orientation without mutating project data. Play defaults to responsive scaling. Pooled derived
previews default to a stable reference composition whose long axis is 1280 logical pixels, then
uniformly scale the persistent iframe into a centered fitted slot.

## Authoring Tests Editor

Milestone 16 adds a first-class authoring Tests Editor for records under the new
project-format `tests` collection. Test records use the standard authoring record
wrapper, with test-specific data under `record.data`.

The editor-side test schema stores:

- `displayName`, `entrypoint`, optional `fixedDeltaSeconds`, `initScript`, and
  `checkScript`;
- ordered `steps` with stable IDs, labels, enable/disable state, per-step hook
  scripts, input-specific payload fields, and assertions;
- assertion records with stable IDs, type, label, value/key/expected fields, and
  optional variable/entity references;
- `preview` editor state for selected step/report focus.

Authoring test inputs are named for editor readability:

```text
tick
continue
dialogue-option
navigate
select-object
clear-object-selection
run-action
load-save
set-entrypoint
```

The native playback runner still consumes the existing runtime spellings such as
`dialogue_option`, `select_object`, and `run_action`. The editor has a pure
adapter that serializes authoring test data into that native playback spec shape
when a runnable project/spec pair is available.

Assertions currently mirror the native runner capabilities:

```text
mode
current-room
title
text-log-contains
property-equals
object-location
inventory-contains
output-type
diagnostic-category
```

The Tests Editor can create and edit test steps/assertions through the command
bus, so undo/redo, dirty-state derivation, save/autosave, and guarded close
behavior follow the rest of the typed editors. Test references use `$ref` where
possible, so the existing reference index can find usages, update references on
rename, and warn on delete.

## Current Run Limitation

The native helper already supports running a direct playback spec through the
existing `run-test` command. The Electron bridge now exposes a narrow
`runPlaybackSpec(project, spec)` API for that path instead of exposing a generic
helper invocation channel.

Authoring tests are intentionally not reported as runnable until the missing
authoring-to-runtime project conversion exists. The editor surfaces this as a
structured readiness diagnostic, usually
`not-runnable-authoring-conversion-missing`, instead of pretending the test ran
or leaving playback buttons as an unexplained dead end.

The global Test Playback bottom panel now renders structured report data: pass or
fail status, failures, observations, per-observation diagnostics, report-level
diagnostics, outputs, final state, and an expandable raw JSON fallback for
debugging.

## Planned Full Game Preview and Recorder Tab

The detailed implementation plan for the next editor/runtime slice lives in
the runtime and preview docs.

That plan expands the recorder concept into a full-game workbench tab with Debug and Recording modes.
The tab should reuse the existing editor preview iframe transport, keep `web/widget.html` as the thin
V0 preview bridge, move runtime controls out of generic entity-preview chrome, add a top-toolbar Play
button left of undo/redo, expose debugger panels for variables/inventory/rooms/objects/diagnostics,
support fast-forward-to-input, and record player-visible actions into authoring test drafts.

Until UI playback is wired into the editor test runner, recorded gameplay inputs should lower to the
existing backend-neutral authoring test step types. True `ui-click` steps should be saved only when
the UI playback path can replay them through RmlUi, Layout Lua, and the runtime command dispatcher.
