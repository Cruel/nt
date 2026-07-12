import { describe, expect, it } from 'vitest';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData, roomRoomRef } from '../../shared/project-schema/authoring-rooms';

describe('room commands', () => {
  it('creates typed room data through entity.createRecord', () => {
    const project = createAuthoringProject();
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'rooms', entityId: 'foyer', label: 'Foyer' },
    });

    expect(result.ok).toBe(true);
    expect(result.document).toMatchObject({
      rooms: { foyer: { data: { kind: 'room', displayName: 'Foyer', exits: [], placements: [] } } },
    });
  });

  it('patches valid room data and rejects error diagnostics', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalidData = defaultRoomData('Foyer');
    invalidData.exits = [{ id: 'north', label: 'North', direction: 'north', target: roomRoomRef('missing'), condition: { kind: 'always' } }];
    const invalid = executeCommand(state, {
      type: 'room.replaceData',
      payload: { roomId: 'foyer', data: invalidData },
    });
    expect(invalid.ok).toBe(false);

    const next = defaultRoomData('Foyer');
    next.description.source = { kind: 'inline', text: 'Welcome to the foyer.' };
    const valid = executeCommand(state, {
      type: 'room.replaceData',
      label: 'Set room description',
      payload: { roomId: 'foyer', data: next },
    });
    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({ rooms: { foyer: { data: { description: { source: { text: 'Welcome to the foyer.' } } } } } });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({ rooms: { foyer: { data: { description: { source: { text: '' } } } } } });
  });

  it('repairs Interactable initial locations when placements are renamed or removed', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [{
      id: 'lamp-placement',
      interactable: { $ref: { collection: 'interactables', id: 'lamp' } },
      bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      presentation: { label: null, layout: null },
    }];
    const lamp = defaultInteractableData('Lamp');
    lamp.initialState.location = { kind: 'room-placement', placement: { room: 'foyer', placement: 'lamp-placement' } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.lamp = { id: 'lamp', label: 'Lamp', data: lamp };
    let state = createInitialCommandBusState(toJsonValue(project));

    const renamed = structuredClone(room);
    renamed.placements[0].id = 'lamp-anchor';
    const renameResult = executeCommand(state, { type: 'room.replaceData', payload: { roomId: 'foyer', data: renamed } });
    expect(renameResult.ok).toBe(true);
    expect(renameResult.document).toMatchObject({ interactables: { lamp: { data: { initialState: { location: { kind: 'room-placement', placement: { room: 'foyer', placement: 'lamp-anchor' } } } } } } });

    state = renameResult.state;
    const removed = structuredClone(renamed);
    removed.placements = [];
    const removeResult = executeCommand(state, { type: 'room.replaceData', payload: { roomId: 'foyer', data: removed } });
    expect(removeResult.ok).toBe(true);
    expect(removeResult.document).toMatchObject({ interactables: { lamp: { data: { initialState: { location: { kind: 'nowhere' } } } } } });
  });
});
