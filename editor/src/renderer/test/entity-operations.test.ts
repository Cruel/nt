import { describe, expect, it } from 'vite-plus/test';
import {
  executeCommand,
  createInitialCommandBusState,
  undoCommand,
  redoCommand,
} from './command-test-utils';
import { toJsonValue } from '@/project/json-value';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import {
  authoringProjectSchema,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  structuredMessageForPath,
  structuredMessageId,
} from '../../shared/authoring-structured-messages';
import { testTranslation } from './fixtures/localization-workflow';

function projectWithRooms() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  project.rooms.hall = {
    id: 'hall',
    label: 'Hall',
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

  it('renames IDs and rewrites entrypoint references transactionally', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithRooms()));
    const result = executeCommand(state, {
      type: 'entity.renameId',
      payload: { collection: 'rooms', fromId: 'foyer', toId: 'entry-hall' },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      entrypoint: { kind: 'room', id: 'entry-hall' },
      rooms: { 'entry-hall': { id: 'entry-hall' }, hall: { id: 'hall' } },
    });
    expect(undoCommand(result.state).state.document).toEqual(state.document);
  });

  it('preserves structured Message translations across a known record ID rename', () => {
    const project = projectWithRooms();
    project.rooms.foyer!.data.description = inlineTextContent('A quiet foyer.');
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    const oldMessageId = structuredMessageId('/rooms/foyer/data/description');
    project.localization.translations.fr = {
      [oldMessageId]: testTranslation('Un foyer tranquille.'),
    };
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'entity.renameId',
      payload: { collection: 'rooms', fromId: 'foyer', toId: 'entry-hall' },
    });

    expect(result.ok).toBe(true);
    const renamedProject = authoringProjectSchema.parse(result.state.document);
    const translations = renamedProject.localization.translations.fr!;
    expect(translations[oldMessageId]?.text).toBe('Un foyer tranquille.');
    expect(structuredMessageForPath(renamedProject, '/rooms/entry-hall/data/description')?.id).toBe(
      oldMessageId,
    );
    expect(
      renamedProject.localization.structuredMessageIds['/rooms/entry-hall/data/description'],
    ).toBe(oldMessageId);
    expect(undoCommand(result.state).state.document).toEqual(state.document);
  });

  it('duplicates local Message ownership independently while preserving named references', () => {
    const project = projectWithRooms();
    project.localization.messages['11111111-1111-4111-8111-111111111111'] = {
      kind: 'named',
      key: 'ui.shared.room-title',
      source: 'Shared title',
    };
    project.rooms.foyer!.data.displayName = 'Local room name';
    project.rooms.foyer!.data.description = {
      markup: 'plain',
      source: { kind: 'localized', key: 'ui.shared.room-title' },
    };
    const sourceLocalId = structuredMessageForPath(project, '/rooms/foyer/data/displayName')!.id;
    const state = createInitialCommandBusState(toJsonValue(project));

    const result = executeCommand(state, {
      type: 'entity.duplicateRecord',
      payload: { collection: 'rooms', sourceId: 'foyer', targetId: 'foyer-copy' },
    });

    expect(result.ok).toBe(true);
    const duplicated = authoringProjectSchema.parse(result.state.document);
    const copiedLocalId = structuredMessageForPath(
      duplicated,
      '/rooms/foyer-copy/data/displayName',
    )!.id;
    expect(copiedLocalId).not.toBe(sourceLocalId);
    expect(duplicated.rooms['foyer-copy']!.data.description.source).toEqual({
      kind: 'localized',
      key: 'ui.shared.room-title',
    });
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
});
