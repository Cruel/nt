import { describe, expect, it } from 'vitest';
import { executeCommand, createInitialCommandBusState, undoCommand, redoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

function projectWithRooms() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: {} };
  project.rooms.hall = {
    id: 'hall',
    label: 'Hall',
    parent: { collection: 'rooms', id: 'foyer' },
    tags: [],
    data: { door: { $ref: { collection: 'rooms', id: 'foyer' } } },
  };
  project.entrypoint = { collection: 'rooms', id: 'foyer' };
  return project;
}

describe('authoring entity operations', () => {
  it('creates authoring records with defaults and undo/redo support', () => {
    let state = createInitialCommandBusState(toJsonValue(createAuthoringProject()));
    const result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'rooms', entityId: 'foyer', label: 'Foyer' },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({ rooms: { foyer: { id: 'foyer', label: 'Foyer', tags: [], data: {} } } });

    state = result.state;
    const undone = undoCommand(state);
    expect(undone.state.document).toMatchObject({ rooms: {} });
    const redone = redoCommand(undone.state);
    expect(redone.state.document).toMatchObject({ rooms: { foyer: { id: 'foyer' } } });
  });

  it('rejects invalid and duplicate create IDs', () => {
    let state = createInitialCommandBusState(toJsonValue(createAuthoringProject()));
    let result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'rooms', entityId: 'Bad Id' },
    });
    expect(result.ok).toBe(false);
    expect(result.projectChanged).toBe(false);

    state = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'rooms', entityId: 'foyer' },
    }).state;
    result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'rooms', entityId: 'foyer' },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toContain('already exists');
  });

  it('renames IDs and rewrites supported references transactionally', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    const result = executeCommand(state, {
      type: 'entity.renameId',
      payload: { collection: 'rooms', fromId: 'foyer', toId: 'entry-hall' },
    });
    expect(result.ok).toBe(true);
    const document = result.state.document as ReturnType<typeof projectWithRooms>;
    expect(document.rooms.foyer).toBeUndefined();
    expect(document.rooms['entry-hall']).toMatchObject({ id: 'entry-hall', label: 'Foyer' });
    expect(document.entrypoint).toEqual({ collection: 'rooms', id: 'entry-hall' });
    expect(document.rooms.hall.parent).toEqual({ collection: 'rooms', id: 'entry-hall' });
    expect(document.rooms.hall.data).toEqual({ door: { $ref: { collection: 'rooms', id: 'entry-hall' } } });

    const undone = undoCommand(result.state);
    expect(undone.state.document).toEqual(state.document);
  });

  it('duplicates records without rewriting external references', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    const result = executeCommand(state, {
      type: 'entity.duplicateRecord',
      payload: { collection: 'rooms', sourceId: 'hall', targetId: 'hall-copy', label: 'Hall Copy' },
    });
    expect(result.ok).toBe(true);
    const document = result.state.document as ReturnType<typeof projectWithRooms> & { rooms: Record<string, unknown> };
    expect(document.rooms['hall-copy']).toMatchObject({ id: 'hall-copy', label: 'Hall Copy' });
    expect(document.entrypoint).toEqual({ collection: 'rooms', id: 'foyer' });
  });

  it('blocks referenced deletes unless force is supplied', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    const blocked = executeCommand(state, {
      type: 'entity.deleteRecord',
      payload: { collection: 'rooms', entityId: 'foyer' },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.diagnostics[0]?.message).toContain('referenced');

    const forced = executeCommand(state, {
      type: 'entity.deleteRecord',
      payload: { collection: 'rooms', entityId: 'foyer', force: true },
    });
    expect(forced.ok).toBe(true);
    state = forced.state;
    expect((state.document as ReturnType<typeof projectWithRooms>).rooms.foyer).toBeUndefined();
  });

  it('updates metadata and parent assignment safely', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    const metadata = executeCommand(state, {
      type: 'entity.updateMetadata',
      payload: { collection: 'rooms', entityId: 'hall', label: 'Great Hall', tags: ['main'], color: '#fff' },
    });
    expect(metadata.ok).toBe(true);
    state = metadata.state;
    expect((state.document as ReturnType<typeof projectWithRooms>).rooms.hall).toMatchObject({
      label: 'Great Hall',
      tags: ['main'],
      color: '#fff',
    });

    const clearParent = executeCommand(state, {
      type: 'entity.setParent',
      payload: { collection: 'rooms', entityId: 'hall', parentId: null },
    });
    expect(clearParent.ok).toBe(true);
    expect((clearParent.state.document as ReturnType<typeof projectWithRooms>).rooms.hall.parent).toBeNull();
  });

  it('rejects parent cycles', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    const result = executeCommand(state, {
      type: 'entity.setParent',
      payload: { collection: 'rooms', entityId: 'foyer', parentId: 'hall' },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toContain('cycle');
  });
});
