import { describe, expect, it } from 'vite-plus/test';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import {
  defaultInteractionData,
  parseInteractionData,
  validateInteractionData,
  validateInteractionResolverProject,
} from '../../shared/project-schema/authoring-interactions';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';

const slotText = (text: string) => ({
  source: { kind: 'inline' as const, text },
  markup: 'plain' as const,
});
const oneSlotVerb = (label: string, id = 'target') => ({
  ...defaultVerbData(label),
  slots: [
    {
      id,
      label: slotText(id),
      prompt: slotText(id),
      selectors: [{ kind: 'any-subject' as const }],
    },
  ],
  bindingOrder: [id],
});
const twoSlotVerb = (label: string) => ({
  ...defaultVerbData(label),
  slots: [
    {
      id: 'first',
      label: slotText('first'),
      prompt: slotText('first'),
      selectors: [{ kind: 'any-subject' as const }],
    },
    {
      id: 'second',
      label: slotText('second'),
      prompt: slotText('second'),
      selectors: [{ kind: 'any-subject' as const }],
    },
  ],
  bindingOrder: ['first', 'second'],
});

describe('authoring interactions', () => {
  it('rejects unconditional equal-priority rules at the same structural tier', () => {
    const project = createAuthoringProject();
    project.verbs.look = {
      id: 'look',
      label: 'Look',
      data: defaultVerbData('Look'),
    };
    const data = defaultInteractionData();
    data.rules.push(
      {
        id: 'a',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        slots: [],
        offer: null,
        guard: { kind: 'always' },
        priority: 10,
        program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
      },
      {
        id: 'b',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        slots: [],
        offer: null,
        guard: { kind: 'always' },
        priority: 10,
        program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
      },
    );

    const diagnostics = validateInteractionData(project, 'rules', {
      id: 'rules',
      label: 'Rules',
      data,
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/interactions/rules/data/rules/1' }),
    );
  });

  it('warns when guarded equal-priority rules may overlap at the same structural tier', () => {
    const project = createAuthoringProject();
    project.verbs.look = {
      id: 'look',
      label: 'Look',
      data: defaultVerbData('Look'),
    };
    const data = defaultInteractionData();
    data.rules.push(
      {
        id: 'a',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        slots: [],
        offer: null,
        guard: { kind: 'lua-predicate', source: 'can_a()' },
        priority: 10,
        program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
      },
      {
        id: 'b',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        slots: [],
        offer: null,
        guard: { kind: 'lua-predicate', source: 'can_b()' },
        priority: 10,
        program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
      },
    );

    const diagnostics = validateInteractionData(project, 'rules', {
      id: 'rules',
      label: 'Rules',
      data,
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning', path: '/interactions/rules/data/rules/1' }),
    );
  });

  it('rejects rules whose subject space cannot satisfy the Verb slot', () => {
    const project = createAuthoringProject();
    const verb: ReturnType<typeof defaultVerbData> = oneSlotVerb('Use');
    verb.slots[0]!.selectors = [{ kind: 'family', family: 'character' }];
    project.verbs.use = { id: 'use', label: 'Use', data: verb };
    const data = defaultInteractionData();
    data.rules.push({
      id: 'impossible',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      slots: [{ slotId: 'target', selectors: [{ kind: 'family', family: 'interactable' }] }],
      offer: null,
      guard: { kind: 'always' },
      priority: 0,
      program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
    });

    const diagnostics = validateInteractionData(project, 'rules', {
      id: 'rules',
      label: 'Rules',
      data,
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        path: '/interactions/rules/data/rules/0/slots/0/selectors',
      }),
    );
  });

  it('detects unconditional equal-tier conflicts across Interaction records', () => {
    const project = createAuthoringProject();
    project.verbs.use = { id: 'use', label: 'Use', data: oneSlotVerb('Use') };
    const makeRule = (id: string) => ({
      id,
      verb: { $ref: { collection: 'verbs' as const, id: 'use' } },
      slots: [
        {
          slotId: 'target',
          selectors: [{ kind: 'family' as const, family: 'interactable' as const }],
        },
      ],
      offer: null,
      guard: { kind: 'always' as const },
      priority: 10,
      program: {
        instructions: [],
        completion: { kind: 'return' as const },
        outcome: 'handled' as const,
      },
    });
    project.interactions.first = {
      id: 'first',
      label: 'First',
      data: { kind: 'interaction', rules: [makeRule('a')] },
    };
    project.interactions.second = {
      id: 'second',
      label: 'Second',
      data: { kind: 'interaction', rules: [makeRule('b')] },
    };

    expect(validateInteractionResolverProject(project)).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        path: '/interactions/second/data/rules/0',
      }),
    );
  });

  it('rejects duplicate stable instruction IDs', () => {
    const project = createAuthoringProject();
    project.verbs.look = { id: 'look', label: 'Look', data: defaultVerbData('Look') };
    const data = defaultInteractionData();
    data.rules = [
      {
        id: 'look-rule',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        slots: [],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program: {
          instructions: [
            {
              id: 'notice',
              kind: 'notify',
              message: { source: { kind: 'inline', text: 'One' }, markup: 'plain' },
            },
            {
              id: 'notice',
              kind: 'notify',
              message: { source: { kind: 'inline', text: 'Two' }, markup: 'plain' },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'handled',
        },
      },
    ];
    const diagnostics = validateInteractionData(project, 'rules', {
      id: 'rules',
      label: 'Rules',
      data,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        path: '/interactions/rules/data/rules/0/program/instructions/1/id',
        severity: 'error',
      }),
    );
  });

  it('rejects unhandled behavior that would commit work before fallback', () => {
    const project = createAuthoringProject();
    project.verbs.look = { id: 'look', label: 'Look', data: defaultVerbData('Look') };
    const data = defaultInteractionData();
    data.rules = [
      {
        id: 'bad-fallback',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        slots: [],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program: {
          instructions: [
            {
              id: 'notice',
              kind: 'notify',
              message: { source: { kind: 'inline', text: 'Committed' }, markup: 'plain' },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'unhandled',
        },
      },
    ];
    const diagnostics = validateInteractionData(project, 'rules', {
      id: 'rules',
      label: 'Rules',
      data,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        path: '/interactions/rules/data/rules/0/program',
        severity: 'error',
      }),
    );
  });

  it('rejects more than one terminal action in a compact behavior', () => {
    const project = createAuthoringProject();
    project.verbs.look = { id: 'look', label: 'Look', data: defaultVerbData('Look') };
    const data = defaultInteractionData();
    data.rules = [
      {
        id: 'too-many-terminals',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        slots: [],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program: {
          instructions: [
            {
              id: 'first',
              kind: 'notify',
              message: { source: { kind: 'inline', text: 'One' }, markup: 'plain' },
            },
            {
              id: 'second',
              kind: 'notify',
              message: { source: { kind: 'inline', text: 'Two' }, markup: 'plain' },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'handled',
        },
      },
    ];
    const diagnostics = validateInteractionData(project, 'rules', {
      id: 'rules',
      label: 'Rules',
      data,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        path: '/interactions/rules/data/rules/0/program',
        severity: 'error',
      }),
    );
  });

  it('indexes typed Verb and Interactable definition references', () => {
    const project = createAuthoringProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      traits: [],
      data: defaultInteractableData('Key'),
    };
    project.verbs.use = {
      id: 'use',
      label: 'Use',
      data: oneSlotVerb('Use'),
    };
    const interaction = defaultInteractionData();
    interaction.rules.push({
      id: 'use-key',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      slots: [
        {
          slotId: 'target',
          selectors: [
            {
              kind: 'interactable-definition',
              interactableDefinition: { $ref: { collection: 'interactables', id: 'key' } },
            },
          ],
        },
      ],
      offer: null,
      guard: { kind: 'always' },
      priority: 0,
      program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
    });
    project.interactions.use = {
      id: 'use',
      label: 'Use',
      data: interaction,
    };

    const index = buildReferenceIndex(project);
    expect(findUsages(index, { collection: 'interactables', id: 'key' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/interactions/use/data/rules/0/slots/0/selectors/0/interactableDefinition/$ref',
        }),
      ]),
    );
    expect(findUsages(index, { collection: 'verbs', id: 'use' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/interactions/use/data/rules/0/verb/$ref' }),
      ]),
    );
  });

  it('accepts the closed Character, Interactable, and wildcard operand variants', () => {
    const project = createAuthoringProject();
    project.characters.guard = { id: 'guard', label: 'Guard', data: defaultCharacterData('Guard') };
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key');
    project.verbs.combine = {
      id: 'combine',
      label: 'Combine',
      data: twoSlotVerb('Combine'),
    };
    const data = defaultInteractionData();
    const program = {
      instructions: [],
      completion: { kind: 'return' as const },
      outcome: 'handled' as const,
    };
    data.rules = [
      {
        id: 'exact',
        verb: { $ref: { collection: 'verbs', id: 'combine' } },
        slots: [
          {
            slotId: 'first',
            selectors: [
              {
                kind: 'exact',
                subject: {
                  kind: 'character',
                  character: { $ref: { collection: 'characters', id: 'guard' } },
                },
              },
            ],
          },
          {
            slotId: 'second',
            selectors: [
              {
                kind: 'exact',
                subject: {
                  kind: 'interactable',
                  interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
                },
              },
            ],
          },
        ],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program,
      },
      {
        id: 'characters',
        verb: { $ref: { collection: 'verbs', id: 'combine' } },
        slots: [
          { slotId: 'first', selectors: [{ kind: 'family', family: 'character' }] },
          { slotId: 'second', selectors: [{ kind: 'any-subject' }] },
        ],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program,
      },
      {
        id: 'interactables',
        verb: { $ref: { collection: 'verbs', id: 'combine' } },
        slots: [
          { slotId: 'first', selectors: [{ kind: 'family', family: 'interactable' }] },
          { slotId: 'second', selectors: [{ kind: 'any-subject' }] },
        ],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program,
      },
    ];

    expect(parseInteractionData(data)).not.toBeNull();
    expect(
      validateInteractionData(project, 'subjects', {
        id: 'subjects',
        label: 'Subjects',
        data,
      }).filter((item) => item.severity === 'error'),
    ).toEqual([]);
    expect(
      parseInteractionData({
        ...data,
        rules: [
          {
            ...data.rules[0],
            slots: [{ slotId: 'first', selectors: [{ kind: 'any-object' }] }],
          },
        ],
      }),
    ).toBeNull();
  });
});
