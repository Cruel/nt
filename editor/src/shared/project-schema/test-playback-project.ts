import type { ToolDiagnostic } from '../editor-tooling';
import { isAuthoringProject, type AuthoringProject } from './authoring-project';
import { selectedExportProfile } from './authoring-export';
import {
  logicalRuntimeArtifactPaths,
  prepareRuntimeArtifact,
} from '../runtime-artifact-preparation';
import { parseTestData, type TestData, type TestStepData } from './authoring-tests';

export type TestRunReadinessReason =
  | 'runnable'
  | 'not-runnable-invalid-test'
  | 'not-runnable-project-compilation-failed'
  | 'not-runnable-missing-runtime-support';

export interface TestRunReadiness {
  runnable: boolean;
  reason: TestRunReadinessReason;
  diagnostics: ToolDiagnostic[];
}

export interface RuntimePlaybackSpecBuildResult {
  ok: boolean;
  runner?: 'runtime' | 'runtime-ui';
  spec?: unknown;
  project?: unknown;
  diagnostics: ToolDiagnostic[];
}

function diagnostic(
  severity: ToolDiagnostic['severity'],
  path: string,
  message: string,
  category = 'Test playback',
): ToolDiagnostic {
  return { severity, path, message, category };
}

function refId(ref: { $ref: { id: string } } | null | undefined): string {
  return ref?.$ref.id ?? '';
}

function typedSubject(
  subject: TestStepData['selectSubjects']['subjects'][number],
): Record<string, unknown> {
  if (subject.kind === 'character') return { kind: 'character', id: subject.character.$ref.id };
  if (subject.kind === 'interactable')
    return { kind: 'interactable', id: subject.interactable.$ref.id };
  if (subject.kind === 'item-stack') return { kind: 'item-stack', id: subject.itemStack.$ref.id };
  return subject.feature.ownerKind === 'room'
    ? {
        kind: 'feature',
        ownerKind: 'room',
        ownerId: subject.feature.room.$ref.id,
        featureId: subject.feature.featureId,
      }
    : {
        kind: 'feature',
        ownerKind: 'interactable',
        ownerId: subject.feature.interactable.$ref.id,
        featureId: subject.feature.featureId,
      };
}

function buildTypedInput(step: TestStepData): Record<string, unknown> | null {
  if (step.input === 'tick')
    return { type: 'advance-time', microseconds: Math.round(step.tick.deltaSeconds * 1_000_000) };
  if (step.input === 'continue') return { type: 'continue' };
  if (step.input === 'dialogue-choice')
    return { type: 'dialogue-choice', edge: step.dialogueChoice.edgeId };
  if (step.input === 'scene-choice')
    return { type: 'scene-choice', option: step.sceneChoice.optionId };
  if (step.input === 'navigate') return { type: 'navigate', exit: step.navigate.exitId };
  if (step.input === 'select-subjects')
    return { type: 'select-subjects', subjects: step.selectSubjects.subjects.map(typedSubject) };
  if (step.input === 'primary-activate' && step.subjectAction.subject)
    return { type: 'primary-activate', subject: typedSubject(step.subjectAction.subject) };
  if (step.input === 'open-verb-menu' && step.subjectAction.subject)
    return { type: 'open-verb-menu', subject: typedSubject(step.subjectAction.subject) };
  if (step.input === 'clear-subject-selection') return { type: 'clear-selection' };
  if (step.input === 'run-interaction') {
    return {
      type: 'invoke-interaction',
      verb: refId(step.runInteraction.verb),
      bindings: step.runInteraction.bindings.map((binding) => ({
        slotId: binding.slotId,
        subject: typedSubject(binding.subject),
      })),
    };
  }
  if (step.input === 'save' || step.input === 'load') {
    const slot = step.saveSlot.slotId.trim();
    if (slot === 'autosave') return { type: step.input, slot: { kind: 'autosave' } };
    const number = Number(slot.replace(/^slot-?/, ''));
    if (Number.isInteger(number) && number >= 0)
      return { type: step.input, slot: { kind: 'manual', number } };
  }
  return null;
}

async function compiledProjectForAuthoring(project: AuthoringProject): Promise<{
  project?: unknown;
  diagnostics: ToolDiagnostic[];
  ok: boolean;
}> {
  const prepared = await prepareRuntimeArtifact({
    project,
    projectRoot: null,
    profile: selectedExportProfile(project),
    intent: 'test-playback',
    paths: logicalRuntimeArtifactPaths,
  });
  if (prepared.status === 'cancelled') return { diagnostics: prepared.diagnostics, ok: false };
  return {
    project: prepared.assessment.compiledProject,
    diagnostics: prepared.assessment.diagnostics,
    ok: prepared.status === 'prepared',
  };
}

export function buildRuntimePlaybackSpecFromTestData(
  testId: string,
  data: TestData,
): RuntimePlaybackSpecBuildResult {
  const diagnostics: ToolDiagnostic[] = [];
  const steps: Array<{ index: number; input: Record<string, unknown> }> = [];
  data.steps
    .filter((step) => step.enabled)
    .forEach((step, index) => {
      const input = buildTypedInput(step);
      if (!input) {
        diagnostics.push(
          diagnostic(
            'error',
            `/tests/${testId}/data/steps/${index}/input`,
            `Input '${step.input}' does not have a stable typed runtime identity.`,
          ),
        );
        return;
      }
      steps.push({ index, input });
    });
  const spec: Record<string, unknown> = {
    schema: 'noveltea.editor.playback',
    version: 1,
    id: testId,
    steps,
  };
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    runner: 'runtime',
    spec,
    diagnostics,
  };
}

export async function buildRuntimePlaybackSpecFromAuthoringTest(
  project: AuthoringProject,
  testId: string,
): Promise<RuntimePlaybackSpecBuildResult> {
  const record = project.tests[testId];
  if (!record) {
    return {
      ok: false,
      diagnostics: [diagnostic('error', `/tests/${testId}`, 'Test record does not exist.')],
    };
  }
  const data = parseTestData(record.data);
  if (!data) {
    return {
      ok: false,
      diagnostics: [diagnostic('error', `/tests/${testId}/data`, 'Test data is invalid.')],
    };
  }
  const built = buildRuntimePlaybackSpecFromTestData(testId, data);
  const compiledProject = await compiledProjectForAuthoring(project);
  return {
    ...built,
    ok: built.ok && compiledProject.ok,
    project: compiledProject.project,
    diagnostics: [...built.diagnostics, ...compiledProject.diagnostics],
  };
}

export async function getAuthoringTestRunReadiness(
  project: unknown,
  testId: string,
): Promise<TestRunReadiness> {
  if (!isAuthoringProject(project)) {
    return {
      runnable: false,
      reason: 'not-runnable-invalid-test',
      diagnostics: [
        diagnostic('error', '/project', 'The authoring project is invalid and cannot run tests.'),
      ],
    };
  }
  const record = project.tests[testId];
  if (!record) {
    return {
      runnable: false,
      reason: 'not-runnable-invalid-test',
      diagnostics: [diagnostic('error', `/tests/${testId}`, 'Test record does not exist.')],
    };
  }
  const data = parseTestData(record.data);
  if (!data) {
    return {
      runnable: false,
      reason: 'not-runnable-invalid-test',
      diagnostics: [diagnostic('error', `/tests/${testId}/data`, 'Test data is invalid.')],
    };
  }
  const playback = buildRuntimePlaybackSpecFromTestData(testId, data);
  if (!playback.ok) {
    return {
      runnable: false,
      reason: 'not-runnable-missing-runtime-support',
      diagnostics: playback.diagnostics,
    };
  }
  const compiledProject = await compiledProjectForAuthoring(project);
  if (!compiledProject.ok) {
    return {
      runnable: false,
      reason: 'not-runnable-project-compilation-failed',
      diagnostics: compiledProject.diagnostics,
    };
  }
  return {
    runnable: true,
    reason: 'runnable',
    diagnostics: compiledProject.diagnostics.filter((item) => item.severity !== 'error'),
  };
}
