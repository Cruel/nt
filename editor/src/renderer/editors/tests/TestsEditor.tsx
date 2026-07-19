import { useEffect, useMemo, useRef } from 'react';
import { z } from 'zod';
import { SourceEditor } from '@/components/source/SourceEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { registerWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  defaultTestAssertion,
  defaultTestData,
  defaultTestStep,
  parseTestData,
  testAssertionTypeValues,
  testCharacterSubject,
  testDialogueRef,
  testInputTypeValues,
  testInteractableSubject,
  testRoomRef,
  testSceneRef,
  testVariableRef,
  testVerbRef,
  validateTestData,
  type TestAssertionData,
  type TestData,
  type TestEntrypointRef,
  type TestInputType,
  type TestInteractionSubject,
  type TestStepData,
} from '../../../shared/project-schema/authoring-tests';
import {
  buildRuntimePlaybackSpecFromAuthoringTest,
  getAuthoringTestRunReadiness,
} from '../../../shared/project-schema/test-playback-project';
import {
  captureScrollViewState,
  captureSourceEditorViewStates,
  isScrollViewState,
  parseSourceEditorViewStates,
  restoreScrollViewState,
  restoreSourceEditorViewStates,
  useSourceEditorViewStateRefs,
  useWorkbenchEditorTabState,
  type ScrollViewState,
  type SourceEditorViewStates,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const TESTS_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.test';

interface TestsEditorTabStatePayload {
  scroll?: ScrollViewState;
  sourceViewStates?: SourceEditorViewStates;
}

type TestsEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof TESTS_EDITOR_TAB_STATE_SCHEMA;
  payload?: TestsEditorTabStatePayload;
};

function parseTestsEditorTabState(
  value: WorkbenchTabStatePayload,
): TestsEditorTabStatePayload | null {
  if (
    value.schema !== TESTS_EDITOR_TAB_STATE_SCHEMA ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    return null;
  const payload = value.payload as Record<string, unknown>;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    sourceViewStates: parseSourceEditorViewStates(payload.sourceViewStates),
  };
}

function titleCase(value: string) {
  return value
    .split('-')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function nextUniqueId(existing: Iterable<string>, base: string) {
  const normalized = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  const used = new Set(existing);
  if (!used.has(normalized)) return normalized;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${normalized}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${normalized}-${Date.now()}`;
}

function refValue(ref: { $ref: { id: string } } | null | undefined) {
  return ref?.$ref.id ?? '__none__';
}

function subjectId(subject: TestInteractionSubject) {
  return subject.kind === 'character' ? subject.character.$ref.id : subject.interactable.$ref.id;
}

function subjectLabel(subject: TestInteractionSubject) {
  return `${subject.kind}: ${subjectId(subject)}`;
}

function entrypointValue(ref: TestEntrypointRef | null | undefined) {
  return ref ? `${ref.$ref.collection}:${ref.$ref.id}` : '__none__';
}

function makeEntrypoint(value: string): TestEntrypointRef | null {
  if (value === '__none__') return null;
  const [collection, id] = value.split(':');
  if (!id) return null;
  if (collection === 'scenes') return testSceneRef(id);
  if (collection === 'rooms') return testRoomRef(id);
  if (collection === 'dialogues') return testDialogueRef(id);
  return null;
}

function selectedStep(data: TestData) {
  return (
    data.steps.find((step) => step.id === data.preview.selectedStepId) ?? data.steps[0] ?? null
  );
}

const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;

function safeJson(value: string): JsonValue {
  if (!value.trim()) return null;
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : value;
  } catch {
    return value;
  }
}

function commitTest(testId: string, next: TestData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'test.replaceData',
    label,
    payload: { testId, data: next },
    originSaveUnitId: recordSaveUnitId('tests', testId),
    persistencePolicy: 'manual-save',
  });
}

function reportObservationMap(
  report: unknown,
): Map<number, { passed?: boolean; assertion_failures?: unknown[] }> {
  const map = new Map<number, { passed?: boolean; assertion_failures?: unknown[] }>();
  if (typeof report !== 'object' || report === null) return map;
  const observations = (report as { observations?: unknown }).observations;
  if (!Array.isArray(observations)) return map;
  observations.forEach((observation, index) => {
    if (typeof observation !== 'object' || observation === null) return;
    const stepIndex = (observation as { step_index?: unknown }).step_index;
    map.set(typeof stepIndex === 'number' ? stepIndex : index, observation as never);
  });
  return map;
}

export function TestsEditor({ tab }: WorkbenchEditorProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sourceEditors = useSourceEditorViewStateRefs<
    | 'initScript'
    | 'checkScript'
    | 'loadSave'
    | 'stepInitScript'
    | 'stepCheckScript'
    | 'assertionExpected'
  >();
  const projectDocument = useProjectStore((state) => state.document);
  const testId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = testId && project ? project.tests[testId] : null;
  const parsedData = parseTestData(record?.data);
  const data = parsedData ?? defaultTestData(record?.label ?? testId ?? 'Test');
  const setLastPlaybackReport = useWorkspaceStore((state) => state.setLastPlaybackReport);
  const addTimelineEntry = useWorkspaceStore((state) => state.addTimelineEntry);
  const setStatusMessage = useWorkspaceStore((state) => state.setStatusMessage);
  const lastPlaybackReport = useWorkspaceStore((state) => state.lastPlaybackReport);
  const setBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const diagnostics = useMemo(
    () => (project && record && testId ? validateTestData(project, testId, record) : []),
    [project, record, testId],
  );
  const readiness =
    project && testId
      ? getAuthoringTestRunReadiness(project, testId)
      : { runnable: false, diagnostics: [] };
  const diagnosticItems = useMemo(
    () =>
      [...diagnostics, ...readiness.diagnostics].map((item) => ({
        ...item,
        target: project ? resolveProjectDiagnosticTarget(project, item.path) : null,
      })),
    [diagnostics, project, readiness.diagnostics],
  );

  useWorkbenchEditorTabState<TestsEditorTabState>(
    tab.id,
    useMemo(
      () => ({
        captureTabState: () => ({
          schema: TESTS_EDITOR_TAB_STATE_SCHEMA,
          schemaVersion: 1,
          payload: {
            scroll: captureScrollViewState(scrollRef.current),
            sourceViewStates: captureSourceEditorViewStates(sourceEditors.refs.current),
          },
        }),
        restoreTabState: (state: TestsEditorTabState) => {
          const parsed = parseTestsEditorTabState(state);
          if (!parsed) return;
          window.requestAnimationFrame(() => {
            restoreScrollViewState(scrollRef.current, parsed.scroll);
            restoreSourceEditorViewStates(sourceEditors.refs.current, parsed.sourceViewStates);
          });
        },
      }),
      [sourceEditors.refs],
    ),
  );

  useEffect(
    () =>
      registerWorkbenchTargetHandler(tab.id, 'test.step', (target) => {
        if (!testId || !target.id.startsWith('test.step.')) return false;
        const stepId = target.id.slice('test.step.'.length);
        if (!data.steps.some((step) => step.id === stepId)) return false;
        if (data.preview.selectedStepId !== stepId) {
          commitTest(
            testId,
            { ...data, preview: { ...data.preview, selectedStepId: stepId } },
            'Select test step',
          );
        }
        return false;
      }),
    [data, tab.id, testId],
  );

  useEffect(
    () =>
      registerWorkbenchTargetHandler(tab.id, 'test.assertion', (target) => {
        if (!testId || !target.id.startsWith('test.assertion.')) return false;
        const assertionId = target.id.slice('test.assertion.'.length);
        const step = data.steps.find((item) =>
          item.assertions.some((assertion) => assertion.id === assertionId),
        );
        if (!step) return false;
        if (data.preview.selectedStepId !== step.id) {
          commitTest(
            testId,
            { ...data, preview: { ...data.preview, selectedStepId: step.id } },
            'Select test assertion',
          );
        }
        return false;
      }),
    [data, tab.id, testId],
  );

  if (!testId || !record || !project)
    return <div className="p-4 text-sm text-muted-foreground">Test record not found.</div>;

  const activeTestId = testId;
  const activeProject = project;
  const activeStep = selectedStep(data);
  const activeStepIndex = activeStep
    ? data.steps.findIndex((step) => step.id === activeStep.id)
    : -1;
  const observations = reportObservationMap(lastPlaybackReport);
  const entrypoints = [
    ...Object.entries(activeProject.scenes).map(([id, item]) => ({
      value: `scenes:${id}`,
      label: `Scene: ${item.label} (${id})`,
    })),
    ...Object.entries(activeProject.rooms).map(([id, item]) => ({
      value: `rooms:${id}`,
      label: `Room: ${item.label} (${id})`,
    })),
    ...Object.entries(activeProject.dialogues).map(([id, item]) => ({
      value: `dialogues:${id}`,
      label: `Dialogue: ${item.label} (${id})`,
    })),
  ];
  const objects = Object.entries(activeProject.interactables).map(([id, item]) => ({
    id,
    label: item.label,
  }));
  const characters = Object.entries(activeProject.characters).map(([id, item]) => ({
    id,
    label: item.label,
  }));
  const verbs = Object.entries(activeProject.verbs).map(([id, item]) => ({
    id,
    label: item.label,
  }));
  const variables = Object.entries(activeProject.variables).map(([id, item]) => ({
    id,
    label: item.label,
  }));

  function commit(next: TestData, label = 'Update test') {
    commitTest(activeTestId, next, label);
  }

  function patch(patchData: Partial<TestData>, label = 'Update test') {
    commit({ ...data, ...patchData }, label);
  }

  function patchPreview(patchData: Partial<TestData['preview']>) {
    patch({ preview: { ...data.preview, ...patchData } }, 'Update test preview');
  }

  function replaceStep(stepId: string, patchData: Partial<TestStepData>) {
    commit(
      {
        ...data,
        steps: data.steps.map((step) => (step.id === stepId ? { ...step, ...patchData } : step)),
      },
      'Update test step',
    );
  }

  function addStep(input: TestInputType) {
    const id = nextUniqueId(
      data.steps.map((step) => step.id),
      input,
    );
    const step = { ...defaultTestStep(input, titleCase(input)), id, label: titleCase(input) };
    const steps = [...data.steps];
    const insertIndex = activeStepIndex >= 0 ? activeStepIndex + 1 : steps.length;
    steps.splice(insertIndex, 0, step);
    commit({ ...data, steps, preview: { ...data.preview, selectedStepId: id } }, 'Add test step');
  }

  function duplicateStep(step: TestStepData) {
    const id = nextUniqueId(
      data.steps.map((item) => item.id),
      `${step.id}-copy`,
    );
    const index = data.steps.findIndex((item) => item.id === step.id);
    const steps = [...data.steps];
    steps.splice(index + 1, 0, { ...step, id, label: `${step.label} Copy` });
    commit(
      { ...data, steps, preview: { ...data.preview, selectedStepId: id } },
      'Duplicate test step',
    );
  }

  function deleteStep(stepId: string) {
    if (data.steps.length <= 1) return;
    const index = data.steps.findIndex((step) => step.id === stepId);
    const steps = data.steps.filter((step) => step.id !== stepId);
    const fallback = steps[Math.max(0, Math.min(index, steps.length - 1))] ?? steps[0];
    commit(
      { ...data, steps, preview: { ...data.preview, selectedStepId: fallback?.id ?? null } },
      'Delete test step',
    );
  }

  function moveStep(stepId: string, direction: -1 | 1) {
    const index = data.steps.findIndex((step) => step.id === stepId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= data.steps.length) return;
    const steps = [...data.steps];
    const [step] = steps.splice(index, 1);
    steps.splice(nextIndex, 0, step!);
    commit({ ...data, steps }, 'Move test step');
  }

  function addAssertion(step: TestStepData) {
    const id = nextUniqueId(
      step.assertions.map((assertion) => assertion.id),
      'assertion',
    );
    replaceStep(step.id, {
      assertions: [
        ...step.assertions,
        { ...defaultTestAssertion('mode'), id, label: 'Assertion', enabled: false },
      ],
    });
  }

  function replaceAssertion(
    step: TestStepData,
    assertionId: string,
    patchData: Partial<TestAssertionData>,
  ) {
    replaceStep(step.id, {
      assertions: step.assertions.map((assertion) =>
        assertion.id === assertionId ? { ...assertion, ...patchData } : assertion,
      ),
    });
  }

  function duplicateAssertion(step: TestStepData, assertion: TestAssertionData) {
    const id = nextUniqueId(
      step.assertions.map((item) => item.id),
      `${assertion.id}-copy`,
    );
    const index = step.assertions.findIndex((item) => item.id === assertion.id);
    const assertions = [...step.assertions];
    assertions.splice(index + 1, 0, { ...assertion, id, label: `${assertion.label} Copy` });
    replaceStep(step.id, { assertions });
  }

  function deleteAssertion(step: TestStepData, assertionId: string) {
    replaceStep(step.id, {
      assertions: step.assertions.filter((assertion) => assertion.id !== assertionId),
    });
  }

  async function runCurrentTest() {
    setBottomPanel('test-playback');
    if (!readiness.runnable) {
      const report = {
        id: activeTestId,
        passed: false,
        failures: readiness.diagnostics.map((item) => item.message),
        diagnostics: readiness.diagnostics,
        observations: [],
      };
      setLastPlaybackReport(report);
      setStatusMessage(readiness.diagnostics[0]?.message ?? 'Test is not runnable yet.');
      addTimelineEntry({ source: 'playback', message: 'Test is not runnable yet', detail: report });
      return;
    }
    const spec = buildRuntimePlaybackSpecFromAuthoringTest(activeProject, activeTestId);
    if (!spec.ok || !spec.spec) {
      setLastPlaybackReport({
        id: activeTestId,
        passed: false,
        failures: spec.diagnostics.map((item) => item.message),
        diagnostics: spec.diagnostics,
        observations: [],
      });
      return;
    }
    const runnerProject =
      spec.runner === 'runtime-ui' ? (spec.project ?? activeProject) : activeProject;
    const result =
      spec.runner === 'runtime-ui'
        ? await window.noveltea.runUiPlaybackSpec(runnerProject, spec.spec)
        : await window.noveltea.runPlaybackSpec(runnerProject, spec.spec);
    setLastPlaybackReport(result.report ?? result);
    setStatusMessage(result.ok ? `Ran test ${activeTestId}` : (result.error ?? 'Test run failed'));
    addTimelineEntry({
      source: 'playback',
      message: result.ok ? `Ran test ${activeTestId}` : (result.error ?? 'Test run failed'),
      detail: result,
    });
  }

  return (
    <div
      ref={scrollRef}
      className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4"
      data-tests-editor-scroll
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{record.label}</h2>
            <Badge variant="outline">{activeTestId}</Badge>
            <Badge variant={readiness.runnable ? 'default' : 'secondary'}>
              {readiness.runnable ? 'runnable' : 'not runnable'}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Deterministic playback test authoring with command-backed steps, assertions, and report
            inspection.
          </p>
          {!readiness.runnable ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {readiness.diagnostics[0]?.message}
            </p>
          ) : null}
        </div>
        <Button size="sm" onClick={() => void runCurrentTest()}>
          Run Test
        </Button>
      </div>

      {!parsedData ? (
        <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Test data was invalid; showing editable defaults until you apply a change.
        </div>
      ) : null}

      <div
        className="mt-4 grid gap-4 xl:grid-cols-[minmax(360px,1fr)_440px]"
        data-workbench-anchor="test.summary"
      >
        <div className="space-y-4">
          <section className="grid gap-3 rounded border p-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input
                value={data.displayName}
                onChange={(event) =>
                  patch({ displayName: event.currentTarget.value }, 'Update test display name')
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Entrypoint</Label>
              <Select
                value={entrypointValue(data.entrypoint)}
                onValueChange={(value) =>
                  patch({ entrypoint: makeEntrypoint(String(value)) }, 'Update test entrypoint')
                }
              >
                <SelectItem value="__none__">No entrypoint</SelectItem>
                {entrypoints.map((entrypoint) => (
                  <SelectItem key={entrypoint.value} value={entrypoint.value}>
                    {entrypoint.label}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Fixed delta seconds</Label>
              <Input
                value={data.fixedDeltaSeconds === null ? '' : String(data.fixedDeltaSeconds)}
                placeholder="default"
                onChange={(event) =>
                  patch(
                    {
                      fixedDeltaSeconds: event.currentTarget.value.trim()
                        ? Math.max(0, Number.parseFloat(event.currentTarget.value) || 0)
                        : null,
                    },
                    'Update test fixed delta',
                  )
                }
              />
            </div>
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Steps</h3>
              <div className="flex flex-wrap gap-2">
                {testInputTypeValues.map((input) => (
                  <Button key={input} size="sm" variant="outline" onClick={() => addStep(input)}>
                    {titleCase(input)}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              {data.steps.map((step, index) => {
                const observation = observations.get(index);
                return (
                  <button
                    key={step.id}
                    type="button"
                    data-workbench-anchor={`test.step.${step.id || index}`}
                    className={`w-full rounded border p-3 text-left text-sm ${step.id === activeStep?.id ? 'border-primary bg-primary/5' : 'bg-background'}`}
                    onClick={() => patchPreview({ selectedStepId: step.id })}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{index + 1}</Badge>
                      <span className="font-medium">{step.label}</span>
                      <span className="text-xs text-muted-foreground">{step.input}</span>
                      {!step.enabled ? <Badge variant="outline">disabled</Badge> : null}
                      {observation ? (
                        <Badge variant={observation.passed === false ? 'destructive' : 'secondary'}>
                          {observation.passed === false ? 'failed' : 'passed'}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {step.id}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="grid gap-3 rounded border p-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Init script</Label>
              <SourceEditor
                ref={sourceEditors.refFor('initScript')}
                className="h-32"
                language="lua"
                value={data.initScript}
                onChange={(initScript) => patch({ initScript }, 'Update test init script')}
              />
            </div>
            <div className="space-y-1">
              <Label>Check script</Label>
              <SourceEditor
                ref={sourceEditors.refFor('checkScript')}
                className="h-32"
                language="lua"
                value={data.checkScript}
                onChange={(checkScript) => patch({ checkScript }, 'Update test check script')}
              />
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          {activeStep ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Selected step</h3>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => moveStep(activeStep.id, -1)}>
                    Up
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => moveStep(activeStep.id, 1)}>
                    Down
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => duplicateStep(activeStep)}>
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => deleteStep(activeStep.id)}
                    disabled={data.steps.length <= 1}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input
                    value={activeStep.label}
                    onChange={(event) =>
                      replaceStep(activeStep.id, { label: event.currentTarget.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>Input</Label>
                  <Select
                    value={activeStep.input}
                    onValueChange={(value) =>
                      replaceStep(activeStep.id, { input: value as TestInputType })
                    }
                  >
                    {testInputTypeValues.map((input) => (
                      <SelectItem key={input} value={input}>
                        {input}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={activeStep.enabled}
                    onCheckedChange={(checked) =>
                      replaceStep(activeStep.id, { enabled: Boolean(checked) })
                    }
                  />{' '}
                  Enabled
                </label>
                <div className="space-y-1">
                  <Label>Delta seconds override</Label>
                  <Input
                    value={activeStep.deltaSeconds === null ? '' : String(activeStep.deltaSeconds)}
                    onChange={(event) =>
                      replaceStep(activeStep.id, {
                        deltaSeconds: event.currentTarget.value.trim()
                          ? Math.max(0, Number.parseFloat(event.currentTarget.value) || 0)
                          : null,
                      })
                    }
                  />
                </div>
              </div>

              {activeStep.input === 'tick' ? (
                <Input
                  aria-label="Tick delta seconds"
                  value={String(activeStep.tick.deltaSeconds)}
                  onChange={(event) =>
                    replaceStep(activeStep.id, {
                      tick: {
                        deltaSeconds: Math.max(
                          0,
                          Number.parseFloat(event.currentTarget.value) || 0,
                        ),
                      },
                    })
                  }
                />
              ) : null}
              {activeStep.input === 'dialogue-option' ? (
                <Input
                  aria-label="Dialogue option index"
                  value={String(activeStep.dialogueOption.optionIndex)}
                  onChange={(event) =>
                    replaceStep(activeStep.id, {
                      dialogueOption: {
                        optionIndex: Math.max(
                          0,
                          Number.parseInt(event.currentTarget.value, 10) || 0,
                        ),
                      },
                    })
                  }
                />
              ) : null}
              {activeStep.input === 'navigate' ? (
                <Input
                  aria-label="Navigation direction"
                  value={String(activeStep.navigate.direction)}
                  onChange={(event) =>
                    replaceStep(activeStep.id, {
                      navigate: {
                        ...activeStep.navigate,
                        direction: Math.max(
                          0,
                          Math.min(7, Number.parseInt(event.currentTarget.value, 10) || 0),
                        ),
                      },
                    })
                  }
                />
              ) : null}
              {activeStep.input === 'select-subjects' ? (
                <div className="space-y-2">
                  <Select
                    value="__add__"
                    onValueChange={(value) =>
                      value !== '__add__' &&
                      replaceStep(activeStep.id, {
                        selectSubjects: {
                          subjects: [
                            ...activeStep.selectSubjects.subjects,
                            testCharacterSubject(String(value)),
                          ],
                        },
                      })
                    }
                  >
                    <SelectItem value="__add__">Add character</SelectItem>
                    {characters.map((character) => (
                      <SelectItem key={character.id} value={character.id}>
                        {character.label} ({character.id})
                      </SelectItem>
                    ))}
                  </Select>
                  <Select
                    value="__add__"
                    onValueChange={(value) =>
                      value !== '__add__' &&
                      replaceStep(activeStep.id, {
                        selectSubjects: {
                          subjects: [
                            ...activeStep.selectSubjects.subjects,
                            testInteractableSubject(String(value)),
                          ],
                        },
                      })
                    }
                  >
                    <SelectItem value="__add__">Add interactable</SelectItem>
                    {objects.map((object) => (
                      <SelectItem key={object.id} value={object.id}>
                        {object.label} ({object.id})
                      </SelectItem>
                    ))}
                  </Select>
                  {activeStep.selectSubjects.subjects.map((subject, index) => (
                    <Button
                      key={`${subject.kind}-${subjectId(subject)}-${index}`}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        replaceStep(activeStep.id, {
                          selectSubjects: {
                            subjects: activeStep.selectSubjects.subjects.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          },
                        })
                      }
                    >
                      Remove {subjectLabel(subject)}
                    </Button>
                  ))}
                </div>
              ) : null}
              {activeStep.input === 'run-interaction' ? (
                <div className="space-y-2">
                  <Select
                    value={refValue(activeStep.runInteraction.verb)}
                    onValueChange={(value) =>
                      replaceStep(activeStep.id, {
                        runInteraction: {
                          ...activeStep.runInteraction,
                          verb: String(value) === '__none__' ? null : testVerbRef(String(value)),
                        },
                      })
                    }
                  >
                    <SelectItem value="__none__">No verb</SelectItem>
                    {verbs.map((verb) => (
                      <SelectItem key={verb.id} value={verb.id}>
                        {verb.label} ({verb.id})
                      </SelectItem>
                    ))}
                  </Select>
                  <Select
                    value="__add__"
                    onValueChange={(value) =>
                      value !== '__add__' &&
                      replaceStep(activeStep.id, {
                        runInteraction: {
                          ...activeStep.runInteraction,
                          operands: [
                            ...activeStep.runInteraction.operands,
                            testCharacterSubject(String(value)),
                          ],
                        },
                      })
                    }
                  >
                    <SelectItem value="__add__">Add character operand</SelectItem>
                    {characters.map((character) => (
                      <SelectItem key={character.id} value={character.id}>
                        {character.label} ({character.id})
                      </SelectItem>
                    ))}
                  </Select>
                  <Select
                    value="__add__"
                    onValueChange={(value) =>
                      value !== '__add__' &&
                      replaceStep(activeStep.id, {
                        runInteraction: {
                          ...activeStep.runInteraction,
                          operands: [
                            ...activeStep.runInteraction.operands,
                            testInteractableSubject(String(value)),
                          ],
                        },
                      })
                    }
                  >
                    <SelectItem value="__add__">Add interactable operand</SelectItem>
                    {objects.map((object) => (
                      <SelectItem key={object.id} value={object.id}>
                        {object.label} ({object.id})
                      </SelectItem>
                    ))}
                  </Select>
                  {activeStep.runInteraction.operands.map((subject, index) => (
                    <Button
                      key={`${subject.kind}-${subjectId(subject)}-${index}`}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        replaceStep(activeStep.id, {
                          runInteraction: {
                            ...activeStep.runInteraction,
                            operands: activeStep.runInteraction.operands.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          },
                        })
                      }
                    >
                      Remove {subjectLabel(subject)}
                    </Button>
                  ))}
                </div>
              ) : null}
              {activeStep.input === 'load-save' ? (
                <SourceEditor
                  ref={sourceEditors.refFor('loadSave')}
                  className="h-32"
                  language="json"
                  value={JSON.stringify(activeStep.loadSave.payload, null, 2)}
                  onChange={(source) =>
                    replaceStep(activeStep.id, {
                      loadSave: { ...activeStep.loadSave, payload: safeJson(source) },
                    })
                  }
                />
              ) : null}
              {activeStep.input === 'set-entrypoint' ? (
                <Select
                  value={entrypointValue(activeStep.setEntrypoint.entrypoint)}
                  onValueChange={(value) =>
                    replaceStep(activeStep.id, {
                      setEntrypoint: { entrypoint: makeEntrypoint(String(value)) },
                    })
                  }
                >
                  <SelectItem value="__none__">No entrypoint</SelectItem>
                  {entrypoints.map((entrypoint) => (
                    <SelectItem key={entrypoint.value} value={entrypoint.value}>
                      {entrypoint.label}
                    </SelectItem>
                  ))}
                </Select>
              ) : null}
              {activeStep.input === 'ui-click' ? (
                <div className="grid gap-2">
                  <div className="space-y-1">
                    <Label>Document ID</Label>
                    <Input
                      value={activeStep.uiClick.documentId}
                      onChange={(event) =>
                        replaceStep(activeStep.id, {
                          uiClick: { ...activeStep.uiClick, documentId: event.currentTarget.value },
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Target</Label>
                    <Input
                      value={activeStep.uiClick.target}
                      onChange={(event) =>
                        replaceStep(activeStep.id, {
                          uiClick: {
                            ...activeStep.uiClick,
                            target: event.currentTarget.value,
                            selector: event.currentTarget.value,
                          },
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Selector</Label>
                    <Input
                      value={activeStep.uiClick.selector}
                      onChange={(event) =>
                        replaceStep(activeStep.id, {
                          uiClick: {
                            ...activeStep.uiClick,
                            selector: event.currentTarget.value,
                            target: event.currentTarget.value,
                          },
                        })
                      }
                    />
                  </div>
                </div>
              ) : null}

              <div className="grid gap-2">
                <Label>Step init script</Label>
                <SourceEditor
                  ref={sourceEditors.refFor('stepInitScript')}
                  className="h-24"
                  language="lua"
                  value={activeStep.initScript}
                  onChange={(initScript) => replaceStep(activeStep.id, { initScript })}
                />
                <Label>Step check script</Label>
                <SourceEditor
                  ref={sourceEditors.refFor('stepCheckScript')}
                  className="h-24"
                  language="lua"
                  value={activeStep.checkScript}
                  onChange={(checkScript) => replaceStep(activeStep.id, { checkScript })}
                />
              </div>
            </section>
          ) : null}

          {activeStep ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Assertions</h3>
                <Button size="sm" variant="outline" onClick={() => addAssertion(activeStep)}>
                  Add Assertion
                </Button>
              </div>
              {activeStep.assertions.length === 0 ? (
                <div className="text-xs text-muted-foreground">No assertions.</div>
              ) : null}
              {activeStep.assertions.map((assertion, index) => (
                <div
                  key={assertion.id}
                  className="space-y-2 rounded border p-2"
                  data-workbench-anchor={`test.assertion.${assertion.id || index}`}
                >
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={assertion.enabled}
                      onCheckedChange={(checked) =>
                        replaceAssertion(activeStep, assertion.id, { enabled: Boolean(checked) })
                      }
                    />
                    <Input
                      value={assertion.label}
                      onChange={(event) =>
                        replaceAssertion(activeStep, assertion.id, {
                          label: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                  <Select
                    value={assertion.type}
                    onValueChange={(value) =>
                      replaceAssertion(activeStep, assertion.id, {
                        type: value as TestAssertionData['type'],
                      })
                    }
                  >
                    {testAssertionTypeValues.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </Select>
                  <Input
                    value={assertion.value}
                    placeholder="Value"
                    onChange={(event) =>
                      replaceAssertion(activeStep, assertion.id, {
                        value: event.currentTarget.value,
                      })
                    }
                  />
                  <Input
                    value={assertion.key}
                    placeholder="Key"
                    onChange={(event) =>
                      replaceAssertion(activeStep, assertion.id, { key: event.currentTarget.value })
                    }
                  />
                  <Select
                    value={refValue(assertion.variable)}
                    onValueChange={(value) =>
                      replaceAssertion(activeStep, assertion.id, {
                        variable:
                          String(value) === '__none__' ? null : testVariableRef(String(value)),
                      })
                    }
                  >
                    <SelectItem value="__none__">No variable</SelectItem>
                    {variables.map((variable) => (
                      <SelectItem key={variable.id} value={variable.id}>
                        {variable.label} ({variable.id})
                      </SelectItem>
                    ))}
                  </Select>
                  <SourceEditor
                    ref={sourceEditors.refFor('assertionExpected')}
                    className="h-20"
                    language="json"
                    value={JSON.stringify(assertion.expected, null, 2)}
                    onChange={(source) =>
                      replaceAssertion(activeStep, assertion.id, { expected: safeJson(source) })
                    }
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => duplicateAssertion(activeStep, assertion)}
                    >
                      Duplicate Assertion
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => deleteAssertion(activeStep, assertion.id)}
                    >
                      Delete Assertion
                    </Button>
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          <section
            className="space-y-2 rounded border p-3"
            data-workbench-anchor="test.diagnostics"
          >
            <h3 className="text-sm font-medium">Diagnostics</h3>
            <DiagnosticList items={diagnosticItems} emptyMessage="No test diagnostics." />
          </section>
        </aside>
      </div>
    </div>
  );
}
