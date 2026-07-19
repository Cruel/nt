import { describe, expect, it } from 'vite-plus/test';
import {
  executeCommand,
  createInitialCommandBusState,
  undoCommand,
  redoCommand,
} from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

function projectWithRooms() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  project.rooms.hall = {
    id: 'hall',
    label: 'Hall',
    extends: 'foyer',
    data: defaultRoomData('Hall'),
  };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  return project;
}

describe('authoring entity operations', () => {
  it('creates strict records with defaults and undo/redo support', () => {
    const initial = createInitialCommandBusState(toJsonValue(createAuthoringProject()));
    const result = executeCommand(initial, {
      type: 'entity.createRecord',
      payload: { collection: 'rooms', entityId: 'foyer', label: 'Foyer' },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      rooms: { foyer: { id: 'foyer', data: { kind: 'room' } } },
    });
    expect(undoCommand(result.state).state.document).toMatchObject({ rooms: {} });
    expect(redoCommand(undoCommand(result.state).state).state.document).toMatchObject({
      rooms: { foyer: { id: 'foyer' } },
    });
  });

  it('renames IDs and rewrites entrypoint and extends references transactionally', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    const result = executeCommand(state, {
      type: 'entity.renameId',
      payload: { collection: 'rooms', fromId: 'foyer', toId: 'entry-hall' },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      entrypoint: { kind: 'room', id: 'entry-hall' },
      rooms: { 'entry-hall': { id: 'entry-hall' }, hall: { extends: 'entry-hall' } },
    });
    expect(undoCommand(result.state).state.document).toEqual(state.document);
  });

  it('blocks referenced deletes unless forced', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    expect(
      executeCommand(state, {
        type: 'entity.deleteRecord',
        payload: { collection: 'rooms', entityId: 'foyer' },
      }).ok,
    ).toBe(false);
    expect(
      executeCommand(state, {
        type: 'entity.deleteRecord',
        payload: { collection: 'rooms', entityId: 'foyer', force: true },
      }).ok,
    ).toBe(true);
  });

  it('stores tags and color only in editor metadata', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    const result = executeCommand(state, {
      type: 'entity.updateMetadata',
      payload: {
        collection: 'rooms',
        entityId: 'hall',
        label: 'Great Hall',
        tags: [' main ', 'MAIN', 'Hero'],
        color: '#fff',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      rooms: { hall: { label: 'Great Hall' } },
      editor: { recordMetadata: { rooms: { hall: { tags: ['main', 'Hero'], color: '#fff' } } } },
    });
    expect((result.state.document as { rooms: { hall: unknown } }).rooms.hall).not.toHaveProperty(
      'tags',
    );
  });

  it('moves, copies, clears, and deletes editor metadata with its record', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    state = executeCommand(state, {
      type: 'entity.updateMetadata',
      payload: {
        collection: 'rooms',
        entityId: 'hall',
        tags: ['main'],
        color: '#fff',
        sortKey: '10',
      },
    }).state;

    const renamed = executeCommand(state, {
      type: 'entity.renameId',
      payload: { collection: 'rooms', fromId: 'hall', toId: 'great-hall' },
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.state.document).toMatchObject({
      editor: {
        recordMetadata: {
          rooms: { 'great-hall': { tags: ['main'], color: '#fff', sortKey: '10' } },
        },
      },
    });
    expect(
      (renamed.state.document as { editor: { recordMetadata: { rooms: Record<string, unknown> } } })
        .editor.recordMetadata.rooms,
    ).not.toHaveProperty('hall');

    const duplicated = executeCommand(renamed.state, {
      type: 'entity.duplicateRecord',
      payload: { collection: 'rooms', sourceId: 'great-hall', targetId: 'great-hall-copy' },
    });
    expect(duplicated.ok).toBe(true);
    expect(duplicated.state.document).toMatchObject({
      editor: {
        recordMetadata: {
          rooms: { 'great-hall-copy': { tags: ['main'], color: '#fff', sortKey: '10' } },
        },
      },
    });

    const cleared = executeCommand(duplicated.state, {
      type: 'entity.updateMetadata',
      payload: { collection: 'rooms', entityId: 'great-hall-copy', color: null, sortKey: null },
    });
    expect(cleared.state.document).toMatchObject({
      editor: { recordMetadata: { rooms: { 'great-hall-copy': { color: null, sortKey: null } } } },
    });

    const deleted = executeCommand(cleared.state, {
      type: 'entity.deleteRecord',
      payload: { collection: 'rooms', entityId: 'great-hall-copy' },
    });
    expect(deleted.ok).toBe(true);
    expect(
      (deleted.state.document as { editor: { recordMetadata: { rooms: Record<string, unknown> } } })
        .editor.recordMetadata.rooms,
    ).not.toHaveProperty('great-hall-copy');
  });

  it('sets same-collection extends and rejects cycles', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    const clear = executeCommand(state, {
      type: 'entity.setExtends',
      payload: { collection: 'rooms', entityId: 'hall', extendsId: null },
    });
    expect(clear.ok).toBe(true);
    state = clear.state;
    const first = executeCommand(state, {
      type: 'entity.setExtends',
      payload: { collection: 'rooms', entityId: 'foyer', extendsId: 'hall' },
    });
    expect(first.ok).toBe(true);
    expect(
      executeCommand(first.state, {
        type: 'entity.setExtends',
        payload: { collection: 'rooms', entityId: 'hall', extendsId: 'foyer' },
      }).ok,
    ).toBe(false);
  });
});
