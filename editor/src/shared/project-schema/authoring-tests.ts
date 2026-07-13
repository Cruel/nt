import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

export const testInputTypeValues = [
  'tick',
  'continue',
  'dialogue-option',
  'navigate',
  'select-interactable',
  'clear-interactable-selection',
  'run-interaction',
  'load-save',
  'set-entrypoint',
  'ui-click',
] as const;
export type TestInputType = (typeof testInputTypeValues)[number];

export const testAssertionTypeValues = [
  'mode',
  'current-room',
  'title',
  'text-log-contains',
  'property-equals',
  'interactable-location',
  'inventory-contains',
  'output-type',
  'diagnostic-category',
] as const;
export type TestAssertionType = (typeof testAssertionTypeValues)[number];

export const testEntrypointCollectionValues = ['scenes', 'rooms', 'dialogues'] as const;

export const testRefSchema = <Collection extends string>(collection: Collection) =>
  z.object({ $ref: z.object({ collection: z.literal(collection), id: z.string().min(1) }).strict() }).strict();

export const testSceneRefSchema = testRefSchema('scenes');
export const testRoomRefSchema = testRefSchema('rooms');
export const testDialogueRefSchema = testRefSchema('dialogues');
export const testInteractableRefSchema = testRefSchema('interactables');
export const testVerbRefSchema = testRefSchema('verbs');
export const testVariableRefSchema = testRefSchema('variables');
export const testMapRefSchema = testRefSchema('maps');
export const testEntrypointRefSchema = z.union([testSceneRefSchema, testRoomRefSchema, testDialogueRefSchema]);
export const testAnyRefSchema = z.union([
  testSceneRefSchema,
  testRoomRefSchema,
  testDialogueRefSchema,
  testInteractableRefSchema,
  testVerbRefSchema,
  testVariableRefSchema,
  testMapRefSchema,
]);

export const testAssertionDataSchema = z.object({
  id: entityIdSchema,
  type: z.enum(testAssertionTypeValues).default('mode'),
  label: z.string().default('Assertion'),
  value: z.string().default(''),
  key: z.string().default(''),
  expected: z.json().default(null),
  entity: testAnyRefSchema.nullable().default(null),
  variable: testVariableRefSchema.nullable().default(null),
  enabled: z.boolean().default(true),
}).strict();

export const testStepDataSchema = z.object({
  id: entityIdSchema,
  input: z.enum(testInputTypeValues).default('tick'),
  label: z.string().min(1, 'Step label is required.'),
  enabled: z.boolean().default(true),
  deltaSeconds: z.number().finite().nonnegative().nullable().default(null),
  initScript: z.string().default(''),
  checkScript: z.string().default(''),
  tick: z.object({ deltaSeconds: z.number().finite().nonnegative().default(0) }).strict().default({ deltaSeconds: 0 }),
  dialogueOption: z.object({ optionIndex: z.number().int().nonnegative().default(0) }).strict().default({ optionIndex: 0 }),
  navigate: z.object({ direction: z.number().int().min(0).max(7).default(1), target: testRoomRefSchema.nullable().default(null) }).strict().default({ direction: 1, target: null }),
  selectInteractable: z.object({ interactable: testInteractableRefSchema.nullable().default(null) }).strict().default({ interactable: null }),
  runInteraction: z.object({ verb: testVerbRefSchema.nullable().default(null), interactables: z.array(testInteractableRefSchema).default([]) }).strict().default({ verb: null, interactables: [] }),
  loadSave: z.object({ slotId: z.string().default(''), payload: z.json().default(null) }).strict().default({ slotId: '', payload: null }),
  setEntrypoint: z.object({ entrypoint: testEntrypointRefSchema.nullable().default(null) }).strict().default({ entrypoint: null }),
  uiClick: z.object({
    documentId: z.string().default('runtime_title'),
    target: z.string().default('#nt-title-start'),
    selector: z.string().default('#nt-title-start'),
  }).strict().default({ documentId: 'runtime_title', target: '#nt-title-start', selector: '#nt-title-start' }),
  assertions: z.array(testAssertionDataSchema).default([]),
}).strict();

export const testDataSchema = z.object({
  kind: z.literal('test').default('test'),
  displayName: z.string().default(''),
  entrypoint: testEntrypointRefSchema.nullable().default(null),
  fixedDeltaSeconds: z.number().finite().nonnegative().nullable().default(null),
  initScript: z.string().default(''),
  checkScript: z.string().default(''),
  startingInventory: z.array(testInteractableRefSchema).default([]),
  steps: z.array(testStepDataSchema).default([]),
  preview: z.object({
    selectedStepId: entityIdSchema.nullable().default(null),
    selectedObservationIndex: z.number().int().nonnegative().nullable().default(null),
    autoOpenReport: z.boolean().default(true),
  }).strict().default({ selectedStepId: 'start', selectedObservationIndex: null, autoOpenReport: true }),
}).strict();

export type TestSceneRef = z.infer<typeof testSceneRefSchema>;
export type TestRoomRef = z.infer<typeof testRoomRefSchema>;
export type TestDialogueRef = z.infer<typeof testDialogueRefSchema>;
export type TestInteractableRef = z.infer<typeof testInteractableRefSchema>;
export type TestVerbRef = z.infer<typeof testVerbRefSchema>;
export type TestVariableRef = z.infer<typeof testVariableRefSchema>;
export type TestEntrypointRef = z.infer<typeof testEntrypointRefSchema>;
export type TestAnyRef = z.infer<typeof testAnyRefSchema>;
export type TestAssertionData = z.infer<typeof testAssertionDataSchema>;
export type TestStepData = z.infer<typeof testStepDataSchema>;
export type TestData = z.infer<typeof testDataSchema>;

export interface TestSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): TestSchemaDiagnostic {
  return { severity, path, message, category: 'authoring-tests' };
}

function titleCase(value: string) {
  return value.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

export function parseTestData(value: unknown): TestData | null {
  const parsed = testDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function testSceneRef(id: string): TestSceneRef { return { $ref: { collection: 'scenes', id } }; }
export function testRoomRef(id: string): TestRoomRef { return { $ref: { collection: 'rooms', id } }; }
export function testDialogueRef(id: string): TestDialogueRef { return { $ref: { collection: 'dialogues', id } }; }
export function testInteractableRef(id: string): TestInteractableRef { return { $ref: { collection: 'interactables', id } }; }
export function testVerbRef(id: string): TestVerbRef { return { $ref: { collection: 'verbs', id } }; }
export function testVariableRef(id: string): TestVariableRef { return { $ref: { collection: 'variables', id } }; }

export function defaultTestAssertion(type: TestAssertionType = 'mode'): TestAssertionData {
  return testAssertionDataSchema.parse({ id: type, type, label: titleCase(type), enabled: true });
}

export function defaultTestStep(input: TestInputType = 'tick', label?: string): TestStepData {
  return testStepDataSchema.parse({ id: input === 'tick' ? 'start' : input, input, label: label ?? titleCase(input) });
}

export function defaultTestData(label = 'Test'): TestData {
  return testDataSchema.parse({
    kind: 'test',
    displayName: label,
    entrypoint: null,
    fixedDeltaSeconds: null,
    initScript: '',
    checkScript: '',
    startingInventory: [],
    steps: [defaultTestStep('tick', 'Start')],
    preview: { selectedStepId: 'start', selectedObservationIndex: null, autoOpenReport: true },
  });
}

export function isTestRecord(record: AuthoringRecordBase | undefined | null): record is AuthoringRecordBase & { data: TestData } {
  return !!record && parseTestData(record.data) !== null;
}

function validateUniqueIds(items: Array<{ id: string }>, path: string, label: string, diagnostics: TestSchemaDiagnostic[]) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  });
}

function validateRef(project: AuthoringProject, ref: TestAnyRef | TestEntrypointRef | null, path: string, diagnostics: TestSchemaDiagnostic[]) {
  if (!ref) return;
  const { collection, id } = ref.$ref;
  if (!project[collection][id]) diagnostics.push(diagnostic(`${path}/$ref`, `Missing ${collection} record '${id}'.`));
}

function validateAssertion(assertion: TestAssertionData, path: string, diagnostics: TestSchemaDiagnostic[]) {
  if (!assertion.enabled) return;
  if (!assertion.label.trim()) diagnostics.push(diagnostic(`${path}/label`, 'Assertion label is required.'));
  if (['mode', 'current-room', 'title', 'text-log-contains', 'inventory-contains', 'output-type', 'diagnostic-category'].includes(assertion.type) && !assertion.value.trim()) {
    diagnostics.push(diagnostic(`${path}/value`, `${assertion.type} assertion requires a value.`));
  }
  if (assertion.type === 'property-equals' && !assertion.key.trim() && !assertion.variable) {
    diagnostics.push(diagnostic(`${path}/key`, 'property-equals assertion requires a key or variable reference.'));
  }
  if (assertion.type === 'interactable-location' && !assertion.key.trim()) {
    diagnostics.push(diagnostic(`${path}/key`, 'interactable-location assertion requires an interactable key.'));
  }
}

function validateStep(project: AuthoringProject, step: TestStepData, path: string, diagnostics: TestSchemaDiagnostic[]) {
  if (!step.label.trim()) diagnostics.push(diagnostic(`${path}/label`, 'Step label is required.'));
  if (step.deltaSeconds !== null && step.deltaSeconds < 0) diagnostics.push(diagnostic(`${path}/deltaSeconds`, 'Step delta cannot be negative.'));
  if (!step.enabled) return;
  if (step.input === 'navigate' && (step.navigate.direction < 0 || step.navigate.direction > 7)) diagnostics.push(diagnostic(`${path}/navigate/direction`, 'Navigation direction must be 0 through 7.'));
  if (step.input === 'dialogue-option' && step.dialogueOption.optionIndex < 0) diagnostics.push(diagnostic(`${path}/dialogueOption/optionIndex`, 'Dialogue option index cannot be negative.'));
  if (step.input === 'select-interactable') validateRef(project, step.selectInteractable.interactable, `${path}/selectInteractable/interactable`, diagnostics);
  if (step.input === 'run-interaction') {
    validateRef(project, step.runInteraction.verb, `${path}/runInteraction/verb`, diagnostics);
    step.runInteraction.interactables.forEach((interactable, index) => validateRef(project, interactable, `${path}/runInteraction/interactables/${index}`, diagnostics));
  }
  if (step.input === 'set-entrypoint') validateRef(project, step.setEntrypoint.entrypoint, `${path}/setEntrypoint/entrypoint`, diagnostics);
  if (step.input === 'ui-click') {
    if (!step.uiClick.documentId.trim()) diagnostics.push(diagnostic(`${path}/uiClick/documentId`, 'ui-click requires a document id.'));
    if (!step.uiClick.target.trim()) diagnostics.push(diagnostic(`${path}/uiClick/target`, 'ui-click requires a target selector.'));
    if (!step.uiClick.selector.trim()) diagnostics.push(diagnostic(`${path}/uiClick/selector`, 'ui-click requires a selector.'));
  }
  if (step.input === 'navigate') validateRef(project, step.navigate.target, `${path}/navigate/target`, diagnostics);
  validateUniqueIds(step.assertions, `${path}/assertions`, 'assertion', diagnostics);
  step.assertions.forEach((assertion, index) => {
    validateRef(project, assertion.entity, `${path}/assertions/${index}/entity`, diagnostics);
    validateRef(project, assertion.variable, `${path}/assertions/${index}/variable`, diagnostics);
    validateAssertion(assertion, `${path}/assertions/${index}`, diagnostics);
  });
}

export function validateTestData(project: AuthoringProject, testId: string, record: AuthoringRecordBase): TestSchemaDiagnostic[] {
  const diagnostics: TestSchemaDiagnostic[] = [];
  const parsed = testDataSchema.safeParse(record.data);
  const base = `/tests/${testId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    return diagnostics;
  }
  const data = parsed.data;
  if (!data.displayName.trim()) diagnostics.push(diagnostic(`${base}/displayName`, 'Display name is required.', 'warning'));
  validateRef(project, data.entrypoint, `${base}/entrypoint`, diagnostics);
  data.startingInventory.forEach((object, index) => validateRef(project, object, `${base}/startingInventory/${index}`, diagnostics));
  if (data.steps.length === 0) diagnostics.push(diagnostic(`${base}/steps`, 'Test requires at least one step.'));
  validateUniqueIds(data.steps, `${base}/steps`, 'step', diagnostics);
  const stepIds = new Set(data.steps.map((step) => step.id));
  if (data.preview.selectedStepId && !stepIds.has(data.preview.selectedStepId)) diagnostics.push(diagnostic(`${base}/preview/selectedStepId`, `Missing preview step '${data.preview.selectedStepId}'.`, 'warning'));
  data.steps.forEach((step, index) => validateStep(project, step, `${base}/steps/${index}`, diagnostics));
  return diagnostics;
}
