import type { ToolDiagnostic } from '../editor-tooling';
import {
  isCanonicalTestSaveSlotId,
  type TestData,
  type TestExpectationData,
  type TestStepData,
} from './authoring-tests';

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
  shaderMaterialMetadata?: unknown;
  shaderVariants?: string[];
  diagnostics: ToolDiagnostic[];
}

export function diagnostic(
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

function buildTypedExpectation(expectation: TestExpectationData): Record<string, unknown> {
  const base = { id: expectation.id, type: expectation.type, operator: expectation.operator };
  if (expectation.type === 'property') return { ...base, ...expectation.property };
  if (expectation.type === 'current-room') return { ...base, ...expectation.currentRoom };
  if (expectation.type === 'location') return { ...base, ...expectation.location };
  if (expectation.type === 'quantity') return { ...base, ...expectation.quantity };
  if (expectation.type === 'trait') return { ...base, ...expectation.trait };
  if (expectation.type === 'entity-state') return { ...base, ...expectation.entityState };
  if (expectation.type === 'active-flow') return { ...base, ...expectation.activeFlow };
  if (expectation.type === 'layout') return { ...base, ...expectation.layout };
  if (expectation.type === 'ui-element')
    return {
      ...base,
      documentId: expectation.uiElement.mountInstanceId
        ? `mount:${expectation.uiElement.mountInstanceId}`
        : (expectation.uiElement.documentId ?? ''),
      selector: expectation.uiElement.selector,
      field: expectation.uiElement.field,
      value: expectation.uiElement.value,
    };
  if (expectation.type === 'event') return { ...base, ...expectation.event };
  return { ...base, ...expectation.diagnostic };
}

function buildTypedInput(step: TestStepData): Record<string, unknown> | null {
  if (step.input === 'tick')
    return { type: 'advance-time', microseconds: Math.round(step.tick.deltaSeconds * 1_000_000) };
  if (step.input === 'continue') return { type: 'continue' };
  if (step.input === 'fast-forward') return { type: 'fast-forward' };
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
    const slot = step.saveSlot.slotId;
    if (slot === 'autosave') return { type: step.input, slot: 'autosave' };
    const manual = slot.match(/^slot-(0|[1-9][0-9]*)$/u);
    if (manual) return { type: step.input, slot: `manual-${manual[1]}` };
  }
  if (step.input === 'ui-click')
    return {
      type: 'ui-click',
      documentId: step.uiClick.mountInstanceId
        ? `mount:${step.uiClick.mountInstanceId}`
        : (step.uiClick.documentId ?? ''),
      selector: step.uiClick.selector,
    };
  return null;
}

function usesRuntimeUi(data: TestData) {
  const hasUiExpectation = (expectations: TestData['finalExpectations']) =>
    expectations.some((expectation) => expectation.type === 'ui-element');
  return (
    data.steps.some(
      (step) => step.enabled && (step.input === 'ui-click' || hasUiExpectation(step.expectations)),
    ) || hasUiExpectation(data.finalExpectations)
  );
}

export function buildRuntimePlaybackSpecFromTestData(
  testId: string,
  data: TestData,
): RuntimePlaybackSpecBuildResult {
  const diagnostics: ToolDiagnostic[] = [];
  const steps: Array<{
    index: number;
    input: Record<string, unknown>;
    expectations: Record<string, unknown>[];
  }> = [];
  data.steps
    .filter((step) => step.enabled)
    .forEach((step, index) => {
      if (
        (step.input === 'save' || step.input === 'load') &&
        !isCanonicalTestSaveSlotId(step.saveSlot.slotId)
      ) {
        diagnostics.push(
          diagnostic(
            'error',
            `/tests/${testId}/data/steps/${index}/saveSlot/slotId`,
            "Save slot must be 'autosave' or 'slot-N' for a non-negative integer N.",
          ),
        );
        return;
      }
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
      steps.push({
        index,
        input,
        expectations: step.expectations.map(buildTypedExpectation),
      });
    });
  const spec: Record<string, unknown> = {
    schema: 'noveltea.editor.playback',
    version: 1,
    id: testId,
    steps,
    finalExpectations: data.finalExpectations.map(buildTypedExpectation),
  };
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    runner: usesRuntimeUi(data) ? 'runtime-ui' : 'runtime',
    spec,
    diagnostics,
  };
}
