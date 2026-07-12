import type { ToolDiagnostic } from '../editor-tooling';
import { isAuthoringProject, type AuthoringProject } from './authoring-project';
import { selectedExportProfile } from './authoring-export';
import { buildAuthoringRuntimeExport } from './authoring-runtime-export';
import {
  parseTestData,
  type TestAssertionData,
  type TestData,
  type TestEntrypointRef,
  type TestInputType,
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

function diagnostic(severity: ToolDiagnostic['severity'], path: string, message: string, category = 'authoring-test-playback'): ToolDiagnostic {
  return { severity, path, message, category };
}

const inputToNative: Record<TestInputType, string> = {
  tick: 'tick',
  continue: 'continue',
  'dialogue-option': 'dialogue_option',
  navigate: 'navigate',
  'select-object': 'select_object',
  'clear-object-selection': 'clear_object_selection',
  'run-action': 'run_action',
  'load-save': 'load_save',
  'set-entrypoint': 'set_entrypoint',
  'ui-click': 'ui_click',
};

const assertionToNative: Record<TestAssertionData['type'], string> = {
  mode: 'mode',
  'current-room': 'current_room',
  title: 'title',
  'text-log-contains': 'text_log_contains',
  'property-equals': 'property_equals',
  'object-location': 'object_location',
  'inventory-contains': 'inventory_contains',
  'output-type': 'output_type',
  'diagnostic-category': 'diagnostic_category',
};

function refId(ref: { $ref: { id: string } } | null | undefined): string {
  return ref?.$ref.id ?? '';
}

function buildNativeEntrypoint(_entrypoint: TestEntrypointRef | null): null {
  return null;
}

function buildNativeAssertion(assertion: TestAssertionData) {
  const result: Record<string, unknown> = {
    type: assertionToNative[assertion.type],
    value: assertion.value,
    key: assertion.variable?.$ref.id ?? assertion.key,
  };
  if (assertion.expected !== undefined) result.expected = assertion.expected;
  if (assertion.entity) result.entity_ref = { id: assertion.entity.$ref.id };
  return result;
}

function buildNativeStep(step: TestStepData) {
  const result: Record<string, unknown> = {
    input: inputToNative[step.input],
    assertions: step.assertions.filter((assertion) => assertion.enabled).map(buildNativeAssertion),
  };
  const delta = step.deltaSeconds ?? (step.input === 'tick' ? step.tick.deltaSeconds : null);
  if (delta !== null) result.delta_seconds = delta;
  if (step.initScript.trim()) result.init = step.initScript;
  if (step.checkScript.trim()) result.check = step.checkScript;

  if (step.input === 'dialogue-option') result.option_index = step.dialogueOption.optionIndex;
  if (step.input === 'navigate') result.direction = step.navigate.direction;
  if (step.input === 'select-object') result.object_id = refId(step.selectObject.object);
  if (step.input === 'run-action') {
    result.verb_id = refId(step.runAction.verb);
    result.object_ids = step.runAction.interactables.map((object) => object.$ref.id);
  }
  if (step.input === 'load-save') {
    result.payload = step.loadSave.payload ?? {};
    if (step.loadSave.slotId.trim()) result.payload = { slot_id: step.loadSave.slotId, payload: step.loadSave.payload };
  }
  if (step.input === 'set-entrypoint') result.entity_ref = buildNativeEntrypoint(step.setEntrypoint.entrypoint);
  if (step.input === 'ui-click') {
    result.document_id = step.uiClick.documentId;
    result.target = step.uiClick.target || step.uiClick.selector;
    result.selector = step.uiClick.selector || step.uiClick.target;
  }
  return result;
}

function hasEnabledUiClick(data: TestData) {
  return data.steps.some((step) => step.enabled && step.input === 'ui-click');
}

function runtimeProjectForAuthoring(project: AuthoringProject): { project?: unknown; diagnostics: ToolDiagnostic[]; ok: boolean } {
  const exported = buildAuthoringRuntimeExport(project, {
    projectRoot: null,
    profile: selectedExportProfile(project),
  });
  return { project: exported.runtimeProject, diagnostics: exported.diagnostics, ok: exported.ok };
}

export function buildRuntimePlaybackSpecFromTestData(testId: string, data: TestData): RuntimePlaybackSpecBuildResult {
  const diagnostics: ToolDiagnostic[] = [];
  const spec: Record<string, unknown> = {
    id: testId,
    steps: data.steps.filter((step) => step.enabled).map(buildNativeStep),
  };
  if (data.fixedDeltaSeconds !== null) spec.fixed_delta_seconds = data.fixedDeltaSeconds;
  if (data.initScript.trim()) spec.init = data.initScript;
  if (data.checkScript.trim()) spec.check = data.checkScript;
  const entrypoint = buildNativeEntrypoint(data.entrypoint);
  if (entrypoint) spec.entrypoint = entrypoint;
  if (data.entrypoint) {
    diagnostics.push(diagnostic('warning', `/tests/${testId}/data/entrypoint`, 'Authoring entrypoints are not yet convertible to runtime EntityRef values.'));
  }
  return { ok: true, runner: hasEnabledUiClick(data) ? 'runtime-ui' : 'runtime', spec, diagnostics };
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
  if (built.runner !== 'runtime-ui') return built;

  const runtimeProject = runtimeProjectForAuthoring(project);
  return {
    ...built,
    ok: built.ok && runtimeProject.ok,
    project: runtimeProject.project,
    diagnostics: [...built.diagnostics, ...runtimeProject.diagnostics],
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
  const hasUiClick = hasEnabledUiClick(data);
  if (hasUiClick) {
    const runtimeProject = runtimeProjectForAuthoring(project);
    if (!runtimeProject.ok) {
      return {
        runnable: false,
        reason: 'not-runnable-authoring-conversion-missing',
        diagnostics: runtimeProject.diagnostics,
      };
    }
    return {
      runnable: true,
      reason: 'runnable',
      diagnostics: runtimeProject.diagnostics.filter((item) => item.severity !== 'error'),
    };
  }
  if (!data.entrypoint) {
    return {
      runnable: false,
      reason: 'not-runnable-missing-entrypoint',
      diagnostics: [diagnostic('warning', `/tests/${testId}/data/entrypoint`, 'Choose an entrypoint before this test can run.')],
    };
  }
  return {
    runnable: false,
    reason: 'not-runnable-authoring-conversion-missing',
    diagnostics: [diagnostic('warning', `/tests/${testId}`, 'Authoring-to-runtime project conversion is not implemented yet, so this authoring test can be edited but not run.')],
  };
}
