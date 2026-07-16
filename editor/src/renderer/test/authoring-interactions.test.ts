import { describe, expect, it } from 'vitest';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultInteractionData, parseInteractionData, validateInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';

describe('authoring interactions', () => {
  it('does not warn that rules with different active-room contexts have equal specificity', () => {
    const project = createAuthoringProject();
    project.rooms.a = { id: 'a', label: 'A', extends: null, properties: {}, data: defaultRoomData('A') };
    project.rooms.b = { id: 'b', label: 'B', extends: null, properties: {}, data: defaultRoomData('B') };
    project.verbs.look = { id: 'look', label: 'Look', extends: null, properties: {}, data: defaultVerbData('Look') };
    const data = defaultInteractionData();
    data.rules.push(
      { id: 'a', verb: { $ref: { collection: 'verbs', id: 'look' } }, operands: [], context: { kind: 'active-room', room: { $ref: { collection: 'rooms', id: 'a' } } }, program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' } },
      { id: 'b', verb: { $ref: { collection: 'verbs', id: 'look' } }, operands: [], context: { kind: 'active-room', room: { $ref: { collection: 'rooms', id: 'b' } } }, program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' } },
    );

    const diagnostics = validateInteractionData(project, 'rules', {
      id: 'rules',
      label: 'Rules',
      extends: null,
      properties: {},
      data,
    });

    expect(diagnostics.filter((item) => item.severity === 'warning')).toEqual([]);
  });

  it('rejects duplicate stable instruction IDs', () => {
    const project = createAuthoringProject();
    project.verbs.look = { id: 'look', label: 'Look', data: defaultVerbData('Look') };
    const data = defaultInteractionData();
    data.rules = [{
      id: 'look-rule', verb: { $ref: { collection: 'verbs', id: 'look' } }, operands: [], context: { kind: 'any' },
      program: {
        instructions: [
          { id: 'notice', kind: 'notify', message: { source: { kind: 'inline', text: 'One' }, markup: 'plain' } },
          { id: 'notice', kind: 'notify', message: { source: { kind: 'inline', text: 'Two' }, markup: 'plain' } },
        ],
        completion: { kind: 'return' }, outcome: 'handled',
      },
    }];
    const diagnostics = validateInteractionData(project, 'rules', { id: 'rules', label: 'Rules', data });
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: '/interactions/rules/data/rules/0/program/instructions/1/id', severity: 'error' }));
  });

  it('indexes typed Verb and Interactable references', () => {
    const project = createAuthoringProject();
    project.interactables.key = { id: 'key', label: 'Key', extends: null, properties: {}, data: defaultInteractableData('Key') };
    project.verbs.use = {
      id: 'use',
      label: 'Use',
      extends: null,
      properties: {},
      data: { ...defaultVerbData('Use'), arity: 1, operandRoles: ['target'] },
    };
    const interaction = defaultInteractionData();
    interaction.rules.push({
      id: 'use-key',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      operands: [{ kind: 'exact', subject: { kind: 'interactable', interactable: { $ref: { collection: 'interactables', id: 'key' } } } }],
      context: { kind: 'any' },
      program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
    });
    project.interactions.use = { id: 'use', label: 'Use', extends: null, properties: {}, data: interaction };

    const index = buildReferenceIndex(project);
    expect(findUsages(index, { collection: 'interactables', id: 'key' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/interactions/use/data/rules/0/operands/0/subject/interactable/$ref' }),
    ]));
    expect(findUsages(index, { collection: 'verbs', id: 'use' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/interactions/use/data/rules/0/verb/$ref' }),
    ]));
  });

  it('accepts the closed Character, Interactable, and wildcard operand variants', () => {
    const project = createAuthoringProject();
    project.characters.guard = { id: 'guard', label: 'Guard', data: defaultCharacterData('Guard') };
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.verbs.combine = { id: 'combine', label: 'Combine', data: { ...defaultVerbData('Combine'), arity: 2, operandRoles: ['first', 'second'] } };
    const data = defaultInteractionData();
    const program = { instructions: [], completion: { kind: 'return' as const }, outcome: 'handled' as const };
    data.rules = [
      { id: 'exact', verb: { $ref: { collection: 'verbs', id: 'combine' } }, operands: [{ kind: 'exact', subject: { kind: 'character', character: { $ref: { collection: 'characters', id: 'guard' } } } }, { kind: 'exact', subject: { kind: 'interactable', interactable: { $ref: { collection: 'interactables', id: 'key' } } } }], context: { kind: 'any' }, program },
      { id: 'characters', verb: { $ref: { collection: 'verbs', id: 'combine' } }, operands: [{ kind: 'any-character' }, { kind: 'any-subject' }], context: { kind: 'any' }, program },
      { id: 'interactables', verb: { $ref: { collection: 'verbs', id: 'combine' } }, operands: [{ kind: 'any-interactable' }, { kind: 'any-subject' }], context: { kind: 'any' }, program },
    ];

    expect(parseInteractionData(data)).not.toBeNull();
    expect(validateInteractionData(project, 'subjects', { id: 'subjects', label: 'Subjects', data }).filter((item) => item.severity === 'error')).toEqual([]);
    expect(parseInteractionData({ ...data, rules: [{ ...data.rules[0], operands: [{ kind: 'any-object' }] }] })).toBeNull();
  });
});
