import './native-schema/register-typescript.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const { conditionSchema, gameplayCommandSchema } =
  await import('../src/shared/project-schema/authoring-flow.ts');

// Test the native generated-contract boundary against the authoritative Zod
// schema, not another hand-written declaration of each Command's shape.
const ref = (collection, id) => ({ $ref: { collection, id } });
const variable = ref('variables', 'score');
const trait = ref('traits', 'inspectable');
const scene = ref('scenes', 'scene-a');
const character = ref('characters', 'character-a');
const interactable = ref('interactables', 'item-a');
const room = ref('rooms', 'room-a');
const actor = { kind: 'character', character };
const source = {
  kind: 'interactable',
  interactable: { $ref: { registry: 'interactableInstances', id: 'instance-a' } },
};
const inventory = { kind: 'player-inventory' };
const location = { kind: 'unplaced' };
const matcher = { definition: interactable, traits: [trait] };
const always = { kind: 'always' };
const comparison = { kind: 'variable-comparison', variable, operator: 'greater-equal', value: 2 };
const branch = (condition = always, thenCommands = [], elseCommands = []) => ({
  id: 'choose',
  kind: 'if',
  condition,
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is the canonical Gameplay Command field.
  then: thenCommands,
  else: elseCommands,
});
const command = (kind, fields = {}) => ({ id: `command-${kind}`, kind, ...fields });

const validConditions = [
  always,
  {
    kind: 'all',
    conditions: [
      comparison,
      { kind: 'any', conditions: [always, { kind: 'not', condition: always }] },
    ],
  },
  { kind: 'not', condition: { kind: 'lua-predicate', source: 'return true' } },
  { kind: 'property-comparison', owner: actor, propertyId: 'status', operator: 'truthy' },
  { kind: 'trait-presence', owner: { kind: 'current-room' }, trait, present: true },
  {
    kind: 'location-comparison',
    subject: actor,
    operator: 'not-equal',
    location: { kind: 'room', room: { kind: 'current-room' } },
  },
  { kind: 'inventory-quantity-comparison', inventory, matcher, operator: 'less', quantity: 3 },
  { kind: 'lua-predicate', source: 'return true', additionalDependencies: { targets: [] } },
  {
    kind: 'lua-predicate',
    source: 'return true',
    additionalDependencies: {
      targets: [
        { kind: 'record', collection: 'rooms', id: 'room-a' },
        { kind: 'room-exit', roomId: 'room-a', exitId: 'east' },
      ],
    },
  },
];

const validCommands = [
  command('set-global-property', { variable, value: 9 }),
  command('unset-global-property', { variable }),
  command('set-property', { owner: actor, propertyId: 'status', value: true }),
  command('unset-property', { owner: actor, propertyId: 'status' }),
  command('add-trait', { owner: actor, trait }),
  command('remove-trait', { owner: actor, trait }),
  command('set-enabled', { subject: actor, enabled: true }),
  command('set-visible', { subject: actor, visible: false }),
  command('move-instance', { subject: actor, location }),
  command('create-room', {
    source: { kind: 'archetype', archetype: ref('archetypes', 'room-template') },
    result: 'created',
  }),
  command('create-character', {
    source: { kind: 'compiled-instance', instance: actor },
    location,
    enabled: true,
    visible: false,
  }),
  command('create-interactable', {
    definition: interactable,
    quantity: 1,
    location,
    enabled: true,
    visible: true,
    roomPresentation: 'resolve',
  }),
  command('destroy-instance', { instance: actor }),
  command('split-quantity', { source, quantity: 2, result: 'part' }),
  command('merge-quantity', {
    receiver: source,
    donor: { kind: 'interaction-slot', slotId: 'target' },
  }),
  command('transfer-quantity', {
    mode: 'exact',
    source,
    quantity: 2,
    location,
    result: 'transferred',
  }),
  command('transfer-quantity', {
    mode: 'aggregate',
    matcher,
    sourceInventory: inventory,
    quantity: 2,
    location,
  }),
  command('add-quantity', { definition: interactable, quantity: 2, location }),
  command('consume-quantity', { mode: 'exact', source, quantity: 2 }),
  command('consume-quantity', {
    mode: 'aggregate',
    matcher,
    sourceInventory: inventory,
    quantity: 2,
  }),
  command('present-inventory', {
    inventory,
    layout: ref('layouts', 'inventory-layout'),
    coexist: true,
  }),
  command('navigate-exit', { exitId: 'east' }),
  command('change-room', { room: { kind: 'room', room } }),
  command('call-scene', { scene }),
  command('call-dialogue', { dialogue: ref('dialogues', 'dialogue-a') }),
  command('notify', { message: { source: { kind: 'inline', text: 'Hello' }, markup: 'plain' } }),
  command('run-lua', { source: 'return true' }),
  branch(
    { kind: 'all', conditions: [comparison, { kind: 'not', condition: always }] },
    [
      command('set-global-property', { variable, value: null }),
      branch(always, [command('run-lua', { source: 'return true' })], []),
    ],
    [
      command('notify', {
        message: {
          source: { kind: 'lua-expression', source: 'return "fallback"' },
          markup: 'active-text',
        },
      }),
    ],
  ),
];

const clone = (value) => structuredClone(value);
const invalidConditions = [
  [
    'nested-bad-lua-source',
    {
      kind: 'all',
      conditions: [always, { kind: 'not', condition: { kind: 'lua-predicate', source: 7 } }],
    },
    '/conditions/1/condition/source',
    'schema.type',
  ],
  [
    'nested-unknown-kind',
    { kind: 'any', conditions: [{ kind: 'not', condition: { kind: 'unknown' } }] },
    '/conditions/0/condition/kind',
    'schema.discriminator',
  ],
  ['missing-not-child', { kind: 'not' }, '/condition', 'schema.required'],
  [
    'invalid-quantity',
    {
      kind: 'inventory-quantity-comparison',
      inventory,
      matcher: {},
      operator: 'equal',
      quantity: -1,
    },
    '/quantity',
    'schema.minimum',
  ],
  [
    'bad-operand',
    {
      kind: 'property-comparison',
      owner: { kind: 'character', character: 123 },
      propertyId: 'status',
      operator: 'equal',
      value: 1,
    },
    '/owner/character',
    'schema.type',
  ],
  [
    'duplicate-lua-dependencies',
    {
      kind: 'lua-predicate',
      source: 'return true',
      additionalDependencies: {
        targets: [
          { kind: 'record', collection: 'rooms', id: 'room-a' },
          { kind: 'record', collection: 'rooms', id: 'room-a' },
        ],
      },
    },
    '/additionalDependencies/targets/1',
    'semantic.lua.dependencies.unique',
  ],
];

const nested = branch(
  always,
  [branch(always, [command('run-lua', { source: 'return true' })], [])],
  [],
);
const invalidCommands = [
  ['unknown-command', command('undefined-operation', {}), '/kind', 'schema.discriminator'],
  [
    'nested-condition',
    branch(
      {
        kind: 'not',
        condition: { kind: 'all', conditions: [always, { kind: 'lua-predicate', source: 99 }] },
      },
      [],
      [],
    ),
    '/condition/condition/conditions/1/source',
    'schema.type',
  ],
  [
    'deep-branch',
    (() => {
      const value = clone(nested);
      value.then[0].then[0].source = 17;
      return value;
    })(),
    '/then/0/then/0/source',
    'schema.type',
  ],
  [
    'invalid-transfer-mode',
    command('transfer-quantity', { mode: 'unknown', source, quantity: 1, location }),
    '/mode',
    'schema.discriminator',
  ],
  [
    'transfer-missing-matcher',
    command('transfer-quantity', { mode: 'aggregate', source, quantity: 1, location }),
    '/matcher',
    'schema.required',
  ],
  [
    'transfer-exact-missing-source',
    command('transfer-quantity', { mode: 'exact', quantity: 1, location }),
    '/source',
    'schema.required',
  ],
  [
    'consume-negative-quantity',
    command('consume-quantity', { mode: 'exact', source, quantity: -2 }),
    '/quantity',
    'schema.exclusiveMinimum',
  ],
  [
    'consume-invalid-scalar',
    command('set-global-property', { variable, value: { unexpected: 1 } }),
    '/value',
    'schema.type',
  ],
  [
    'invalid-nested-kind',
    branch(always, [command('made-up')], []),
    '/then/0/kind',
    'schema.discriminator',
  ],
];

const cases = [
  ...validConditions.map((value, i) => ({
    contract: 'Condition',
    name: `valid-condition-${i}`,
    value,
  })),
  ...validCommands.map((value, i) => ({
    contract: 'GameplayCommand',
    name: `valid-command-${i}`,
    value,
  })),
  ...invalidConditions.map(([name, value, path, code]) => ({
    contract: 'Condition',
    name,
    value,
    path,
    code,
  })),
  ...invalidCommands.map(([name, value, path, code]) => ({
    contract: 'GameplayCommand',
    name,
    value,
    path,
    code,
  })),
];

const input =
  cases.map(({ contract, value }) => JSON.stringify({ contract, value })).join('\n') + '\n';
const native = spawnSync(process.argv[2], [], {
  input,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(native.status, 0, `Native Flow verifier failed: ${native.stderr || native.error}`);
const outputs = native.stdout
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.equal(outputs.length, cases.length, 'Native Flow verifier did not return every case');

const zodIssuePaths = (issues, parent = []) =>
  issues.flatMap((issue) => {
    const path = [...parent, ...issue.path];
    return [
      `/${path.join('/')}`,
      ...(issue.errors ?? []).flatMap((branch) => zodIssuePaths(branch, path)),
    ];
  });

for (const [index, fixture] of cases.entries()) {
  const schema = fixture.contract === 'Condition' ? conditionSchema : gameplayCommandSchema;
  const expected = schema.safeParse(fixture.value);
  const actual = outputs[index];
  assert.equal(
    actual.accepted,
    expected.success,
    `${fixture.name}: native acceptance differs from Zod: ${JSON.stringify({ actual, zod: expected.error?.issues })}`,
  );
  if (expected.success) {
    assert.deepEqual(
      actual.normalized,
      JSON.parse(JSON.stringify(expected.data)),
      `${fixture.name}: native normalized value differs from Zod`,
    );
    assert.deepEqual(
      actual.diagnostics,
      [],
      `${fixture.name}: unexpected valid-record diagnostics`,
    );
  } else {
    assert.ok(actual.diagnostics.length > 0, `${fixture.name}: missing native diagnostics`);
    if (fixture.path) {
      assert.ok(
        zodIssuePaths(expected.error.issues).includes(fixture.path),
        `${fixture.name}: expected path ${fixture.path} was not reported by Zod: ${JSON.stringify(expected.error.issues)}`,
      );
      assert.ok(
        actual.diagnostics.some(({ path, code }) => path === fixture.path && code === fixture.code),
        `${fixture.name}: missing diagnostic ${fixture.path} (${fixture.code}): ${JSON.stringify(actual.diagnostics)}`,
      );
    }
    assert.ok(
      actual.diagnostics.every(
        ({ path, code }) =>
          !path.startsWith('/__union') && code !== 'contract.unsupported_operation',
      ),
      `${fixture.name}: generic union error or unsupported native operation`,
    );
  }
}

console.log(
  `Native/Zod Flow differential certified ${cases.length} Conditions and Gameplay Commands.`,
);
