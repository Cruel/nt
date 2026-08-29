import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { featureRefSchema, type FeatureRefData } from './authoring-features';
import { parseInteractableData } from './authoring-interactables';
import { parseRoomData } from './authoring-rooms';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { parseVerbData } from './authoring-verbs';

export const testInputTypeValues = [
  'tick',
  'continue',
  'dialogue-choice',
  'scene-choice',
  'navigate',
  'select-subjects',
  'primary-activate',
  'open-verb-menu',
  'clear-subject-selection',
  'run-interaction',
  'save',
  'load',
] as const;
export type TestInputType = (typeof testInputTypeValues)[number];

export const testRefSchema = <Collection extends string>(collection: Collection) =>
  z
    .object({
      $ref: z.object({ collection: z.literal(collection), id: z.string().min(1) }).strict(),
    })
    .strict();

export const testCharacterRefSchema = testRefSchema('characters');
export const testInteractableRefSchema = z
  .object({
    $ref: z
      .object({ registry: z.literal('interactableInstances'), id: z.string().min(1) })
      .strict(),
  })
  .strict();
export const testVerbRefSchema = testRefSchema('verbs');
const testRecordRefSchema = z.union([testCharacterRefSchema, testVerbRefSchema]);

export const testInteractionSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('character'), character: testCharacterRefSchema }).strict(),
  z.object({ kind: z.literal('interactable'), interactable: testInteractableRefSchema }).strict(),
  z.object({ kind: z.literal('feature'), feature: featureRefSchema }).strict(),
]);

export const testStepDataSchema = z
  .object({
    id: entityIdSchema,
    input: z.enum(testInputTypeValues).default('tick'),
    label: z.string().min(1, 'Step label is required.'),
    enabled: z.boolean().default(true),
    tick: z
      .object({ deltaSeconds: z.number().finite().nonnegative().default(0) })
      .strict()
      .default({ deltaSeconds: 0 }),
    dialogueChoice: z
      .object({ edgeId: entityIdSchema.default('choice') })
      .strict()
      .default({ edgeId: 'choice' }),
    sceneChoice: z
      .object({ optionId: entityIdSchema.default('choice') })
      .strict()
      .default({ optionId: 'choice' }),
    navigate: z
      .object({ exitId: entityIdSchema.default('exit') })
      .strict()
      .default({ exitId: 'exit' }),
    selectSubjects: z
      .object({ subjects: z.array(testInteractionSubjectSchema).default([]) })
      .strict()
      .default({ subjects: [] }),
    subjectAction: z
      .object({ subject: testInteractionSubjectSchema.nullable().default(null) })
      .strict()
      .default({ subject: null }),
    runInteraction: z
      .object({
        verb: testVerbRefSchema.nullable().default(null),
        bindings: z
          .array(
            z.object({ slotId: entityIdSchema, subject: testInteractionSubjectSchema }).strict(),
          )
          .default([]),
      })
      .strict()
      .default({ verb: null, bindings: [] }),
    saveSlot: z
      .object({ slotId: z.string().default('autosave') })
      .strict()
      .default({ slotId: 'autosave' }),
  })
  .strict();

export const testDataSchema = z
  .object({
    kind: z.literal('test').default('test'),
    displayName: z.string().default(''),
    steps: z.array(testStepDataSchema).default([]),
    preview: z
      .object({
        selectedStepId: entityIdSchema.nullable().default(null),
        selectedObservationIndex: z.number().int().nonnegative().nullable().default(null),
        autoOpenReport: z.boolean().default(true),
      })
      .strict()
      .default({ selectedStepId: 'start', selectedObservationIndex: null, autoOpenReport: true }),
  })
  .strict();

export type TestCharacterRef = z.infer<typeof testCharacterRefSchema>;
export type TestInteractableRef = z.infer<typeof testInteractableRefSchema>;
export type TestVerbRef = z.infer<typeof testVerbRefSchema>;
type TestRecordRef = z.infer<typeof testRecordRefSchema>;
export type TestInteractionSubject = z.infer<typeof testInteractionSubjectSchema>;
export type TestStepData = z.infer<typeof testStepDataSchema>;
export type TestData = z.infer<typeof testDataSchema>;

export interface TestSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): TestSchemaDiagnostic {
  return { severity, path, message, category: 'Tests' };
}

function titleCase(value: string) {
  return value
    .split('-')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

export function parseTestData(value: unknown): TestData | null {
  const parsed = testDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function testCharacterRef(id: string): TestCharacterRef {
  return { $ref: { collection: 'characters', id } };
}
export function testInteractableRef(id: string): TestInteractableRef {
  return { $ref: { registry: 'interactableInstances', id } };
}
export function testVerbRef(id: string): TestVerbRef {
  return { $ref: { collection: 'verbs', id } };
}
export function testCharacterSubject(id: string): TestInteractionSubject {
  return { kind: 'character', character: testCharacterRef(id) };
}
export function testInteractableSubject(id: string): TestInteractionSubject {
  return { kind: 'interactable', interactable: testInteractableRef(id) };
}
export function testFeatureSubject(feature: FeatureRefData): TestInteractionSubject {
  return { kind: 'feature', feature };
}

export function defaultTestStep(input: TestInputType = 'tick', label?: string): TestStepData {
  return testStepDataSchema.parse({
    id: input === 'tick' ? 'start' : input,
    input,
    label: label ?? titleCase(input),
  });
}

export function defaultTestData(label = 'Test'): TestData {
  return testDataSchema.parse({
    kind: 'test',
    displayName: label,
    steps: [defaultTestStep('tick', 'Start')],
    preview: { selectedStepId: 'start', selectedObservationIndex: null, autoOpenReport: true },
  });
}

export function isTestRecord(
  record: AuthoringRecordBase | undefined | null,
): record is AuthoringRecordBase & { data: TestData } {
  return !!record && parseTestData(record.data) !== null;
}

function validateUniqueIds(
  items: Array<{ id: string }>,
  path: string,
  label: string,
  diagnostics: TestSchemaDiagnostic[],
) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id))
      diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  });
}

function validateRef(
  project: AuthoringProject,
  ref: TestRecordRef | null,
  path: string,
  diagnostics: TestSchemaDiagnostic[],
) {
  if (!ref) return;
  const { collection, id } = ref.$ref;
  if (!project[collection][id])
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing ${collection} record '${id}'.`));
}

function validateInteractionSubject(
  project: AuthoringProject,
  subject: TestInteractionSubject,
  path: string,
  diagnostics: TestSchemaDiagnostic[],
) {
  if (subject.kind === 'character') {
    validateRef(project, subject.character, `${path}/character`, diagnostics);
    return;
  }
  if (subject.kind === 'interactable') {
    const id = subject.interactable.$ref.id;
    if (!project.interactableInstances[id])
      diagnostics.push(
        diagnostic(`${path}/interactable/$ref`, `Missing Interactable Instance '${id}'.`),
      );
    return;
  }
  if (subject.feature.ownerKind === 'room') {
    const roomId = subject.feature.room.$ref.id;
    const room = parseRoomData(project.rooms[roomId]?.data);
    if (!room)
      diagnostics.push(diagnostic(`${path}/feature/room/$ref`, `Missing Room '${roomId}'.`));
    else if (!room.features.some((feature) => feature.id === subject.feature.featureId))
      diagnostics.push(
        diagnostic(
          `${path}/feature/featureId`,
          `Missing Feature '${subject.feature.featureId}' on Room '${roomId}'.`,
        ),
      );
    return;
  }
  const interactableId = subject.feature.interactable.$ref.id;
  const instance = project.interactableInstances[interactableId];
  const interactable = instance
    ? parseInteractableData(project.interactables[instance.definition.$ref.id]?.data)
    : null;
  if (!interactable)
    diagnostics.push(
      diagnostic(
        `${path}/feature/interactable/$ref`,
        `Missing Interactable Instance '${interactableId}'.`,
      ),
    );
  else if (!interactable.features.some((feature) => feature.id === subject.feature.featureId))
    diagnostics.push(
      diagnostic(
        `${path}/feature/featureId`,
        `Missing Feature '${subject.feature.featureId}' on Interactable Instance '${interactableId}'.`,
      ),
    );
}

function validateStep(
  project: AuthoringProject,
  step: TestStepData,
  path: string,
  diagnostics: TestSchemaDiagnostic[],
) {
  if (!step.label.trim()) diagnostics.push(diagnostic(`${path}/label`, 'Step label is required.'));
  if (!step.enabled) return;
  if (step.input === 'select-subjects')
    step.selectSubjects.subjects.forEach((subject, index) =>
      validateInteractionSubject(
        project,
        subject,
        `${path}/selectSubjects/subjects/${index}`,
        diagnostics,
      ),
    );
  if (step.input === 'primary-activate' || step.input === 'open-verb-menu') {
    if (!step.subjectAction.subject)
      diagnostics.push(diagnostic(`${path}/subjectAction/subject`, 'A subject is required.'));
    else
      validateInteractionSubject(
        project,
        step.subjectAction.subject,
        `${path}/subjectAction/subject`,
        diagnostics,
      );
  }
  if (step.input === 'run-interaction') {
    validateRef(project, step.runInteraction.verb, `${path}/runInteraction/verb`, diagnostics);
    const verbRecord = step.runInteraction.verb
      ? project.verbs[step.runInteraction.verb.$ref.id]
      : undefined;
    const verb = verbRecord ? parseVerbData(verbRecord.data) : null;
    const expectedSlots = new Set(verb?.bindingOrder ?? []);
    const actualSlots = step.runInteraction.bindings.map((binding) => binding.slotId);
    if (
      verb &&
      (actualSlots.length !== expectedSlots.size ||
        new Set(actualSlots).size !== actualSlots.length ||
        actualSlots.some((slotId) => !expectedSlots.has(slotId)))
    )
      diagnostics.push(
        diagnostic(
          `${path}/runInteraction/bindings`,
          'Run Interaction must bind every named Verb slot exactly once.',
        ),
      );
    step.runInteraction.bindings.forEach((binding, index) =>
      validateInteractionSubject(
        project,
        binding.subject,
        `${path}/runInteraction/bindings/${index}/subject`,
        diagnostics,
      ),
    );
  }
  if ((step.input === 'save' || step.input === 'load') && !step.saveSlot.slotId.trim())
    diagnostics.push(diagnostic(`${path}/saveSlot/slotId`, 'Save slot is required.'));
}

export function validateTestData(
  project: AuthoringProject,
  testId: string,
  record: AuthoringRecordBase,
): TestSchemaDiagnostic[] {
  const diagnostics: TestSchemaDiagnostic[] = [];
  const parsed = testDataSchema.safeParse(record.data);
  const base = `/tests/${testId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    return diagnostics;
  }
  const data = parsed.data;
  if (!data.displayName.trim())
    diagnostics.push(diagnostic(`${base}/displayName`, 'Display name is required.', 'warning'));
  if (data.steps.length === 0)
    diagnostics.push(diagnostic(`${base}/steps`, 'Test requires at least one step.'));
  validateUniqueIds(data.steps, `${base}/steps`, 'step', diagnostics);
  const stepIds = new Set(data.steps.map((step) => step.id));
  if (data.preview.selectedStepId && !stepIds.has(data.preview.selectedStepId))
    diagnostics.push(
      diagnostic(
        `${base}/preview/selectedStepId`,
        `Missing preview step '${data.preview.selectedStepId}'.`,
        'warning',
      ),
    );
  data.steps.forEach((step, index) =>
    validateStep(project, step, `${base}/steps/${index}`, diagnostics),
  );
  return diagnostics;
}
