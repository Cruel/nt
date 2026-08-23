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

function oneSlotVerb(label = 'Use') {
  const verb = defaultVerbData(label);
  const text = { source: { kind: 'inline' as const, text: 'target' }, markup: 'plain' as const };
  verb.slots = [{ id: 'target', label: text, prompt: text, selectors: [{ kind: 'any-subject' }] }];
  verb.bindingOrder = ['target'];
  return verb;
}

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
    const key = defaultInteractableData('Key');
    key.presentation.hotspots = { kind: 'custom', hotspots: [] };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      traits: [],
      properties: {},
      data: key,
    };
    const verb = oneSlotVerb('Use');
    project.verbs.use = { id: 'use', label: 'Use', data: verb };
    const interaction = defaultInteractionData();
    interaction.rules.push({
      id: 'use-key',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      slots: [
        {
          slotId: 'target',
          selectors: [
            {
              kind: 'exact',
              subject: {
                kind: 'interactable',
                interactable: { $ref: { collection: 'interactables', id: 'key' } },
              },
            },
          ],
        },
      ],
      offer: null,
      context: { kind: 'active-room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
      program: { instructions: [], completion: { kind: 'end' }, outcome: 'handled' },
    });
    project.interactions.actions = {
      id: 'actions',
      label: 'Actions',
      data: interaction,
    };
    const map = defaultMapData();
    map.locations.push(
      {
        id: 'foyer-location',
        room: { $ref: { collection: 'rooms', id: 'foyer' } },
        regions: [],
        label: null,
        icon: null,
        style: null,
        labelAnchor: null,
        connectionAnchor: null,
        visibility: { kind: 'always' },
        pickOrder: 0,
        logicalOrder: 0,
      },
      {
        id: 'garden-location',
        room: { $ref: { collection: 'rooms', id: 'garden' } },
        regions: [],
        label: null,
        icon: null,
        style: null,
        labelAnchor: null,
        connectionAnchor: null,
        visibility: { kind: 'always' },
        pickOrder: 1,
        logicalOrder: 1,
      },
    );
    map.connections.push({
      id: 'foyer-garden',
      exits: [{ room: 'foyer', exit: 'to-garden' }],
      label: null,
      icon: null,
      style: null,
      visibility: { kind: 'always' },
      logicalOrder: 0,
      path: [],
      hitRegions: [],
    });
    project.maps.world = { id: 'world', label: 'World', data: map };
    project.scripts.boot = { id: 'boot', label: 'Boot', data: defaultScriptModuleData() };
    expect(isAuthoringProject(project)).toBe(true);
    expect(validateAuthoringProject(project).filter((item) => item.severity === 'error')).toEqual(
      [],
    );
  });

  it('rejects mismatched slots, nested unknown program fields, and nonexclusive Script Module source data', () => {
    const project = createAuthoringProject();
    const verb = oneSlotVerb();
    project.verbs.use = { id: 'use', label: 'Use', data: verb };
    const interaction = defaultInteractionData();
    interaction.rules.push({
      id: 'bad-rule',
      verb: { $ref: { collection: 'verbs', id: 'use' } },
      slots: [],
      offer: null,
      context: { kind: 'any' },
      program: { instructions: [], completion: { kind: 'end' }, outcome: 'handled' },
    });
    project.interactions.actions = {
      id: 'actions',
      label: 'Actions',
      data: interaction,
    };
    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/interactions/actions/data/rules/0/slots' }),
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
