import { useEffect, useMemo, useRef, useState } from 'react';
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
  defaultTestData,
  defaultTestStep,
  parseTestData,
  testCharacterSubject,
  testFeatureSubject,
  testInputTypeValues,
  testInteractableSubject,
  testItemStackSubject,
  testVerbRef,
  validateTestData,
  type TestData,
  type TestInputType,
  type TestInteractionSubject,
  type TestStepData,
} from '../../../shared/project-schema/authoring-tests';
import { parseRoomData } from '../../../shared/project-schema/authoring-rooms';
import { parseInteractableData } from '../../../shared/project-schema/authoring-interactables';
import { parseVerbData } from '../../../shared/project-schema/authoring-verbs';
import {
  buildRuntimePlaybackSpecFromAuthoringTest,
  getAuthoringTestRunReadiness,
  type TestRunReadiness,
} from '../../../shared/project-schema/test-playback-project';
import {
  captureScrollViewState,
  isScrollViewState,
  restoreScrollViewState,
  useWorkbenchEditorTabState,
  type ScrollViewState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const TESTS_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.test';

interface TestsEditorTabStatePayload {
  scroll?: ScrollViewState;
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
  if (subject.kind === 'character') return subject.character.$ref.id;
  if (subject.kind === 'interactable') return subject.interactable.$ref.id;
  if (subject.kind === 'item-stack') return subject.itemStack.$ref.id;
  return subject.feature.ownerKind === 'room'
    ? `${subject.feature.room.$ref.id}:${subject.feature.featureId}`
    : `${subject.feature.interactable.$ref.id}:${subject.feature.featureId}`;
}

function subjectLabel(subject: TestInteractionSubject) {
  return `${subject.kind}: ${subjectId(subject)}`;
}

function selectedStep(data: TestData) {
  return (
    data.steps.find((step) => step.id === data.preview.selectedStepId) ?? data.steps[0] ?? null
  );
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
): Map<number, { handled: boolean; diagnostics: unknown[] }> {
  const map = new Map<number, { handled: boolean; diagnostics: unknown[] }>();
  if (typeof report !== 'object' || report === null) return map;
  const steps = (report as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return map;
  steps.forEach((step, index) => {
    if (typeof step !== 'object' || step === null) return;
    const value = step as { index?: unknown; handled?: unknown; diagnostics?: unknown };
    map.set(typeof value.index === 'number' ? value.index : index, {
      handled: value.handled === true,
      diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics : [],
    });
  });
  return map;
}

export function TestsEditor({ tab }: WorkbenchEditorProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
  const [readiness, setReadiness] = useState<TestRunReadiness>({
    runnable: false,
    reason: 'not-runnable-invalid-test',
    diagnostics: [],
  });
  useEffect(() => {
    let current = true;
    if (!project || !testId) {
      setReadiness({
        runnable: false,
        reason: 'not-runnable-invalid-test',
        diagnostics: [],
      });
      return () => {
        current = false;
      };
    }
    void getAuthoringTestRunReadiness(project, testId).then((next) => {
      if (current) setReadiness(next);
    });
    return () => {
      current = false;
    };
  }, [project, testId]);
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
        schema: TESTS_EDITOR_TAB_STATE_SCHEMA,
        captureTabState: () => ({
          schema: TESTS_EDITOR_TAB_STATE_SCHEMA,
          payload: {
            scroll: captureScrollViewState(scrollRef.current),
          },
        }),
        restoreTabState: (state: TestsEditorTabState) => {
          const parsed = parseTestsEditorTabState(state);
          if (!parsed) return;
          window.requestAnimationFrame(() => {
            restoreScrollViewState(scrollRef.current, parsed.scroll);
          });
        },
      }),
      [],
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

  if (!testId || !record || !project)
    return <div className="p-4 text-sm text-muted-foreground">Test record not found.</div>;

  const activeTestId = testId;
  const activeProject = project;
  const activeStep = selectedStep(data);
  const activeStepIndex = activeStep
    ? data.steps.findIndex((step) => step.id === activeStep.id)
    : -1;
  const observations = reportObservationMap(lastPlaybackReport);
  const objects = Object.entries(activeProject.interactables).map(([id, item]) => ({
    id,
    label: item.label,
  }));
  const characters = Object.entries(activeProject.characters).map(([id, item]) => ({
    id,
    label: item.label,
  }));
  const itemStacks: Array<{ id: string; label: string }> = [];
  const verbs = Object.entries(activeProject.verbs).map(([id, item]) => ({
    id,
    label: item.label,
    bindingOrder: parseVerbData(item.data)?.bindingOrder ?? [],
  }));
  const activeRunInteractionVerb =
    activeStep?.input === 'run-interaction'
      ? verbs.find((verb) => verb.id === refValue(activeStep.runInteraction.verb))
      : undefined;
  const nextRunInteractionSlotId =
    activeStep?.input === 'run-interaction'
      ? activeRunInteractionVerb?.bindingOrder[activeStep.runInteraction.bindings.length]
      : undefined;
  const features = [
    ...Object.entries(activeProject.rooms).flatMap(([roomId, item]) =>
      (parseRoomData(item.data)?.features ?? []).map((feature) => ({
        value: `room:${roomId}:${feature.id}`,
        label: `Room: ${item.label} / ${feature.label}`,
        subject: testFeatureSubject({
          ownerKind: 'room',
          room: { $ref: { collection: 'rooms', id: roomId } },
          featureId: feature.id,
        }),
      })),
    ),
    ...Object.entries(activeProject.interactableInstances).flatMap(([instanceId, instance]) => {
      const item = activeProject.interactables[instance.definition.$ref.id];
      return (parseInteractableData(item?.data)?.features ?? []).map((feature) => ({
        value: `interactable:${instanceId}:${feature.id}`,
        label: `Interactable Instance: ${instance.editorLabel ?? instanceId} / ${feature.label}`,
        subject: testFeatureSubject({
          ownerKind: 'interactable',
          interactable: { $ref: { registry: 'interactableInstances', id: instanceId } },
          featureId: feature.id,
        }),
      }));
    }),
  ];

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

  async function runCurrentTest() {
    setBottomPanel('test-playback');
    const currentReadiness = await getAuthoringTestRunReadiness(activeProject, activeTestId);
    setReadiness(currentReadiness);
    if (!currentReadiness.runnable) {
      const report = {
        id: activeTestId,
        passed: false,
        failures: currentReadiness.diagnostics.map((item) => item.message),
        diagnostics: currentReadiness.diagnostics,
        observations: [],
      };
      setLastPlaybackReport(report);
      setStatusMessage(currentReadiness.diagnostics[0]?.message ?? 'Test is not runnable yet.');
      addTimelineEntry({ source: 'playback', message: 'Test is not runnable yet', detail: report });
      return;
    }
    const spec = await buildRuntimePlaybackSpecFromAuthoringTest(activeProject, activeTestId);
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
    const runnerProject = spec.project ?? activeProject;
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
            Deterministic playback test authoring with semantic runtime identities and public report
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
          <section className="rounded border p-3">
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input
                value={data.displayName}
                onChange={(event) =>
                  patch({ displayName: event.currentTarget.value }, 'Update test display name')
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
                        <Badge
                          variant={
                            !observation.handled || observation.diagnostics.length > 0
                              ? 'destructive'
                              : 'secondary'
                          }
                        >
                          {!observation.handled || observation.diagnostics.length > 0
                            ? 'failed'
                            : 'handled'}
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
              {activeStep.input === 'dialogue-choice' ? (
                <Input
                  aria-label="Dialogue edge ID"
                  value={activeStep.dialogueChoice.edgeId}
                  onChange={(event) =>
                    replaceStep(activeStep.id, {
                      dialogueChoice: { edgeId: event.currentTarget.value },
                    })
                  }
                />
              ) : null}
              {activeStep.input === 'scene-choice' ? (
                <Input
                  aria-label="Scene choice option ID"
                  value={activeStep.sceneChoice.optionId}
                  onChange={(event) =>
                    replaceStep(activeStep.id, {
                      sceneChoice: { optionId: event.currentTarget.value },
                    })
                  }
                />
              ) : null}
              {activeStep.input === 'navigate' ? (
                <Input
                  aria-label="Room exit ID"
                  value={activeStep.navigate.exitId}
                  onChange={(event) =>
                    replaceStep(activeStep.id, {
                      navigate: { exitId: event.currentTarget.value },
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
                            testItemStackSubject(String(value)),
                          ],
                        },
                      })
                    }
                  >
                    <SelectItem value="__add__">Add item Stack</SelectItem>
                    {itemStacks.map((stack) => (
                      <SelectItem key={stack.id} value={stack.id}>
                        {stack.label} ({stack.id})
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
                  <Select
                    value="__add__"
                    onValueChange={(value) => {
                      const feature = features.find((item) => item.value === String(value));
                      if (!feature) return;
                      replaceStep(activeStep.id, {
                        selectSubjects: {
                          subjects: [...activeStep.selectSubjects.subjects, feature.subject],
                        },
                      });
                    }}
                  >
                    <SelectItem value="__add__">Add Feature</SelectItem>
                    {features.map((feature) => (
                      <SelectItem key={feature.value} value={feature.value}>
                        {feature.label}
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
                          bindings: [],
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
                  {nextRunInteractionSlotId ? (
                    <Select
                      value="__add__"
                      onValueChange={(value) =>
                        value !== '__add__' &&
                        replaceStep(activeStep.id, {
                          runInteraction: {
                            ...activeStep.runInteraction,
                            bindings: [
                              ...activeStep.runInteraction.bindings,
                              {
                                slotId: nextRunInteractionSlotId,
                                subject: testCharacterSubject(String(value)),
                              },
                            ],
                          },
                        })
                      }
                    >
                      <SelectItem value="__add__">
                        Bind Character to {nextRunInteractionSlotId}
                      </SelectItem>
                      {characters.map((character) => (
                        <SelectItem key={character.id} value={character.id}>
                          {character.label} ({character.id})
                        </SelectItem>
                      ))}
                    </Select>
                  ) : null}
                  {nextRunInteractionSlotId ? (
                    <Select
                      value="__add__"
                      onValueChange={(value) =>
                        value !== '__add__' &&
                        replaceStep(activeStep.id, {
                          runInteraction: {
                            ...activeStep.runInteraction,
                            bindings: [
                              ...activeStep.runInteraction.bindings,
                              {
                                slotId: nextRunInteractionSlotId,
                                subject: testInteractableSubject(String(value)),
                              },
                            ],
                          },
                        })
                      }
                    >
                      <SelectItem value="__add__">
                        Bind Interactable to {nextRunInteractionSlotId}
                      </SelectItem>
                      {objects.map((object) => (
                        <SelectItem key={object.id} value={object.id}>
                          {object.label} ({object.id})
                        </SelectItem>
                      ))}
                    </Select>
                  ) : null}
                  {nextRunInteractionSlotId ? (
                    <Select
                      value="__add__"
                      onValueChange={(value) =>
                        value !== '__add__' &&
                        replaceStep(activeStep.id, {
                          runInteraction: {
                            ...activeStep.runInteraction,
                            bindings: [
                              ...activeStep.runInteraction.bindings,
                              {
                                slotId: nextRunInteractionSlotId,
                                subject: testItemStackSubject(String(value)),
                              },
                            ],
                          },
                        })
                      }
                    >
                      <SelectItem value="__add__">
                        Bind Item Stack to {nextRunInteractionSlotId}
                      </SelectItem>
                      {itemStacks.map((stack) => (
                        <SelectItem key={stack.id} value={stack.id}>
                          {stack.label} ({stack.id})
                        </SelectItem>
                      ))}
                    </Select>
                  ) : null}
                  {nextRunInteractionSlotId ? (
                    <Select
                      value="__add__"
                      onValueChange={(value) => {
                        const feature = features.find((item) => item.value === String(value));
                        if (!feature) return;
                        replaceStep(activeStep.id, {
                          runInteraction: {
                            ...activeStep.runInteraction,
                            bindings: [
                              ...activeStep.runInteraction.bindings,
                              { slotId: nextRunInteractionSlotId, subject: feature.subject },
                            ],
                          },
                        });
                      }}
                    >
                      <SelectItem value="__add__">
                        Bind Feature to {nextRunInteractionSlotId}
                      </SelectItem>
                      {features.map((feature) => (
                        <SelectItem key={feature.value} value={feature.value}>
                          {feature.label}
                        </SelectItem>
                      ))}
                    </Select>
                  ) : activeRunInteractionVerb ? (
                    <p className="text-xs text-muted-foreground">
                      All required Verb slots are bound.
                    </p>
                  ) : null}
                  {activeStep.runInteraction.bindings.map((binding, index) => (
                    <Button
                      key={`${binding.slotId}-${binding.subject.kind}-${subjectId(binding.subject)}-${index}`}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        replaceStep(activeStep.id, {
                          runInteraction: {
                            ...activeStep.runInteraction,
                            bindings: activeStep.runInteraction.bindings.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          },
                        })
                      }
                    >
                      Remove {binding.slotId}: {subjectLabel(binding.subject)}
                    </Button>
                  ))}
                </div>
              ) : null}
              {activeStep.input === 'save' || activeStep.input === 'load' ? (
                <div className="space-y-1">
                  <Label>Save slot</Label>
                  <Input
                    aria-label="Save slot"
                    value={activeStep.saveSlot.slotId}
                    placeholder="autosave or slot-1"
                    onChange={(event) =>
                      replaceStep(activeStep.id, {
                        saveSlot: { slotId: event.currentTarget.value },
                      })
                    }
                  />
                </div>
              ) : null}
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
