import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { authoredRuntimeValueSchema } from './authoring-properties';
import { featureRefSchema, type FeatureRefData } from './authoring-features';
import { parseInteractableData } from './authoring-interactables';
import { layoutPersistableValueSchema } from './authoring-layouts';
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
  'ui-click',
] as const;
export type TestInputType = (typeof testInputTypeValues)[number];

export const testExpectationTypeValues = [
  'property',
  'current-room',
  'location',
  'quantity',
  'trait',
  'entity-state',
  'active-flow',
  'layout',
  'event',
  'diagnostic',
] as const;
export const testExpectationOperatorValues = [
  'eq',
  'ne',
  'present',
  'absent',
  'gt',
  'gte',
  'lt',
  'lte',
] as const;
export type TestExpectationType = (typeof testExpectationTypeValues)[number];
export type TestExpectationOperator = (typeof testExpectationOperatorValues)[number];

export const testExpectationDataSchema = z
  .object({
    id: entityIdSchema,
    type: z.enum(testExpectationTypeValues),
    operator: z.enum(testExpectationOperatorValues),
    property: z
      .object({
        scope: z.enum(['global', 'room', 'character', 'interactable']).default('global'),
        ownerId: z.string().default(''),
        propertyId: entityIdSchema.default('property'),
        value: authoredRuntimeValueSchema.default(null),
      })
      .strict()
      .default({ scope: 'global', ownerId: '', propertyId: 'property', value: null }),
    currentRoom: z
      .object({ roomId: z.string().default('') })
      .strict()
      .default({ roomId: '' }),
    location: z
      .object({
        entityKind: z.enum(['character', 'interactable']).default('interactable'),
        entityId: z.string().default(''),
        locationKind: z.enum(['unplaced', 'room', 'inventory']).default('unplaced'),
        roomId: z.string().default(''),
        inventoryOwnerKind: z.enum(['project', 'character', 'interactable']).default('project'),
        inventoryOwnerId: z.string().default(''),
        inventoryId: z.string().default(''),
      })
      .strict()
      .default({
        entityKind: 'interactable',
        entityId: '',
        locationKind: 'unplaced',
        roomId: '',
        inventoryOwnerKind: 'project',
        inventoryOwnerId: '',
        inventoryId: '',
      }),
    quantity: z
      .object({ interactableId: z.string().default(''), value: z.number().finite().default(0) })
      .strict()
      .default({ interactableId: '', value: 0 }),
    trait: z
      .object({
        ownerKind: z.enum(['room', 'character', 'interactable']).default('interactable'),
        ownerId: z.string().default(''),
        traitId: entityIdSchema.default('trait'),
      })
      .strict()
      .default({ ownerKind: 'interactable', ownerId: '', traitId: 'trait' }),
    entityState: z
      .object({
        entityKind: z.enum(['character', 'interactable']).default('interactable'),
        entityId: z.string().default(''),
        field: z.enum(['enabled', 'visible']).default('enabled'),
        value: z.boolean().default(true),
      })
      .strict()
      .default({ entityKind: 'interactable', entityId: '', field: 'enabled', value: true }),
    activeFlow: z
      .object({
        kind: z.enum(['scene', 'dialogue']).default('scene'),
        flowId: z.string().default(''),
      })
      .strict()
      .default({ kind: 'scene', flowId: '' }),
    layout: z
      .object({
        layoutId: z.string().default(''),
        field: z.enum(['mounted', 'state']).default('mounted'),
        value: layoutPersistableValueSchema.default(null),
      })
      .strict()
      .default({ layoutId: '', field: 'mounted', value: null }),
    event: z
      .object({
        kind: z.enum(['notification', 'save-outcome']).default('notification'),
        value: z.string().default(''),
      })
      .strict()
      .default({ kind: 'notification', value: '' }),
    diagnostic: z
      .object({ code: z.string().default('') })
      .strict()
      .default({ code: '' }),
  })
  .strict();

export type TestExpectationData = z.infer<typeof testExpectationDataSchema>;

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
    expectations: z.array(testExpectationDataSchema).default([]),
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
    uiClick: z
      .object({
        documentId: z.string().default('runtime_game'),
        selector: z.string().default('#target'),
      })
      .strict()
      .default({ documentId: 'runtime_game', selector: '#target' }),
  })
  .strict();

export const testDataSchema = z
  .object({
    kind: z.literal('test').default('test'),
    displayName: z.string().default(''),
    steps: z.array(testStepDataSchema).default([]),
    finalExpectations: z.array(testExpectationDataSchema).default([]),
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

export function defaultTestExpectation(
  type: TestExpectationType = 'current-room',
  operator: TestExpectationOperator = type === 'trait' ||
  type === 'layout' ||
  type === 'current-room'
    ? 'present'
    : 'eq',
): TestExpectationData {
  return testExpectationDataSchema.parse({ id: type, type, operator });
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

function validateExpectation(
  project: AuthoringProject,
  expectation: TestExpectationData,
  path: string,
  diagnostics: TestSchemaDiagnostic[],
) {
  const numeric = new Set<TestExpectationOperator>(['gt', 'gte', 'lt', 'lte']);
  const presence = new Set<TestExpectationOperator>(['present', 'absent']);
  const equality = new Set<TestExpectationOperator>(['eq', 'ne']);
  if (
    expectation.type === 'quantity' &&
    !numeric.has(expectation.operator) &&
    !equality.has(expectation.operator)
  )
    diagnostics.push(
      diagnostic(
        `${path}/operator`,
        'Quantity expectations require a numeric or equality operator.',
      ),
    );
  if (
    (expectation.type === 'trait' ||
      expectation.type === 'event' ||
      expectation.type === 'diagnostic') &&
    !presence.has(expectation.operator)
  )
    diagnostics.push(
      diagnostic(
        `${path}/operator`,
        `${titleCase(expectation.type)} expectations require present or absent.`,
      ),
    );
  if (
    expectation.type === 'layout' &&
    expectation.layout.field === 'mounted' &&
    !presence.has(expectation.operator)
  )
    diagnostics.push(
      diagnostic(`${path}/operator`, 'Mounted Layout expectations require present or absent.'),
    );
  if (
    expectation.type === 'layout' &&
    expectation.layout.field === 'state' &&
    presence.has(expectation.operator)
  )
    diagnostics.push(
      diagnostic(
        `${path}/operator`,
        'Layout state expectations require equality or numeric comparison.',
      ),
    );
  if (
    expectation.type === 'layout' &&
    expectation.layout.field === 'state' &&
    numeric.has(expectation.operator) &&
    typeof expectation.layout.value !== 'number'
  )
    diagnostics.push(
      diagnostic(
        `${path}/layout/value`,
        'Numeric Layout state comparisons require a numeric expected value.',
      ),
    );
  if (expectation.type === 'entity-state' && !equality.has(expectation.operator))
    diagnostics.push(diagnostic(`${path}/operator`, 'Entity-state expectations require eq or ne.'));
  if (
    (expectation.type === 'current-room' || expectation.type === 'active-flow') &&
    !equality.has(expectation.operator) &&
    !presence.has(expectation.operator)
  )
    diagnostics.push(
      diagnostic(
        `${path}/operator`,
        `${titleCase(expectation.type)} expectations require equality or presence operators.`,
      ),
    );
  if (
    expectation.type === 'location' &&
    !equality.has(expectation.operator) &&
    !presence.has(expectation.operator)
  )
    diagnostics.push(
      diagnostic(
        `${path}/operator`,
        'Location expectations require equality or presence operators.',
      ),
    );
  if (
    expectation.type === 'property' &&
    numeric.has(expectation.operator) &&
    typeof expectation.property.value !== 'number'
  )
    diagnostics.push(
      diagnostic(
        `${path}/property/value`,
        'Numeric property comparisons require a numeric expected value.',
      ),
    );

  if (expectation.type === 'current-room' && equality.has(expectation.operator)) {
    if (!expectation.currentRoom.roomId)
      diagnostics.push(diagnostic(`${path}/currentRoom/roomId`, 'Room ID is required.'));
    else if (!project.rooms[expectation.currentRoom.roomId])
      diagnostics.push(
        diagnostic(
          `${path}/currentRoom/roomId`,
          `Missing Room '${expectation.currentRoom.roomId}'.`,
        ),
      );
  }

  if (expectation.type === 'location') {
    const collection =
      expectation.location.entityKind === 'character'
        ? project.characters
        : project.interactableInstances;
    if (!expectation.location.entityId)
      diagnostics.push(diagnostic(`${path}/location/entityId`, 'Entity ID is required.'));
    else if (!collection[expectation.location.entityId])
      diagnostics.push(
        diagnostic(
          `${path}/location/entityId`,
          `Missing ${titleCase(expectation.location.entityKind)} '${expectation.location.entityId}'.`,
        ),
      );
    if (expectation.location.locationKind === 'room' && !project.rooms[expectation.location.roomId])
      diagnostics.push(
        diagnostic(`${path}/location/roomId`, `Missing Room '${expectation.location.roomId}'.`),
      );
    if (
      expectation.location.locationKind === 'inventory' &&
      !expectation.location.inventoryId.trim()
    )
      diagnostics.push(diagnostic(`${path}/location/inventoryId`, 'Inventory ID is required.'));
  }

  if (
    expectation.type === 'quantity' &&
    !project.interactableInstances[expectation.quantity.interactableId]
  )
    diagnostics.push(
      diagnostic(
        `${path}/quantity/interactableId`,
        `Missing Interactable Instance '${expectation.quantity.interactableId}'.`,
      ),
    );

  if (expectation.type === 'trait') {
    const ownerExists =
      expectation.trait.ownerKind === 'room'
        ? !!project.rooms[expectation.trait.ownerId]
        : expectation.trait.ownerKind === 'character'
          ? !!project.characters[expectation.trait.ownerId]
          : !!project.interactableInstances[expectation.trait.ownerId];
    if (!ownerExists)
      diagnostics.push(
        diagnostic(
          `${path}/trait/ownerId`,
          `Missing ${titleCase(expectation.trait.ownerKind)} '${expectation.trait.ownerId}'.`,
        ),
      );
    if (!project.traits[expectation.trait.traitId])
      diagnostics.push(
        diagnostic(`${path}/trait/traitId`, `Missing Trait '${expectation.trait.traitId}'.`),
      );
  }

  if (expectation.type === 'entity-state') {
    const collection =
      expectation.entityState.entityKind === 'character'
        ? project.characters
        : project.interactableInstances;
    if (!collection[expectation.entityState.entityId])
      diagnostics.push(
        diagnostic(
          `${path}/entityState/entityId`,
          `Missing ${titleCase(expectation.entityState.entityKind)} '${expectation.entityState.entityId}'.`,
        ),
      );
  }

  if (expectation.type === 'active-flow' && equality.has(expectation.operator)) {
    const collection = expectation.activeFlow.kind === 'scene' ? project.scenes : project.dialogues;
    if (!expectation.activeFlow.flowId)
      diagnostics.push(diagnostic(`${path}/activeFlow/flowId`, 'Flow ID is required.'));
    else if (!collection[expectation.activeFlow.flowId])
      diagnostics.push(
        diagnostic(
          `${path}/activeFlow/flowId`,
          `Missing ${titleCase(expectation.activeFlow.kind)} '${expectation.activeFlow.flowId}'.`,
        ),
      );
  }

  if (expectation.type === 'layout' && !project.layouts[expectation.layout.layoutId])
    diagnostics.push(
      diagnostic(`${path}/layout/layoutId`, `Missing Layout '${expectation.layout.layoutId}'.`),
    );

  if (expectation.type === 'property') {
    if (expectation.property.scope === 'global') {
      if (!project.variables[expectation.property.propertyId])
        diagnostics.push(
          diagnostic(
            `${path}/property/propertyId`,
            `Missing global Property '${expectation.property.propertyId}'.`,
          ),
        );
    } else {
      const ownerExists =
        expectation.property.scope === 'room'
          ? !!project.rooms[expectation.property.ownerId]
          : expectation.property.scope === 'character'
            ? !!project.characters[expectation.property.ownerId]
            : !!project.interactableInstances[expectation.property.ownerId];
      if (!ownerExists)
        diagnostics.push(
          diagnostic(
            `${path}/property/ownerId`,
            `Missing ${titleCase(expectation.property.scope)} '${expectation.property.ownerId}'.`,
          ),
        );
    }
  }
}

function validateStep(
  project: AuthoringProject,
  step: TestStepData,
  path: string,
  diagnostics: TestSchemaDiagnostic[],
) {
  if (!step.label.trim()) diagnostics.push(diagnostic(`${path}/label`, 'Step label is required.'));
  validateUniqueIds(step.expectations, `${path}/expectations`, 'expectation', diagnostics);
  step.expectations.forEach((expectation, index) =>
    validateExpectation(project, expectation, `${path}/expectations/${index}`, diagnostics),
  );
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
  if (step.input === 'ui-click') {
    if (!step.uiClick.documentId.trim())
      diagnostics.push(
        diagnostic(`${path}/uiClick/documentId`, 'UI click document id is required.'),
      );
    if (!step.uiClick.selector.trim())
      diagnostics.push(diagnostic(`${path}/uiClick/selector`, 'UI click selector is required.'));
  }
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
  validateUniqueIds(
    data.finalExpectations,
    `${base}/finalExpectations`,
    'expectation',
    diagnostics,
  );
  data.finalExpectations.forEach((expectation, index) =>
    validateExpectation(project, expectation, `${base}/finalExpectations/${index}`, diagnostics),
  );
  return diagnostics;
}
