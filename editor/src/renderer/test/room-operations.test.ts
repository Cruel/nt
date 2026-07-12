import { describe, expect, it } from 'vitest';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
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
      rooms: { foyer: { data: { kind: 'room', displayName: 'Foyer', paths: [], hotspots: [] } } },
    });
  });

  it('patches valid room data and rejects error diagnostics', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    let state = createInitialCommandBusState(toJsonValue(project));

    const invalidData = defaultRoomData('Foyer');
    invalidData.paths = [{ id: 'north', label: 'North', direction: 'north', target: roomRoomRef('missing'), enabled: true, condition: '', order: 0 }];
    const invalid = executeCommand(state, {
      type: 'room.replaceData',
      payload: { roomId: 'foyer', data: invalidData },
    });
    expect(invalid.ok).toBe(false);

    const next = defaultRoomData('Foyer');
    next.description.source = 'Welcome to the foyer.';
    const valid = executeCommand(state, {
      type: 'room.replaceData',
      label: 'Set room description',
      payload: { roomId: 'foyer', data: next },
    });
    expect(valid.ok).toBe(true);
    expect(valid.document).toMatchObject({ rooms: { foyer: { data: { description: { source: 'Welcome to the foyer.' } } } } });

    state = valid.state;
    expect(undoCommand(state).document).toMatchObject({ rooms: { foyer: { data: { description: { source: '' } } } } });
  });
});
