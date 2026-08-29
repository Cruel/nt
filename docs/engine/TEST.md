# Tests Editor

## Purpose

The Tests Editor is the authoring surface for deterministic semantic playback tests in the new
NovelTea editor. A Test describes a repeatable sequence of stable typed runtime inputs that execute
headlessly against the same compiled project and Runtime Session used by Play preview.

Tests are editor-authored data first. They are not legacy Qt editor tests and do
not preserve legacy project-file compatibility. The old `refs/NovelTea` editor is
only a workflow reference.

## Current Status

The current Tests Editor implements:

- typed authoring schema for the new project-format `tests` collection;
- authoring validation for tests, semantic steps, subjects, and references;
- command-backed test data replacement through `test.replaceData`;
- default typed test data when creating a `tests` record;
- a `test-detail` workbench editor for authoring test metadata and semantic steps;
- a structured Test Playback bottom panel for reports;
- a narrow Electron bridge for direct playback specs;
- explicit run-readiness diagnostics for Test lowering and runtime-artifact preparation.

Authoring Tests are runnable when their semantic steps lower successfully and the current authoring
project prepares a playable compiled artifact. There is no separate legacy playback project shape.

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
- `docs/editor/OVERVIEW.md`

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

`preview` is editor-only state. It controls which step/report row is focused and
must not be interpreted as runtime game state.

### References

Tests use `$ref` objects so the generic reference scanner can find usages,
participate in rename/update flows, and warn during delete operations.

Reference helpers are defined in `authoring-tests.ts`:

```ts
testCharacterRef(id)
testInteractableRef(id)
testVerbRef(id)
testCharacterSubject(id)
testInteractableSubject(id)
testFeatureSubject(feature)
```

Test steps reference Characters, exact Interactable Instances, owner-qualified Features, and Verbs.
They do not carry generic entity references, map-specific actions, or Test-local assertion references.

## Step Model

Each test step has a stable ID, label, enabled flag, one semantic input discriminant, and typed
payload objects for the supported input families. Only the payload selected by `step.input` is active
during validation and playback lowering.

`TestInteractionSubject` admits Character, exact Interactable Instance, and owner-qualified Feature
identities. Recorder lowering and playback preserve Interactable Instance IDs rather than substituting
definition identity.

All input-specific payload objects exist on every step. This makes UI editing and
JSON patches simpler: changing a step from one input type to another does not
destroy old payload fields. Only the payload matching `step.input` is considered
active by the playback spec builder.

`enabled` controls whether the step is included when serializing a playback spec.
Disabled steps remain in the test for authoring, documentation, and temporary
isolation.

There are no Test-local init/check Lua fields or per-step delta override outside the typed `tick`
payload.

### Input Types

Authoring input names use editor-readable kebab-case. The adapter maps them to
the native playback runner names.

| Authoring input | Native input | Active fields |
| --- | --- | --- |
| `tick` | `advance-time` | `tick.deltaSeconds` lowered to microseconds |
| `continue` | `continue` | none |
| `dialogue-choice` | `dialogue-choice` | exact `dialogueChoice.edgeId` |
| `scene-choice` | `scene-choice` | exact `sceneChoice.optionId` |
| `navigate` | `navigate` | exact `navigate.exitId` |
| `select-subjects` | `select-subjects` | `selectSubjects.subjects` |
| `primary-activate` | `primary-activate` | `subjectAction.subject` |
| `open-verb-menu` | `open-verb-menu` | `subjectAction.subject` |
| `clear-subject-selection` | `clear-selection` | none |
| `run-interaction` | `invoke-interaction` | `runInteraction.verb`, `runInteraction.bindings` |
| `save` | `save` | `saveSlot.slotId` |
| `load` | `load` | `saveSlot.slotId` |

Dialogue and Scene choices never store list indexes. Navigation never stores a direction ordinal or
target guess. Save/load steps store typed slot identities rather than arbitrary payloads.

## Runtime Observation Model

The current Test schema has no assertion DSL. Playback reports expose ordered runtime events,
diagnostics, and one coherent final publication containing gameplay UI, presentation, and public
runtime observations. Tests and certification code evaluate those public semantic outputs instead of
serializing Test-local `type`/`value`/`expected` assertion payloads.

## Defaults

Creating a record in the `tests` collection uses `defaultTestData(label)`. The
initial data is:

```ts
{
  kind: 'test',
  displayName: label,
  steps: [
    {
      id: 'start',
      input: 'tick',
      label: 'Start',
      enabled: true,
    },
  ],
  preview: {
    selectedStepId: 'start',
    selectedObservationIndex: null,
    autoOpenReport: true,
  },
}
```

Default steps are created with `defaultTestStep(input, label)`. The `tick`
default id is `start`; other step types default to their input name. The editor
normalizes and uniquifies IDs when inserting or duplicating steps.

## Validation

Test validation runs from `validateAuthoringProject()` via `validateTestData()`.
Diagnostics use category `authoring-tests`.

Validation currently checks:

- the `record.data` shape matches `testDataSchema`;
- display name is present, warning if empty;
- the test has at least one step;
- step IDs are unique;
- preview `selectedStepId` points at an existing step, warning if stale;
- step labels are present;
- tick delta values are non-negative;
- active input-specific references exist;
- owner-qualified Feature subjects resolve;
- subject actions provide a subject;
- Run Interaction binds every named Verb slot exactly once;
- save/load slots are non-empty.

Disabled steps skip input-specific validation after their common fields. Disabled
steps remain editable and are omitted from playback lowering.

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
- ordered semantic step list.

The step list shows each step’s order, label, input type, disabled state, and any
matching playback observation state from the last report.

The selected-step inspector supports:

- step label;
- input type;
- enabled flag;
- input-specific fields;
- typed subject, Verb, choice, navigation, and save/load selectors as applicable;
- adding, deleting, duplicating, and reordering steps.

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

It serializes:

- enabled steps only;
- typed Character, exact Interactable Instance, and owner-qualified Feature subjects;
- exact Dialogue Edge IDs, Scene Choice Option IDs, Room Exit IDs, and Verb IDs;
- named Interaction bindings;
- typed autosave/manual save slots.

The same adapter compiles the current authoring project through `prepareRuntimeArtifact` with the
`test-playback` intent. Tests therefore execute against the same canonical compiled project used by
Play preview rather than a second runtime-project shape.

## Run Readiness

Readiness is explicit and machine-readable:

```ts
type TestRunReadinessReason =
  | 'runnable'
  | 'not-runnable-invalid-test'
  | 'not-runnable-project-compilation-failed'
  | 'not-runnable-missing-runtime-support'
```

Current behavior:

- missing test records are `not-runnable-invalid-test`;
- invalid test data is `not-runnable-invalid-test`;
- unsupported semantic step lowering is `not-runnable-missing-runtime-support`;
- failure to prepare the current compiled runtime artifact is
  `not-runnable-project-compilation-failed`;
- otherwise the Test is runnable.

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
- final state summary;
- ordered playback/runtime observations and diagnostics;
- report-level diagnostics;
- output summary;
- expandable raw JSON fallback.

The panel accepts unknown report objects defensively because native playback
reports, readiness pseudo-reports, and future report revisions may differ in
shape.

## Reference Behavior

Because test references are normal `$ref` objects, they are compatible with the
generic authoring reference index. This is important for editor quirks:

- renaming a referenced Character, Interactable Instance, or Verb should update Test references
  through the existing reference-update path; Room and Interactable Instance owner references used by
  owner-qualified Features follow the same path;
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
dialogue-choice
scene-choice
navigate
select-subjects
primary-activate
open-verb-menu
clear-subject-selection
run-interaction
save
load
```

The playback protocol uses the stable typed operation names documented above. It does not translate
choices or navigation back into positional/index-based native commands.

## Current Limitations

Tests are runnable end to end through the compiled-project and Runtime Session seam. Remaining work is
editor ergonomics rather than an authoring-to-runtime conversion gap.

Known limitations:

- failure timeline deep-linking is basic and based on matching observation
  indexes to step order;
- step editing is immediate command commit rather than buffered draft editing.

These limitations are editor UX concerns and do not change playback semantics.

## Future Work

Future Test work should focus on richer observation/report UX, stronger timeline linking, and editor
ergonomics while preserving the semantic input contract and public-runtime-observation boundary.

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
- validation reports missing refs, duplicate IDs, invalid Features, incomplete subject actions, and
  incomplete Verb bindings;
- project validation includes test diagnostics;
- `entity.createRecord` creates typed test data;
- `test.replaceData` patches valid data and rejects invalid replacements;
- undo restores previous test data;
- playback spec serialization uses stable Dialogue Edge, Scene Option, Room Exit, subject, Verb, and
  save-slot identities;
- readiness reflects Test lowering and runtime-artifact compilation honestly.
