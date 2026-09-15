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
They do not carry generic entity references or map-specific actions. Semantic expectations use their own
closed typed targets rather than arbitrary assertion scripts or expression payloads.

## Step Model

Each test step has a stable ID, label, enabled flag, one typed input discriminant, payload objects for
the supported semantic or UI input families, and an ordered `expectations` list. Only the payload
selected by `step.input` is active during input validation and playback lowering; expectations are
evaluated after that step reaches a deterministic semantic boundary.

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
| `ui-click` | `ui-click` | `uiClick.documentId`, `uiClick.selector` |

Dialogue and Scene choices never store list indexes. Navigation never stores a direction ordinal or
target guess. Save/load steps store typed slot identities rather than arbitrary payloads. `ui-click`
selects the RuntimeUI runner, resolves the authored selector against the named visible document, and
dispatches real RmlUi pointer input through the normal Layout-event capability path. Stable element IDs
or explicit test-oriented attributes are preferred selector contracts. Coordinate clicks are not the
default Test seam and are reserved for future geometry/hit-target cases where coordinates themselves
are the behavior under test. A Test may freely mix `ui-click` with the semantic inputs above.

## Semantic Expectations

Authored Tests have a closed typed expectation vocabulary. Expectations may follow any enabled step,
and `finalExpectations` may validate the completed playback state. They observe authoritative runtime
publications and query gateways; they do not read private RuntimeSession fields and do not execute Lua
or an expression language.

The initial families cover Properties, current Room, Character/Interactable location, Interactable
quantity, Trait presence, enabled/visible entity state, active Scene/Dialogue identity, mounted Layout
presence/state, notification/save outcomes, and diagnostic codes. Operators are deliberately limited
to equality/inequality, presence/absence, and numeric comparisons where the target supports them.

Before evaluating step expectations, native playback performs a zero-duration engine-time advance.
This drains deterministic runtime work without wall-clock sleeps or artificial elapsed gameplay time.
Final expectations use the same semantic observation seam after a final zero-duration settle.

Playback reports include ordered per-step expectation results plus final expectation results and the
coherent final publication. Expectation failures make the report fail while preserving the individual
result ID and message for editor diagnostics/reporting. Legacy generic assertion payloads and arbitrary
assertion Lua remain unsupported.

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
      expectations: [],
    },
  ],
  finalExpectations: [],
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
- save/load slots are non-empty;
- active UI-click document IDs and selectors are non-empty.

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
- typed subject, Verb, choice, navigation, save/load, and UI document/element selectors as applicable;
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
- RuntimeUI document IDs and stable element selectors for `ui-click` steps (built-in documents use their stable runtime IDs);
- typed Character, exact Interactable Instance, and owner-qualified Feature subjects;
- exact Dialogue Edge IDs, Scene Choice Option IDs, Room Exit IDs, and Verb IDs;
- named Interaction bindings;
- typed autosave/manual save slots.

The same adapter compiles the current authoring project through `prepareRuntimeArtifact` with the
`test-playback` intent. Tests therefore execute against the same canonical compiled project used by
Play preview rather than a second runtime-project shape. Semantic-only Tests select the `runtime`
runner. Any enabled `ui-click` step selects `runtime-ui`, which initializes RuntimeUI/RmlUi and still
uses the same typed semantic expectation/reporting protocol as the semantic runner.

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

The native helper supports direct semantic `run-test` playback from a canonical Compiled Project and
one already-lowered playback `spec`. Authored Test records are not a native input boundary.

The native `run-test-suite` operation accepts one canonical Compiled Project plus the lowered
`noveltea.runtime-test-catalog` generated by the shared TypeScript authoring layer. It validates the
Compiled Project as a common suite prerequisite, executes runnable entries sequentially in stable Test
ID order, skips blocked entries while preserving their readiness diagnostics, and returns one
`noveltea.test-suite-report` aggregate. Executed entries retain their complete individual playback
report. Their suite status is `passed` or `failed` from the playback report; native/runtime execution
failures are `error`. A failed/error entry does not stop later independent entries, while common
Compiled Project admission failure aborts the suite before per-test results are published.

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

UI Tests use the parallel `run-ui-test` operation exposed as
`window.noveltea.runUiPlaybackSpec(projectSessionId, project, spec)`. The main process resolves the
trusted active Project root from that session and supplies it only to the native UI runner, so
file-backed Layout RML/RCSS/Lua and gameplay Script Assets resolve through the same `project:/`
namespace as normal execution. Unlike `run-test`, this operation instantiates the real RuntimeUI/RmlUi
presentation path and drives selector clicks through `RuntimeUiPlaybackDriver`.
The driver requires the requested document to be visible, the selected element to be enabled and have
usable geometry, verifies the center hit target/occlusion, and sends normal RmlUi pointer move/down/up
input rather than directly invoking a callback. Runtime Layout Lua consequently executes with the same
mount context and gameplay Layout-event capabilities as interactive input. Both operations return the
same typed playback report and expectation result shapes.

This bridge is intentionally narrow. It does not expose a general-purpose native helper invocation
channel to the renderer.

## Playback Report Panel

The Test Playback bottom panel is implemented by `TestPlaybackPanel`. It renders
structured reports instead of only dumping JSON.

The panel displays:

- pass/fail badge and report id;
- ordered semantic playback steps with per-step expectation pass/fail results and diagnostics;
- final expectation results;
- the coherent final publication and emitted events;
- readiness pseudo-report failures/diagnostics when native playback did not run;
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
ui-click
```

The playback protocol uses the stable typed operation names documented above. It does not translate
choices or navigation back into positional/index-based native commands.

## Current Limitations

Tests are runnable end to end through the compiled-project and Runtime Session seam. Remaining work is
editor ergonomics rather than an authoring-to-runtime conversion gap.

Known limitations:

- failure timeline deep-linking is basic and based on matching playback step indexes to authored
  step order;
- step and expectation editing is immediate command commit rather than buffered draft editing.

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
- validation reports missing refs, duplicate IDs, invalid Features, incomplete subject actions,
  incomplete Verb bindings, invalid expectation operators, and missing semantic expectation targets;
- project validation includes test diagnostics;
- `entity.createRecord` creates typed test data;
- `test.replaceData` patches valid data and rejects invalid replacements;
- undo restores previous test data;
- playback spec serialization uses stable Dialogue Edge, Scene Option, Room Exit, subject, Verb,
  save-slot, RuntimeUI document, and element-selector identities and lowers step/final expectations
  into the strict native playback protocol;
- native semantic playback evaluates expectations against public semantic state after deterministic
  settling and reports individual expectation results;
- native UI playback resolves a real visible RmlUi target, dispatches pointer input through the normal
  Layout path, can cause an authoritative gameplay state change, and evaluates it with the same typed
  expectation/reporting contract;
- readiness reflects Test lowering and runtime-artifact compilation honestly.
