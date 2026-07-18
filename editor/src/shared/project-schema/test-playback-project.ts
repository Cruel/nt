import type { ToolDiagnostic } from '../editor-tooling';
import { isAuthoringProject, type AuthoringProject } from './authoring-project';
import { selectedExportProfile } from './authoring-export';
import { buildCompiledRuntimeExport } from './compiled-runtime-export';
import {
  parseTestData,
  type TestData,
  type TestStepData,
} from './authoring-tests';

export type TestRunReadinessReason =
  | 'runnable'
  | 'not-runnable-authoring-conversion-missing'
  | 'not-runnable-invalid-test'
  | 'not-runnable-missing-entrypoint'
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

function diagnostic(severity: ToolDiagnostic['severity'], path: string, message: string, category = 'Test playback'): ToolDiagnostic {
  return { severity, path, message, category };
}

function refId(ref: { $ref: { id: string } } | null | undefined): string {
  return ref?.$ref.id ?? '';
}

function typedSubject(subject: TestStepData['selectSubjects']['subjects'][number]): Record<string, string> {
  return subject.kind === 'character'
    ? { kind: 'character', id: subject.character.$ref.id }
    : { kind: 'interactable', id: subject.interactable.$ref.id };
}

function buildTypedInput(step: TestStepData): Record<string, unknown> | null {
  const delta = step.deltaSeconds ?? (step.input === 'tick' ? step.tick.deltaSeconds : null);
  if (step.input === 'tick') return { type: 'advance-time', microseconds: Math.round((delta ?? 0) * 1_000_000) };
  if (step.input === 'continue') return { type: 'continue' };
  if (step.input === 'select-subjects') return { type: 'select-subjects', subjects: step.selectSubjects.subjects.map(typedSubject) };
  if (step.input === 'clear-subject-selection') return { type: 'clear-selection' };
  if (step.input === 'run-interaction') {
    return {
      type: 'invoke-interaction',
      verb: refId(step.runInteraction.verb),
      operands: step.runInteraction.operands.map(typedSubject),
    };
  }
  if (step.input === 'load-save') {
    const slot = step.loadSave.slotId.trim();
    if (slot === 'autosave') return { type: 'load', slot: { kind: 'autosave' } };
    const number = Number(slot.replace(/^slot-?/, ''));
    if (Number.isInteger(number) && number >= 0) return { type: 'load', slot: { kind: 'manual', number } };
  }
  return null;
}

function compiledProjectForAuthoring(project: AuthoringProject): { project?: unknown; diagnostics: ToolDiagnostic[]; ok: boolean } {
  const exported = buildCompiledRuntimeExport(project, {
    projectRoot: null,
    profile: selectedExportProfile(project),
  });
  return { project: exported.compiledProject, diagnostics: exported.diagnostics, ok: exported.ok };
}

export function buildRuntimePlaybackSpecFromTestData(testId: string, data: TestData): RuntimePlaybackSpecBuildResult {
  const diagnostics: ToolDiagnostic[] = [];
  const steps: Array<{ index: number; input: Record<string, unknown> }> = [];
  data.steps.filter((step) => step.enabled).forEach((step, index) => {
    const input = buildTypedInput(step);
    if (!input) {
      diagnostics.push(diagnostic('error', `/tests/${testId}/data/steps/${index}/input`, `Input '${step.input}' does not have a stable typed runtime identity.`));
      return;
    }
    if (step.initScript.trim() || step.checkScript.trim() || step.assertions.some((assertion) => assertion.enabled)) {
      diagnostics.push(diagnostic('error', `/tests/${testId}/data/steps/${index}`, 'Per-step scripts and assertions have not been lowered to the typed playback protocol.'));
      return;
    }
    steps.push({ index, input });
  });
  if (data.initScript.trim() || data.checkScript.trim()) {
    diagnostics.push(diagnostic('error', `/tests/${testId}/data`, 'Test-level scripts have not been lowered to the typed playback protocol.'));
  }
  const spec: Record<string, unknown> = {
    schema: 'noveltea.editor.playback',
    version: 1,
    id: testId,
    steps,
  };
  return { ok: !diagnostics.some((item) => item.severity === 'error'), runner: 'runtime', spec, diagnostics };
}

export function buildRuntimePlaybackSpecFromAuthoringTest(project: AuthoringProject, testId: string): RuntimePlaybackSpecBuildResult {
  const record = project.tests[testId];
  if (!record) {
    return { ok: false, diagnostics: [diagnostic('error', `/tests/${testId}`, 'Test record does not exist.')] };
  }
  const data = parseTestData(record.data);
  if (!data) {
    return { ok: false, diagnostics: [diagnostic('error', `/tests/${testId}/data`, 'Test data is invalid.')] };
  }
  const built = buildRuntimePlaybackSpecFromTestData(testId, data);
  const compiledProject = compiledProjectForAuthoring(project);
  return {
    ...built,
    ok: built.ok && compiledProject.ok,
    project: compiledProject.project,
    diagnostics: [...built.diagnostics, ...compiledProject.diagnostics],
  };
}

export function getAuthoringTestRunReadiness(project: unknown, testId: string): TestRunReadiness {
  if (!isAuthoringProject(project)) {
    return { runnable: true, reason: 'runnable', diagnostics: [] };
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
  if (!data.entrypoint) {
    return {
      runnable: false,
      reason: 'not-runnable-missing-entrypoint',
      diagnostics: [diagnostic('warning', `/tests/${testId}/data/entrypoint`, 'Choose an entrypoint before this test can run.')],
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
  const compiledProject = compiledProjectForAuthoring(project);
  if (!compiledProject.ok) {
    return {
      runnable: false,
      reason: 'not-runnable-authoring-conversion-missing',
      diagnostics: compiledProject.diagnostics,
    };
  }
  return {
    runnable: true,
    reason: 'runnable',
    diagnostics: compiledProject.diagnostics.filter((item) => item.severity !== 'error'),
  };
}
