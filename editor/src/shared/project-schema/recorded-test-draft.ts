import {
  defaultTestData,
  defaultTestStep,
  testObjectRef,
  testVerbRef,
  type TestData,
  type TestStepData,
} from './authoring-tests';

export type RecordedRuntimeInputKind =
  | 'continue'
  | 'dialogue-option'
  | 'navigate'
  | 'select-object'
  | 'clear-object-selection'
  | 'run-action';

export interface RecordedRuntimeActionInput {
  type: RecordedRuntimeInputKind | 'ui-click' | string;
  optionIndex?: number;
  direction?: number;
  objectId?: string;
  verbId?: string;
  objectIds?: string[];
}

export interface RecordedRuntimeActionDraft {
  id?: string;
  kind: RecordedRuntimeInputKind | 'ui-click' | string;
  label?: string;
  input: RecordedRuntimeActionInput;
}

export interface RecordedTestDraftLike {
  actions: RecordedRuntimeActionDraft[];
}

export interface RecordedTestDraftConversionResult {
  ok: boolean;
  data: TestData;
  diagnostics: string[];
  skippedActionCount: number;
}

function actionStepId(action: RecordedRuntimeActionDraft, index: number) {
  const fallback = `recorded-step-${index + 1}`;
  const candidate = action.id?.trim() || fallback;
  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
  return /^[a-z]/.test(normalized) ? normalized : `recorded-${normalized}`;
}

function withStepIdentity(step: TestStepData, action: RecordedRuntimeActionDraft, index: number): TestStepData {
  return {
    ...step,
    id: actionStepId(action, index),
    label: action.label?.trim() || step.label,
  };
}

export function lowerRecordedRuntimeActionToTestStep(action: RecordedRuntimeActionDraft, index = 0): TestStepData | null {
  const input = action.input;
  switch (input.type) {
    case 'continue':
      return withStepIdentity(defaultTestStep('continue', action.label || 'Continue'), action, index);
    case 'dialogue-option':
      return withStepIdentity(
        {
          ...defaultTestStep('dialogue-option', action.label || `Choice ${input.optionIndex ?? 0}`),
          dialogueOption: { optionIndex: Math.max(0, Math.trunc(input.optionIndex ?? 0)) },
        },
        action,
        index,
      );
    case 'navigate':
      return withStepIdentity(
        {
          ...defaultTestStep('navigate', action.label || `Navigate ${input.direction ?? 0}`),
          navigate: { direction: Math.min(7, Math.max(0, Math.trunc(input.direction ?? 0))), target: null },
        },
        action,
        index,
      );
    case 'select-object':
      return withStepIdentity(
        {
          ...defaultTestStep('select-object', action.label || `Select ${input.objectId || 'object'}`),
          selectObject: { object: input.objectId ? testObjectRef(input.objectId) : null },
        },
        action,
        index,
      );
    case 'clear-object-selection':
      return withStepIdentity(defaultTestStep('clear-object-selection', action.label || 'Clear object selection'), action, index);
    case 'run-action':
      return withStepIdentity(
        {
          ...defaultTestStep('run-action', action.label || `Run ${input.verbId || 'action'}`),
          runAction: {
            verb: input.verbId ? testVerbRef(input.verbId) : null,
            objects: (input.objectIds ?? []).filter((id) => id.trim()).map((id) => testObjectRef(id)),
          },
        },
        action,
        index,
      );
    default:
      return null;
  }
}

export function recordedTestDraftToTestData(
  draft: RecordedTestDraftLike,
  options: { label?: string; base?: TestData } = {},
): RecordedTestDraftConversionResult {
  const diagnostics: string[] = [];
  const loweredSteps: TestStepData[] = [];
  draft.actions.forEach((action, index) => {
    const step = lowerRecordedRuntimeActionToTestStep(action, index);
    if (step) {
      loweredSteps.push(step);
    } else {
      diagnostics.push(`Skipped unsupported recorded input '${action.input.type}'.`);
    }
  });

  const label = options.label?.trim() || options.base?.displayName || 'Recorded Test';
  const data = options.base ? { ...options.base, displayName: label } : defaultTestData(label);
  const start = defaultTestStep('tick', 'Start');
  data.steps = [start, ...loweredSteps];
  data.preview = {
    ...data.preview,
    selectedStepId: loweredSteps[0]?.id ?? start.id,
  };

  return {
    ok: loweredSteps.length > 0,
    data,
    diagnostics,
    skippedActionCount: draft.actions.length - loweredSteps.length,
  };
}
