import { describe, expect, it } from 'vite-plus/test';
import {
  executeCommand,
  createInitialCommandBusState,
  undoCommand,
  redoCommand,
} from './command-test-utils';
import { executeCommand as executeCommandCore } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import {
  authoringProjectSchema,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';
import {
  structuredMessageForPath,
  structuredMessageId,
} from '../../shared/authoring-structured-messages';
import { testTranslation } from './fixtures/localization-workflow';
import { buildAuthoringDependencyGraph } from '../../shared/authoring-dependency-graph';

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

function projectWithCursorReferences() {
  const project = createAuthoringProject();
  project.settings.cursors.named = [
    {
      id: 'inspect',
      image: { $ref: { collection: 'assets', id: 'cursor-image' } },
      hotspotX: 0,
      hotspotY: 0,
    },
  ];
  project.settings.cursors.defaults.pointer = { kind: 'named', id: 'inspect' };

  const room = defaultRoomData('Foyer');
  room.hotspots = [
    {
      id: 'door',
      label: 'Door',
      condition: { kind: 'always' },
      inputOrder: 0,
      highlight: { kind: 'default' },
      cursor: { kind: 'named', id: 'inspect' },
      shape: { kind: 'rect', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      target: { kind: 'exit', exitId: 'east' },
    },
  ];
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };

  const interactable = defaultInteractableData('Key');
  interactable.presentation.cursor = { kind: 'named', id: 'inspect' };
  interactable.presentation.hotspots = {
    kind: 'custom',
    hotspots: [
      {
        ...defaultHotspotBehavior('Inspect key'),
        cursor: { kind: 'named', id: 'inspect' },
        shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
      },
    ],
  };
  project.interactables.key = { id: 'key', label: 'Key', data: interactable };

  const layout = defaultLayoutData('HUD');
  layout.rcss.sourceText = '#target { cursor: inspect; }';
  project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
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

  it('renames named cursors across structured and inline RCSS references with undo support', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithCursorReferences()));
    const result = executeCommand(state, {
      type: 'project.renameNamedCursor',
      payload: { fromId: 'inspect', toId: 'examine' },
    });

    expect(result.ok).toBe(true);
    const renamed = authoringProjectSchema.parse(result.state.document);
    expect(renamed.settings.cursors.named[0]?.id).toBe('examine');
    expect(renamed.settings.cursors.defaults.pointer).toEqual({ kind: 'named', id: 'examine' });
    expect(renamed.rooms.foyer?.data.hotspots[0]?.cursor).toEqual({ kind: 'named', id: 'examine' });
    expect(renamed.interactables.key?.data.presentation.cursor).toEqual({
      kind: 'named',
      id: 'examine',
    });
    expect(renamed.interactables.key?.data.presentation.hotspots).toMatchObject({
      kind: 'custom',
      hotspots: [expect.objectContaining({ cursor: { kind: 'named', id: 'examine' } })],
    });
    expect(renamed.layouts.hud?.data.rcss.sourceText).toBe('#target { cursor: examine; }');
    expect(undoCommand(result.state).state.document).toEqual(state.document);
  });

  it('rewrites literal Lua cursor names and reports computed cursor-name risk', async () => {
    const project = projectWithCursorReferences();
    project.layouts.hud!.data.lua.sourceText = [
      'noveltea.presentation.cursor.set("inspect")',
      'noveltea.presentation.cursor.set(cursor_name)',
    ].join('\n');
    const initial = createInitialCommandBusState(toJsonValue(project));
    const graph = await buildAuthoringDependencyGraph(project, {
      mode: 'enabled',
      sources: { entriesByAssetId: new Map() },
    });
    const projectRevision = initial.projectRevision ?? 1;
    const state = {
      ...initial,
      projectRevision,
      graphSnapshot: {
        projectInstanceId: initial.projectInstanceId!,
        projectRevision,
        graphRevision: projectRevision,
        graph,
      },
    };

    const result = executeCommandCore(state, {
      type: 'project.renameNamedCursor',
      payload: { fromId: 'inspect', toId: 'examine' },
      originSaveUnitId: 'test:save-unit',
      persistencePolicy: 'manual-save',
    });

    expect(result.ok).toBe(true);
    const renamed = authoringProjectSchema.parse(result.state.document);
    expect(renamed.layouts.hud?.data.lua.sourceText).toBe(
      [
        'noveltea.presentation.cursor.set("examine")',
        'noveltea.presentation.cursor.set(cursor_name)',
      ].join('\n'),
    );
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === 'warning' &&
          diagnostic.message.includes('computed Lua cursor-name usage'),
      ),
    ).toBe(true);
    expect(undoCommand(result.state).state.document).toEqual(state.document);
  });

  it('keeps force-deleted literal Lua cursor usages diagnosable', async () => {
    const project = projectWithCursorReferences();
    project.layouts.hud!.data.lua.sourceText = 'noveltea . presentation . cursor . set("inspect")';
    const initial = createInitialCommandBusState(toJsonValue(project));
    const graph = await buildAuthoringDependencyGraph(project, {
      mode: 'enabled',
      sources: { entriesByAssetId: new Map() },
    });
    const projectRevision = initial.projectRevision ?? 1;
    const state = {
      ...initial,
      projectRevision,
      graphSnapshot: {
        projectInstanceId: initial.projectInstanceId!,
        projectRevision,
        graphRevision: projectRevision,
        graph,
      },
    };
    const forced = executeCommandCore(state, {
      type: 'project.deleteNamedCursor',
      payload: { cursorId: 'inspect', force: true },
      originSaveUnitId: 'test:save-unit',
      persistencePolicy: 'manual-save',
    });
    expect(forced.ok).toBe(true);

    const deleted = authoringProjectSchema.parse(forced.state.document);
    const rebuilt = await buildAuthoringDependencyGraph(deleted, {
      mode: 'enabled',
      sources: { entriesByAssetId: new Map() },
    });
    expect(rebuilt.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'authoring.cursor.lua_named_missing',
          path: '/layouts/hud/data/lua/sourceText',
          message: expect.stringContaining("unknown cursor 'inspect'"),
        }),
      ]),
    );
  });

  it('blocks referenced named-cursor deletion, while force delete leaves references untouched', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithCursorReferences()));
    const blocked = executeCommand(state, {
      type: 'project.deleteNamedCursor',
      payload: { cursorId: 'inspect' },
    });
    expect(blocked.ok).toBe(false);

    const forced = executeCommand(state, {
      type: 'project.deleteNamedCursor',
      payload: { cursorId: 'inspect', force: true },
    });
    expect(forced.ok).toBe(true);
    const project = authoringProjectSchema.parse(forced.state.document);
    expect(project.settings.cursors.named).toEqual([]);
    expect(project.settings.cursors.defaults.pointer).toEqual({ kind: 'named', id: 'inspect' });
    expect(project.rooms.foyer?.data.hotspots[0]?.cursor).toEqual({ kind: 'named', id: 'inspect' });
    expect(project.layouts.hud?.data.rcss.sourceText).toBe('#target { cursor: inspect; }');
    expect(forced.diagnostics.some((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
    expect(undoCommand(forced.state).state.document).toEqual(state.document);
  });

  it('rejects reserved named-cursor rename targets', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithCursorReferences()));
    for (const toId of ['pointer', 'rmlui-scroll']) {
      const result = executeCommand(state, {
        type: 'project.renameNamedCursor',
        payload: { fromId: 'inspect', toId },
      });
      expect(result.ok).toBe(false);
    }
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
