# Tests Editor

## Purpose

The Tests Editor is the authoring surface for deterministic playback tests in the
new NovelTea editor. A test describes a repeatable sequence of runtime inputs,
assertions, and optional hook scripts that can later be executed headlessly by
the engine playback runner.

Tests are editor-authored data first. They are not legacy Qt editor tests and do
not preserve legacy project-file compatibility. The old `refs/NovelTea` editor is
only a workflow reference.

## Current Status

Milestone 16 implements Tests Editor V1:

- typed authoring schema for the new project-format `tests` collection;
- authoring validation for tests, steps, assertions, and references;
- command-backed test data replacement through `test.replaceData`;
- default typed test data when creating a `tests` record;
- a `test-detail` workbench editor for authoring test metadata, steps, and
  assertions;
- a structured Test Playback bottom panel for reports;
- a narrow Electron bridge for direct playback specs;
- explicit run-readiness diagnostics for the current authoring-to-runtime
  conversion gap.

Authoring tests are intentionally not reported as runnable yet. The editor can
serialize a test into the native playback spec shape, and the native helper can
run a direct spec, but authoring projects still need an authoring-to-runtime
project conversion layer before a real authoring test can be executed honestly.

## Source Files

Primary implementation files:

- `editor/src/shared/project-schema/authoring-tests.ts`
- `editor/src/shared/project-schema/test-playback-project.ts`
- `editor/src/renderer/project/test-operations.ts`
- `editor/src/renderer/editors/tests/TestsEditor.tsx`
- `editor/src/renderer/workbench/TestPlaybackPanel.tsx`

Integration points:

- `editor/src/shared/project-schema/authoring-validation.ts`
- `editor/src/renderer/project/entity-operations.ts`
- `editor/src/renderer/commands/builtin-commands.ts`
- `editor/src/renderer/workbench/editor-registry.tsx`
- `editor/src/renderer/workbench/default-editors.tsx`
- `editor/src/renderer/workbench/BottomPanel.tsx`
- `editor/src/renderer/routes/workspace.tsx`
- `editor/src/renderer/components/app-menu-bar.tsx`
- `editor/src/shared/electron-api.ts`
- `editor/src/shared/ipc-channels.ts`
- `editor/src/preload.ts`
- `editor/src/main.ts`
- `editor/src/main/services/editor-tool-service.ts`

Coverage:

- `editor/src/renderer/test/authoring-tests.test.ts`
- `editor/src/renderer/test/test-operations.test.ts`
- `editor/src/renderer/test/test-playback-project.test.ts`

Related docs:

- `docs/editor/preview/PREVIEW_AND_TEST_PLAYBACK.md`
- `docs/runtime/STATE_AND_PLAYBACK.md`
- `docs/editor/plans/IMPLEMENTATION_PLAN.md`

## Data Model

Tests live in the standard authoring collection record map:

```ts
project.tests[testId] = {
  id: testId,
  label: 'Smoke Test',
  tags: [],
  data: TestData,
}
```

The authoring record wrapper is shared with the other typed editor collections.
The test-specific shape is stored under `record.data`.

### TestData

`TestData` has these top-level fields:

```ts
{
  kind: 'test',
  displayName: string,
  entrypoint: TestEntrypointRef | null,
  fixedDeltaSeconds: number | null,
  initScript: string,
  checkScript: string,
  startingInventory: TestInteractableRef[],
  steps: TestStepData[],
  preview: {
    selectedStepId: string | null,
    selectedObservationIndex: number | null,
    autoOpenReport: boolean,
  },
}
```

`kind` is always `test` and allows cheap shape checks in editor code.
`displayName` is the human-readable name shown inside the editor. The outer
record `label` remains the project-browser label.

`entrypoint` is the desired starting point for the test. It may reference a
scene, room, or dialogue. The current runtime adapter stores this in authoring
form and emits a readiness diagnostic because authoring entrypoints cannot yet be
converted to runtime `EntityRef` values.

`fixedDeltaSeconds` is an optional default tick delta for deterministic playback.
When null, the runner/default spec controls tick timing.

`initScript` and `checkScript` are hook-source fields. The playback core is
script-runtime-neutral: it transports hook source and lets the engine/script host
execute it. The editor treats these as Lua source because NovelTea runtime
scripting is Lua.

`startingInventory` is modeled but not yet surfaced heavily in the UI. It stores
Interactable references for future runtime state setup once authoring-to-runtime
conversion exists.

`preview` is editor-only state. It controls which step/report row is focused and
must not be interpreted as runtime game state.

### References

Tests use `$ref` objects so the generic reference scanner can find usages,
participate in rename/update flows, and warn during delete operations.

Reference helpers are defined in `authoring-tests.ts`:

```ts
testSceneRef(id)
testRoomRef(id)
testDialogueRef(id)
testInteractableRef(id)
testVerbRef(id)
testVariableRef(id)
```

Entrypoints can reference:

```text
scenes
rooms
dialogues
```

Step/action/assertion fields currently use references to:

```text
interactables
characters
verbs
variables
maps
scenes
rooms
dialogues
```

`maps` is accepted by the generic test reference union for future test coverage,
even though the V1 editor does not yet expose a map-specific test interaction.

## Step Model

Each test step has this common shape:

```ts
{
  id: string,
  input: TestInputType,
  label: string,
  enabled: boolean,
  deltaSeconds: number | null,
  initScript: string,
  checkScript: string,
  tick: { deltaSeconds: number },
  dialogueOption: { optionIndex: number },
  navigate: { direction: number, target: TestRoomRef | null },
  selectSubjects: { subjects: TestInteractionSubject[] },
  runInteraction: { verb: TestVerbRef | null, operands: TestInteractionSubject[] },
  loadSave: { slotId: string, payload: JsonValue },
  setEntrypoint: { entrypoint: TestEntrypointRef | null },
  assertions: TestAssertionData[],
}
```

All input-specific payload objects exist on every step. This makes UI editing and
JSON patches simpler: changing a step from one input type to another does not
destroy old payload fields. Only the payload matching `step.input` is considered
active by the playback spec builder.

`enabled` controls whether the step is included when serializing a playback spec.
Disabled steps remain in the test for authoring, documentation, and temporary
isolation.

`deltaSeconds` is a per-step override. For `tick`, the adapter uses
`step.deltaSeconds` when set, otherwise `step.tick.deltaSeconds`.

`initScript` and `checkScript` are per-step hook sources. They are serialized to
native step `init` and `check` fields when non-empty.

### Input Types

Authoring input names use editor-readable kebab-case. The adapter maps them to
the native playback runner names.

| Authoring input | Native input | Active fields |
| --- | --- | --- |
| `tick` | `tick` | `tick.deltaSeconds`, `deltaSeconds` |
| `continue` | `continue` | none |
| `dialogue-option` | `dialogue_option` | `dialogueOption.optionIndex` |
| `navigate` | `navigate` | `navigate.direction`, `navigate.target` |
| `select-subjects` | `select-subjects` | `selectSubjects.subjects` |
| `clear-subject-selection` | `clear-selection` | none |
| `run-interaction` | `invoke-interaction` | `runInteraction.verb`, `runInteraction.operands` |
| `load-save` | `load_save` | `loadSave.slotId`, `loadSave.payload` |
| `set-entrypoint` | `set_entrypoint` | `setEntrypoint.entrypoint` |

`navigate.target` is stored for authoring context and future validation. The
current native input primarily consumes direction.

`load-save` stores arbitrary JSON payload. If `slotId` is set, the adapter wraps
payload data with the slot id before sending it to the native runner.

`set-entrypoint` remains limited because authoring entrypoints are not yet
convertible to runtime entity refs.

## Assertion Model

Each assertion has this shape:

```ts
{
  id: string,
  type: TestAssertionType,
  label: string,
  value: string,
  key: string,
  expected: unknown,
  entity: TestAnyRef | null,
  variable: TestVariableRef | null,
  enabled: boolean,
}
```

Enabled assertions are serialized into the native playback spec. Disabled
assertions remain visible for authoring but do not affect playback.

### Assertion Types

Assertion names mirror the native runner capabilities, using kebab-case in the
editor and snake_case in the native spec.

| Authoring assertion | Native assertion | Main fields |
| --- | --- | --- |
| `mode` | `mode` | `value` |
| `current-room` | `current_room` | `value` |
| `title` | `title` | `value` |
| `text-log-contains` | `text_log_contains` | `value` |
| `property-equals` | `property_equals` | `key` or `variable`, `expected` |
| `interactable-location` | `object_location` | `key`, optional `entity` |
| `inventory-contains` | `inventory_contains` | `value` |
| `output-type` | `output_type` | `value` |
| `diagnostic-category` | `diagnostic_category` | `value` |

For `property-equals`, a variable reference is preferred when asserting an
authoring variable. The adapter serializes the variable id as the native key.
`expected` may be any JSON value.

For assertions that use `entity`, the current adapter serializes a minimal
`entity_ref` with the referenced id. This is intentionally conservative until the
engine-side authoring-to-runtime entity mapping exists.

## Defaults

Creating a record in the `tests` collection uses `defaultTestData(label)`. The
initial data is:

```ts
{
  kind: 'test',
  displayName: label,
  entrypoint: null,
  fixedDeltaSeconds: null,
  initScript: '',
  checkScript: '',
  startingInventory: [],
  steps: [
    {
      id: 'start',
      input: 'tick',
      label: 'Start',
      enabled: true,
      assertions: [],
    },
  ],
  preview: {
    selectedStepId: 'start',
    selectedObservationIndex: null,
    autoOpenReport: true,
  },
}
```

Default assertions are created with `defaultTestAssertion(type)`. The initial id
matches the assertion type, but the editor assigns a unique id when inserting an
assertion into a step.

Default steps are created with `defaultTestStep(input, label)`. The `tick`
default id is `start`; other step types default to their input name. The editor
normalizes and uniquifies IDs when inserting or duplicating steps.

## Validation

Test validation runs from `validateAuthoringProject()` via `validateTestData()`.
Diagnostics use category `authoring-tests`.

Validation currently checks:

- the `record.data` shape matches `testDataSchema`;
- test inheritance, when present, targets another test and references an existing
  record;
- display name is present, warning if empty;
- entrypoint reference exists, when set;
- starting inventory object references exist;
- the test has at least one step;
- step IDs are unique;
- preview `selectedStepId` points at an existing step, warning if stale;
- step labels are present;
- per-step delta values are non-negative;
- navigation direction is 0 through 7;
- dialogue option index is non-negative;
- active input-specific references exist;
- assertion IDs are unique within each step;
- assertion entity and variable references exist;
- enabled assertions have required fields for their type.

Disabled steps skip input-specific validation after their common fields. Disabled
assertions do not enforce type-specific required fields.

Validation should remain strict enough to prevent broken command commits but not
so strict that partially authored tests become impossible to save. Warnings are
appropriate for editor-only stale state or incomplete labels that do not break
playback serialization.

## Commands and Undo/Redo

Tests use the normal editor command bus. The main command is:

```ts
{
  type: 'test.replaceData',
  label?: string,
  payload: {
    testId: string,
    data: TestData,
  },
}
```

`test.replaceData` is implemented by `replaceTestDataPatches()`. It:

1. verifies the current document is an authoring project;
2. verifies the test record exists;
3. parses the replacement data with `parseTestData()`;
4. validates the replacement record with `validateTestData()`;
5. rejects the command if any error diagnostic is produced;
6. emits a JSON Patch `replace` operation for `/tests/<testId>/data`.

Because it uses normal command-bus patch application, test edits participate in:

- undo and redo;
- dirty state;
- save/autosave;
- guarded close;
- command labels in history.

The Tests Editor currently commits field changes directly through
`test.replaceData`. Future refinement may add local draft buffering for larger
script/text edits, matching the direction used by source-heavy editors.

## Workbench Integration

Test records open with editor type `test-detail`. The registry helper is:

```ts
buildTestDetailTabForRecord(entityId, title)
```

The default editor registry maps `test-detail` to `TestsEditor` and uses the
`ListChecks` icon.

The toolbar test button behaves differently depending on project type:

- for authoring projects, it opens the first test record in the Tests Editor;
- for runtime-compatible projects with native playback tests, it runs the first
  listed test;
- if no tests exist, it reports a clear status message.

The toolbar no longer disables playback purely because the project is an
authoring project. Instead, the Tests Editor owns the detailed readiness state.

## Tests Editor UI

The Tests Editor is split into a main authoring area and a selected-step
inspector.

The top area shows:

- record label and test id;
- run-readiness badge;
- readiness message;
- Run Test action;
- display name;
- entrypoint selector;
- fixed delta field;
- ordered step list;
- top-level init/check Lua source fields.

The step list shows each step’s order, label, input type, disabled state, and any
matching playback observation state from the last report.

The selected-step inspector supports:

- step label;
- input type;
- enabled flag;
- delta override;
- input-specific fields;
- step init/check Lua source;
- assertion list;
- adding, deleting, duplicating, and reordering steps;
- adding, deleting, enabling, and editing assertions.

The V1 UI deliberately favors explicit fields over compact specialized widgets.
As the schema stabilizes, the editor can grow better selectors, multi-object
editors, timeline affordances, and record-from-preview workflows.

## Playback Spec Adapter

`test-playback-project.ts` contains the authoring-to-native playback spec adapter.
This adapter is intentionally pure and narrow. It does not mutate project state
or talk to Electron.

Main functions:

```ts
buildRuntimePlaybackSpecFromTestData(testId, data)
buildRuntimePlaybackSpecFromAuthoringTest(project, testId)
getAuthoringTestRunReadiness(project, testId)
```

The adapter maps editor spellings to native spellings:

```ts
dialogue-option         -> select-dialogue-choice
select-subjects         -> select-subjects
clear-subject-selection -> clear-selection
run-interaction         -> invoke-interaction
load-save               -> load
```

It serializes:

- enabled steps only;
- enabled assertions only;
- top-level `fixed_delta_seconds`;
- top-level `init` and `check` hooks;
- per-step `delta_seconds`, `init`, and `check` when present;
- input payloads such as typed `{ kind: "character" | "interactable", id }`
  `subjects`/`operands`, dialogue-choice edges, navigation exits, verb ids, and
  save payloads;
- assertion payloads such as `type`, `value`, `key`, `expected`, and minimal
  `entity_ref`.

Entrypoints currently produce a warning diagnostic rather than a native runtime
entity ref. This is one of the boundaries that the future authoring-to-runtime
conversion layer must resolve.

## Run Readiness

Readiness is explicit and machine-readable:

```ts
type TestRunReadinessReason =
  | 'runnable'
  | 'not-runnable-authoring-conversion-missing'
  | 'not-runnable-invalid-test'
  | 'not-runnable-missing-entrypoint'
  | 'not-runnable-missing-runtime-support'
```

Current behavior:

- non-authoring projects are considered runnable by this adapter because the
  native tool path owns their validation;
- missing test records are `not-runnable-invalid-test`;
- invalid test data is `not-runnable-invalid-test`;
- authoring tests with no entrypoint are `not-runnable-missing-entrypoint`;
- authoring tests with an entrypoint are still
  `not-runnable-authoring-conversion-missing` until project conversion exists.

When the user presses Run Test on a non-runnable authoring test, the editor opens
the Test Playback bottom panel and writes a structured failure-like report with
readiness diagnostics. It does not claim that the native runner executed the
test.

## Electron and Native Tool Bridge

The native helper already supports `run-test` with either:

- `testId`, for tests stored in a native/runtime-compatible project; or
- direct `spec`, for an explicit playback spec supplied by the caller.

The editor exposes the direct-spec route through:

```ts
window.noveltea.runPlaybackSpec(project, spec)
```

IPC channel:

```ts
noveltea:run-playback-spec
```

Main-service function:

```ts
runPlaybackSpec(project, spec) => invokeEditorTool('run-test', { project, spec })
```

This bridge is intentionally narrow. It does not expose a general-purpose native
helper invocation channel to the renderer.

## Playback Report Panel

The Test Playback bottom panel is implemented by `TestPlaybackPanel`. It renders
structured reports instead of only dumping JSON.

The panel displays:

- pass/fail badge;
- report id;
- failure list;
- final state summary;
- observations with step index, input, handled state, pass/fail state, assertion
  failures, and diagnostics;
- report-level diagnostics;
- output summary;
- expandable raw JSON fallback.

The panel accepts unknown report objects defensively because native playback
reports, readiness pseudo-reports, and future report revisions may differ in
shape.

## Reference Behavior

Because test references are normal `$ref` objects, they are compatible with the
generic authoring reference index. This is important for editor quirks:

- renaming a referenced scene, room, dialogue, object, verb, or variable should
  update test references through the existing reference-update path;
- deleting a referenced record should show usages in tests;
- tests should appear in find-usages/reference panels without bespoke scanner
  code.

Keep new test-reference fields as `$ref` objects unless there is a strong reason
not to. Free-form string IDs are harder to rename safely.

## Authoring vs Runtime Terminology

Authoring tests use editor-facing names and authoring references. Runtime
playback uses native runner names and runtime entity refs. Do not blur these
layers.

Use kebab-case in the authoring schema when naming editor-facing enum values:

```text
dialogue-option
select-subjects
clear-subject-selection
run-interaction
```

Use snake_case only when serializing to the native playback spec:

```text
select-dialogue-choice
select-subjects
clear-selection
invoke-interaction
```

This lets the UI remain readable while keeping the native helper stable.

## Current Limitations

Tests Editor V1 is an authoring implementation, not a complete end-to-end runtime
execution system for new authoring projects.

Known limitations:

- authoring-to-runtime project conversion is missing;
- authoring entrypoints cannot yet become runtime `EntityRef` values;
- `startingInventory` is modeled but not fully surfaced or executable;
- `navigate.target` is authoring context and is not yet a full runtime target;
- assertion `entity_ref` serialization is minimal;
- record-from-preview is not implemented;
- failure timeline deep-linking is basic and based on matching observation
  indexes to step order;
- step/assertion editing is immediate command commit rather than buffered draft
  editing;
- hook execution depends on the future engine/script host integration for
  runtime Lua.

These limitations should be surfaced as diagnostics or disabled affordances. Do
not fake successful playback for authoring tests.

## Future Work

The next meaningful work is the authoring-to-runtime conversion layer. It should:

1. define how authoring scenes, rooms, dialogues, interactables, verbs, variables, and
   assets map into runtime entities;
2. provide stable runtime `EntityRef` generation for authoring refs;
3. serialize authoring test entrypoints and `set-entrypoint` payloads;
4. serialize starting inventory and interactable locations in runtime state terms;
5. make `getAuthoringTestRunReadiness()` return `runnable` only when a complete
   runtime-compatible project/spec pair can be produced;
6. run authoring tests through `runPlaybackSpec(project, spec)` and display real
   reports;
7. add record-from-preview once preview events expose enough deterministic input
   data;
8. add stronger timeline linking between report observations and step IDs;
9. consider draft buffering for scripts and large JSON payloads.

## Verification

Relevant verification commands from the editor package:

```bash
pnpm -C editor run typecheck
pnpm -C editor run test
pnpm lint
```

Focused tests can be run with Vitest filters:

```bash
pnpm vitest run src/renderer/test/authoring-tests.test.ts
pnpm vitest run src/renderer/test/test-operations.test.ts
pnpm vitest run src/renderer/test/test-playback-project.test.ts
```

Expected coverage:

- default test data has the right stable shape;
- validation reports missing refs, duplicate IDs, and required assertion fields;
- project validation includes test diagnostics;
- `entity.createRecord` creates typed test data;
- `test.replaceData` patches valid data and rejects invalid replacements;
- undo restores previous test data;
- playback spec serialization uses native input/assertion names;
- readiness reports the authoring conversion limitation explicitly.
