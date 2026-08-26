import { describe, expect, it } from 'vite-plus/test';
import { toJsonValue } from '@/project/json-value';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';

const rect = { kind: 'rect' as const, bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };

function roomHotspot(id = 'hotspot') {
  return {
    id,
    label: 'Door geometry',
    condition: { kind: 'always' as const },
    inputOrder: 0,
    highlight: { kind: 'none' as const },
    target: { kind: 'owner-feature' as const, featureId: 'door' },
    shape: rect,
  };
}

function spriteAlphaInteractable(label = 'Lamp') {
  const data = defaultInteractableData(label);
  data.presentation.hotspots = {
    kind: 'sprite-alpha',
    hotspot: defaultHotspotBehavior(label),
  };
  return data;
}

describe('hotspot commands', () => {
  it('adds, moves, and undoes one Room hotspot command at a time', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.features.push({ id: 'door', label: 'Door', traits: [], properties: {}, inventories: [] });
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    let state = createInitialCommandBusState(toJsonValue(project));

    const added = executeCommand(state, {
      type: 'room.addHotspot',
      payload: { roomId: 'foyer', hotspot: roomHotspot() },
    });
    expect(added.ok).toBe(true);
    expect(added.document).toMatchObject({
      rooms: {
        foyer: {
          data: {
            hotspots: [{ id: 'hotspot', target: { kind: 'owner-feature', featureId: 'door' } }],
          },
        },
      },
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

  it('renames and deletes Room geometry without rewriting semantic Feature identity', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.features.push({ id: 'door', label: 'Door', traits: [], properties: {}, inventories: [] });
    room.hotspots = [roomHotspot()];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const state = createInitialCommandBusState(toJsonValue(project));

    const renamed = executeCommand(state, {
      type: 'room.renameHotspot',
      payload: { roomId: 'foyer', hotspotId: 'hotspot', nextId: 'door-region' },
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.document).toMatchObject({
      rooms: {
        foyer: {
          data: {
            features: [{ id: 'door' }],
            hotspots: [{ id: 'door-region', target: { kind: 'owner-feature', featureId: 'door' } }],
          },
        },
      },
    });

    const removed = executeCommand(renamed.state, {
      type: 'room.deleteHotspot',
      payload: { roomId: 'foyer', hotspotId: 'door-region' },
    });
    expect(removed.ok).toBe(true);
    expect(removed.document).toMatchObject({
      rooms: { foyer: { data: { features: [{ id: 'door' }], hotspots: [] } } },
    });
  });

  it('rejects stale Room and sprite-alpha hotspot rename commands without patches', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.features.push({ id: 'door', label: 'Door', traits: [], properties: {}, inventories: [] });
    room.hotspots = [roomHotspot()];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.lamp = {
      id: 'lamp',
      label: 'Lamp',
      data: spriteAlphaInteractable(),
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

  it('can switch Interactable hotspot geometry modes because no semantic rule references Hotspot IDs', () => {
    const project = createAuthoringProject();
    const interactable = spriteAlphaInteractable();
    interactable.features.push({
      id: 'switch',
      label: 'Switch',
      traits: [],
      properties: {},
      inventories: [],
    });
    if (interactable.presentation.hotspots.kind !== 'sprite-alpha')
      throw new Error('Expected explicitly configured sprite-alpha hotspot mode.');
    interactable.presentation.hotspots.hotspot.target = {
      kind: 'owner-feature',
      featureId: 'switch',
    };
    project.interactables.lamp = { id: 'lamp', label: 'Lamp', data: interactable };
    const state = createInitialCommandBusState(toJsonValue(project));

    const switched = executeCommand(state, {
      type: 'interactable.setHotspotMode',
      payload: { interactableId: 'lamp', kind: 'custom' },
    });
    expect(switched.ok).toBe(true);
    expect(switched.document).toMatchObject({
      interactables: { lamp: { data: { presentation: { hotspots: { kind: 'custom' } } } } },
    });
  });
});
