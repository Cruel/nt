import { describe, expect, it } from 'vite-plus/test';
import { toJsonValue } from '@/project/json-value';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import {
  defaultTestData,
  defaultTestStep,
  testRoomHotspotRef,
} from '../../shared/project-schema/authoring-tests';

const rect = { kind: 'rect' as const, bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
const behavior = {
  id: 'hotspot',
  label: 'Hotspot',
  condition: { kind: 'always' as const },
  inputOrder: 0,
  highlight: { kind: 'none' as const },
  activation: { kind: 'verb' as const, verb: null },
};

describe('hotspot commands', () => {
  it('adds, moves, and undoes one Room hotspot command at a time', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    let state = createInitialCommandBusState(toJsonValue(project));
    const added = executeCommand(state, {
      type: 'room.addHotspot',
      payload: { roomId: 'foyer', hotspot: { ...behavior, shape: rect } },
    });
    expect(added.ok).toBe(true);
    expect(added.document).toMatchObject({
      rooms: { foyer: { data: { hotspots: [{ id: 'hotspot', shape: rect }] } } },
    });
    state = added.state;
    const moved = executeCommand(state, {
      type: 'room.setHotspotBounds',
      payload: {
        roomId: 'foyer',
        hotspotId: 'hotspot',
        bounds: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 },
      },
    });
    expect(moved.ok).toBe(true);
    expect(undoCommand(moved.state).document).toEqual(added.document);
  });

  it('renames exact Interaction references atomically and blocks deletion', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.hotspots = [{ ...behavior, shape: rect }];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const interaction = defaultInteractionData();
    interaction.rules = [
      {
        id: 'rule',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        operands: [],
        context: {
          kind: 'hotspot',
          hotspot: {
            kind: 'room-hotspot',
            room: { $ref: { collection: 'rooms', id: 'foyer' } },
            hotspotId: 'hotspot',
          },
        },
        program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
      },
    ];
    project.interactions.inspect = { id: 'inspect', label: 'Inspect', data: interaction };
    const state = createInitialCommandBusState(toJsonValue(project));
    const blocked = executeCommand(state, {
      type: 'room.deleteHotspot',
      payload: { roomId: 'foyer', hotspotId: 'hotspot' },
    });
    expect(blocked.ok).toBe(false);
    const renamed = executeCommand(state, {
      type: 'room.renameHotspot',
      payload: { roomId: 'foyer', hotspotId: 'hotspot', nextId: 'door' },
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.document).toMatchObject({
      rooms: { foyer: { data: { hotspots: [{ id: 'door' }] } } },
      interactions: {
        inspect: { data: { rules: [{ context: { hotspot: { hotspotId: 'door' } } }] } },
      },
    });
  });

  it('uses graph-backed references to rewrite Test steps and block deletion', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.hotspots = [{ ...behavior, shape: rect }];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const test = defaultTestData('Hotspot test');
    test.steps = [
      {
        ...defaultTestStep('activate-hotspot', 'Activate hotspot'),
        activateHotspot: { hotspot: testRoomHotspotRef('foyer', 'hotspot') },
      },
    ];
    project.tests.hotspot = { id: 'hotspot', label: 'Hotspot test', data: test };
    const state = createInitialCommandBusState(toJsonValue(project));

    const blocked = executeCommand(state, {
      type: 'room.deleteHotspot',
      payload: { roomId: 'foyer', hotspotId: 'hotspot' },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.diagnostics[0]?.path).toBe(
      '/tests/hotspot/data/steps/0/activateHotspot/hotspot',
    );

    const renamed = executeCommand(state, {
      type: 'room.renameHotspot',
      payload: { roomId: 'foyer', hotspotId: 'hotspot', nextId: 'door' },
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.document).toMatchObject({
      rooms: { foyer: { data: { hotspots: [{ id: 'door' }] } } },
      tests: {
        hotspot: {
          data: { steps: [{ activateHotspot: { hotspot: { hotspotId: 'door' } } }] },
        },
      },
    });
  });

  it('rejects stale Room and sprite-alpha hotspot rename commands without patches', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.hotspots = [{ ...behavior, shape: rect }];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.lamp = {
      id: 'lamp',
      label: 'Lamp',
      data: defaultInteractableData('Lamp'),
    };
    const state = createInitialCommandBusState(toJsonValue(project));

    const roomRename = executeCommand(state, {
      type: 'room.renameHotspot',
      payload: { roomId: 'foyer', hotspotId: 'missing', nextId: 'door' },
    });
    expect(roomRename.ok).toBe(false);
    expect(roomRename.diagnostics[0]?.message).toBe('Hotspot does not exist.');

    const interactableRename = executeCommand(state, {
      type: 'interactable.renameHotspot',
      payload: { interactableId: 'lamp', hotspotId: 'missing', nextId: 'renamed' },
    });
    expect(interactableRename.ok).toBe(false);
    expect(interactableRename.diagnostics[0]?.message).toBe('Hotspot does not exist.');
  });

  it('keeps alpha singular and refuses mode switches that remove referenced hotspots', () => {
    const project = createAuthoringProject();
    const interactable = defaultInteractableData('Lamp');
    project.interactables.lamp = { id: 'lamp', label: 'Lamp', data: interactable };
    const interaction = defaultInteractionData();
    interaction.rules = [
      {
        id: 'rule',
        verb: { $ref: { collection: 'verbs', id: 'use' } },
        operands: [{ kind: 'any-interactable' }],
        context: {
          kind: 'hotspot',
          hotspot: {
            kind: 'interactable-hotspot',
            interactable: { $ref: { collection: 'interactables', id: 'lamp' } },
            hotspotId: 'primary',
          },
        },
        program: { instructions: [], completion: { kind: 'return' }, outcome: 'handled' },
      },
    ];
    project.interactions.use = { id: 'use', label: 'Use', data: interaction };
    const state = createInitialCommandBusState(toJsonValue(project));
    const blocked = executeCommand(state, {
      type: 'interactable.setHotspotMode',
      payload: { interactableId: 'lamp', kind: 'custom' },
    });
    expect(blocked.ok).toBe(false);
  });
});
