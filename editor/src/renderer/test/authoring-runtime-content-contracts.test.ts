import { describe, expect, it } from 'vite-plus/test';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultMapData } from '../../shared/project-schema/authoring-maps';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultScriptModuleData } from '../../shared/project-schema/authoring-script-modules';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';

describe('runtime-content authoring contracts', () => {
  it('links typed Verb, Interaction, Map, and Script Module records without generic action payloads', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.rooms.garden = { id: 'garden', label: 'Garden', data: defaultRoomData('Garden') };
    project.rooms.foyer.data.exits.push({
      id: 'to-garden',
      label: 'Garden',
      direction: 'east',
      target: { $ref: { collection: 'rooms', id: 'garden' } },
      condition: { kind: 'always' },
    });
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      extends: null,
      properties: {},
      data: defaultInteractableData('Key'),
    };
    const verb = defaultVerbData('Use');
    verb.arity = 1;
    verb.operandRoles = ['target'];
    project.verbs.use = { id: 'use', label: 'Use', extends: null, properties: {}, data: verb };
    const interaction = defaultInteractionData();
    interaction.rules.push({
      id: 'use-key',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      operands: [
        {
          kind: 'exact',
          subject: {
            kind: 'interactable',
            interactable: { $ref: { collection: 'interactables', id: 'key' } },
          },
        },
      ],
      context: { kind: 'active-room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
      program: { instructions: [], completion: { kind: 'end' }, outcome: 'handled' },
    });
    project.interactions.actions = {
      id: 'actions',
      label: 'Actions',
      extends: null,
      properties: {},
      data: interaction,
    };
    const map = defaultMapData();
    map.locations.push(
      {
        id: 'foyer-location',
        room: { $ref: { collection: 'rooms', id: 'foyer' } },
        position: { x: 0, y: 0 },
        shape: { kind: 'point' },
        label: null,
      },
      {
        id: 'garden-location',
        room: { $ref: { collection: 'rooms', id: 'garden' } },
        position: { x: 1, y: 0 },
        shape: { kind: 'circle', radius: 1 },
        label: null,
      },
    );
    map.connections.push({
      id: 'foyer-garden',
      exit: { room: 'foyer', exit: 'to-garden' },
      sourceLocation: 'foyer-location',
      targetLocation: 'garden-location',
    });
    project.maps.world = { id: 'world', label: 'World', extends: null, properties: {}, data: map };
    project.scripts.boot = { id: 'boot', label: 'Boot', data: defaultScriptModuleData() };
    expect(isAuthoringProject(project)).toBe(true);
    expect(validateAuthoringProject(project).filter((item) => item.severity === 'error')).toEqual(
      [],
    );
  });

  it('rejects mismatched operands, nested unknown program fields, and nonexclusive Script Module source data', () => {
    const project = createAuthoringProject();
    const verb = defaultVerbData();
    verb.arity = 1;
    verb.operandRoles = ['target'];
    project.verbs.use = { id: 'use', label: 'Use', extends: null, properties: {}, data: verb };
    const interaction = defaultInteractionData();
    interaction.rules.push({
      id: 'bad-rule',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      operands: [],
      context: { kind: 'any' },
      program: { instructions: [], completion: { kind: 'end' }, outcome: 'handled' },
    });
    project.interactions.actions = {
      id: 'actions',
      label: 'Actions',
      extends: null,
      properties: {},
      data: interaction,
    };
    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/interactions/actions/data/rules/0/operands' }),
      ]),
    );
    expect(
      isAuthoringProject({
        ...project,
        verbs: {
          use: {
            ...project.verbs.use,
            data: { ...verb, defaultProgram: { ...verb.defaultProgram, mystery: true } },
          },
        },
      }),
    ).toBe(false);
    expect(
      isAuthoringProject({
        ...project,
        scripts: {
          boot: {
            id: 'boot',
            label: 'Boot',
            data: {
              kind: 'script-module',
              source: {
                kind: 'inline-lua',
                source: '',
                asset: { $ref: { collection: 'assets', id: 'boot' } },
              },
            },
          },
        },
      }),
    ).toBe(false);
  });
});
