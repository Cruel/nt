import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  buildAutoCommitPlan,
  remapRecoveryForAutoCommit,
  STRUCTURAL_AUTO_COMMIT_RULES,
  structuralRuleForTests,
} from '@/project/structural-command-persistence';
import { flushStructuralCommandPersistence, useCommandStore } from '@/commands/command-store';
import { saveActiveSaveUnit } from '@/project/project-save-coordinator';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { getTabDirtyState } from '@/workbench/dirty-state';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import {
  buildEditorProjectStateSnapshot,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData, roomRoomRef } from '../../shared/project-schema/authoring-rooms';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { toJsonValue } from '@/project/json-value';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import {
  authoringDependencyGraphService,
  startAuthoringDependencyGraphService,
} from '@/project/authoring-dependency-graph-runtime';

let stopGraphService: (() => void) | null = null;

type LoadProjectDocumentInput = Parameters<
  ReturnType<typeof useProjectStore.getState>['loadProjectDocument']
>[0];

async function loadProjectDocumentWithGraph(input: LoadProjectDocumentInput) {
  useProjectStore.getState().loadProjectDocument({
    ...input,
    projectSessionId: input.projectSessionId ?? 'test-project-session',
  });
  await publishCurrentGraph();
}

async function publishCurrentGraph() {
  const publication = useProjectStore.getState().lastMutationPublication;
  if (!publication) throw new Error('Project mutation did not publish graph input.');
  await authoringDependencyGraphService.publish(publication);
}

function projectWithRoom() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  return project;
}

function projectWithTwoRooms() {
  const project = projectWithRoom();
  project.rooms.kitchen = {
    id: 'kitchen',
    label: 'Kitchen',
    data: defaultRoomData('Kitchen'),
  };
  return project;
}

function importedImage(): ImportedAssetMetadata {
  return {
    originalPath: '/tmp/logo.png',
    originalName: 'logo.png',
    projectRelativePath: 'assets/images/logo.png',
    kind: 'image',
    extension: '.png',
    mimeType: 'image/png',
    byteSize: 4,
    contentHash: `sha256:${'0'.repeat(64)}`,
    importedAt: '2026-07-19T00:00:00.000Z',
    imageMetadata: { width: 256, height: 256, hasAlpha: true, orientation: 1 },
  };
}

beforeEach(() => {
  stopGraphService?.();
  vi.clearAllMocks();
  useProjectStore.getState().clearProject();
  useWorkbenchStore.getState().resetWorkbench();
  useDraftDirtyStore.getState().resetDraftDirty();
  useCommandStore.getState().resetCommandHistory();
  setLoadedEditorProjectState(emptyEditorProjectState());
  stopGraphService = startAuthoringDependencyGraphService();
});

afterEach(() => {
  stopGraphService?.();
  stopGraphService = null;
});

describe('structural command persistence', () => {
  it('requires every auto-commit mutation to match an explicit registry rule', () => {
    expect(structuralRuleForTests('entity.renameId', 'structure:rooms')).toMatchObject({
      unsafeRebasePolicy: 'reject-command',
      identityRemap: 'entity-rename',
    });
    expect(structuralRuleForTests('unknown.mutation', 'structure:rooms')).toBeNull();
    expect(
      buildAutoCommitPlan({
        commandType: 'unknown.mutation',
        originSaveUnitId: 'structure:rooms',
        savedDocument: toJsonValue(projectWithRoom()),
        workingDocument: toJsonValue(projectWithRoom()),
        patches: [],
        affectedPaths: ['/rooms'],
        payload: null,
      }).status,
    ).toBe('rejected');
    expect(STRUCTURAL_AUTO_COMMIT_RULES.map((rule) => rule.commandType).sort()).toEqual(
      [
        'asset.deleteAsset',
        'asset.importFiles',
        'entity.createRecord',
        'entity.deleteRecord',
        'entity.duplicateRecord',
        'entity.renameId',
        'project.applyPatch',
        'project.setExplorerOptions',
        'project.setHiddenCollections',
        'transaction',
      ].sort(),
    );
  });

  it('builds baseline, working, inverse, identity-remap, and policy fields', () => {
    const project = projectWithRoom();
    const result = buildAutoCommitPlan({
      commandType: 'entity.renameId',
      originSaveUnitId: 'structure:rooms',
      savedDocument: toJsonValue(project),
      workingDocument: toJsonValue(project),
      patches: [
        { op: 'add', path: '/rooms/hall', value: project.rooms.foyer as never },
        { op: 'remove', path: '/rooms/foyer' },
      ],
      affectedPaths: ['/rooms/foyer', '/rooms/hall'],
      payload: { collection: 'rooms', fromId: 'foyer', toId: 'hall' },
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan).toMatchObject({
      persistenceTarget: 'project-content',
      unsafeRebasePolicy: 'reject-command',
      affectedPaths: ['/rooms/foyer', '/rooms/hall'],
      identityRemap: [
        {
          fromPath: '/rooms/foyer',
          toPath: '/rooms/hall',
          fromSaveUnitId: 'record:rooms:foyer',
          toSaveUnitId: 'record:rooms:hall',
        },
      ],
    });
    expect(result.plan.baselinePatches).toHaveLength(2);
    expect(result.plan.workingDocumentPatches).toHaveLength(2);
    expect(result.plan.forwardBaselinePatches).toHaveLength(2);
    expect(result.plan.inverseBaselinePatches.length).toBeGreaterThan(0);
  });

  it('keeps tracked editor.json patches in the project-content baseline', () => {
    const project = projectWithRoom();
    project.editor.recordMetadata.rooms = {
      foyer: { tags: [], color: null },
    };
    const result = buildAutoCommitPlan({
      commandType: 'entity.deleteRecord',
      originSaveUnitId: 'structure:rooms',
      savedDocument: toJsonValue(project),
      workingDocument: toJsonValue(project),
      patches: [
        { op: 'remove', path: '/rooms/foyer' },
        { op: 'remove', path: '/editor/recordMetadata/rooms/foyer' },
      ],
      affectedPaths: ['/rooms/foyer', '/editor/recordMetadata/rooms/foyer'],
      payload: { collection: 'rooms', entityId: 'foyer' },
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.workingDocumentPatches).toHaveLength(2);
    expect(result.plan.forwardBaselinePatches).toEqual([
      { op: 'remove', path: '/rooms/foyer' },
      { op: 'remove', path: '/editor/recordMetadata/rooms/foyer' },
    ]);
  });

  it('remaps dirty recovery across a structural rename', () => {
    const remapped = remapRecoveryForAutoCommit(
      {
        sequence: 1,
        saveUnitsById: {
          'record:rooms:foyer': {
            sequence: 1,
            patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Dirty' }],
            affectedPaths: ['/rooms/foyer'],
            pendingRawInputByPath: {
              '/rooms/foyer/data/zoom': { value: 'invalid' },
            },
            atomicTransactionGroupIds: [],
          },
        },
      },
      [
        {
          fromPath: '/rooms/foyer',
          toPath: '/rooms/hall',
          fromSaveUnitId: 'record:rooms:foyer',
          toSaveUnitId: 'record:rooms:hall',
        },
      ],
    );
    expect(remapped.saveUnitsById).not.toHaveProperty('record:rooms:foyer');
    expect(remapped.saveUnitsById['record:rooms:hall']).toMatchObject({
      affectedPaths: ['/rooms/hall'],
      patches: [{ path: '/rooms/hall/label' }],
      pendingRawInputByPath: {
        '/rooms/hall/data/zoom': { value: 'invalid' },
      },
    });
  });

  it('does not let an editor tab opened by a structural create manufacture an overlapping dirty recovery unit', async () => {
    const project = createAuthoringProject();
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      savedDocument: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    const executed = useCommandStore.getState().executeCommand({
      type: 'entity.createRecord',
      label: 'Create hall',
      payload: { collection: 'rooms', entityId: 'hall', label: 'Hall' },
      originSaveUnitId: 'workflow:new-entity',
      persistencePolicy: 'auto-commit',
    });
    expect(executed.ok).toBe(true);
    useWorkbenchStore.getState().openTab({
      id: 'tab:rooms:hall',
      title: 'Hall',
      editorType: 'room-detail',
      resource: {
        kind: 'record',
        stableId: 'record:rooms:hall',
        collection: 'rooms',
        entityId: 'hall',
      },
    });

    await flushStructuralCommandPersistence();

    expect(window.noveltea.saveProjectContent).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { hall: { id: 'hall', label: 'Hall' } },
    });
  });

  it('can delete a Room immediately after its structural create finishes persisting', async () => {
    const project = createAuthoringProject();
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      savedDocument: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    const created = useCommandStore.getState().executeCommand({
      type: 'entity.createRecord',
      label: 'Create hall',
      payload: { collection: 'rooms', entityId: 'hall', label: 'Hall' },
      originSaveUnitId: 'workflow:new-entity',
      persistencePolicy: 'auto-commit',
    });
    expect(created.ok).toBe(true);
    await flushStructuralCommandPersistence();

    const deleted = useCommandStore.getState().executeCommand({
      type: 'entity.deleteRecord',
      label: 'Delete hall',
      payload: { collection: 'rooms', entityId: 'hall', force: true },
      originSaveUnitId: 'structure:rooms',
      persistencePolicy: 'auto-commit',
    });

    expect(deleted.ok).toBe(true);
    await flushStructuralCommandPersistence();
    expect(useProjectStore.getState().document).toMatchObject({ rooms: {} });
    expect(useProjectStore.getState().savedDocument).toMatchObject({ rooms: {} });
  });

  it('can recreate a structurally deleted Room without leaving a phantom dirty save unit', async () => {
    const project = projectWithRoom();
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      savedDocument: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    const deleted = useCommandStore.getState().executeCommand({
      type: 'entity.deleteRecord',
      label: 'Delete foyer',
      payload: { collection: 'rooms', entityId: 'foyer', force: true },
      originSaveUnitId: 'structure:rooms',
      persistencePolicy: 'auto-commit',
    });
    expect(deleted.ok).toBe(true);
    await flushStructuralCommandPersistence();

    const recreated = useCommandStore.getState().executeCommand({
      type: 'entity.createRecord',
      label: 'Recreate foyer',
      payload: { collection: 'rooms', entityId: 'foyer', label: 'Foyer' },
      originSaveUnitId: 'workflow:new-entity',
      persistencePolicy: 'auto-commit',
    });
    expect(recreated.ok).toBe(true);
    await flushStructuralCommandPersistence();

    const tab = {
      id: 'tab:rooms:foyer',
      title: 'Foyer',
      editorType: 'room-detail',
      resource: {
        kind: 'record' as const,
        stableId: 'record:rooms:foyer',
        collection: 'rooms',
        entityId: 'foyer',
      },
    };
    useWorkbenchStore.getState().openTab(tab);
    const state = useProjectStore.getState();
    expect(state.document).toMatchObject({ rooms: { foyer: { id: 'foyer', label: 'Foyer' } } });
    expect(state.savedDocument).toMatchObject({
      rooms: { foyer: { id: 'foyer', label: 'Foyer' } },
    });
    expect(getTabDirtyState(tab, state.document, state.savedDocument, {}).dirty).toBe(false);
    expect((await saveActiveSaveUnit('record:rooms:foyer')).status).toBe('nothing-to-save');

    const editedData = defaultRoomData('Edited Foyer');
    expect(
      useCommandStore.getState().executeCommand({
        type: 'room.replaceData',
        label: 'Edit recreated foyer',
        payload: { roomId: 'foyer', data: editedData },
        originSaveUnitId: 'record:rooms:foyer',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    const saved = await saveActiveSaveUnit('record:rooms:foyer');
    expect(saved.success).toBe(true);
    expect(saved.status).toBe('saved');
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { foyer: { data: { displayName: 'Edited Foyer' } } },
    });
  });

  it('saves reciprocal exits between two newly created Rooms without inventing an external conflict', async () => {
    const project = createAuthoringProject();
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      savedDocument: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    for (const [entityId, label] of [
      ['foyer', 'Foyer'],
      ['hall', 'Hall'],
    ] as const) {
      const created = useCommandStore.getState().executeCommand({
        type: 'entity.createRecord',
        label: `Create ${label}`,
        payload: { collection: 'rooms', entityId, label },
        originSaveUnitId: 'workflow:new-entity',
        persistencePolicy: 'auto-commit',
      });
      expect(created.ok).toBe(true);
      await flushStructuralCommandPersistence();
    }

    const foyerData = defaultRoomData('Foyer');
    foyerData.exits = [
      {
        id: 'to-hall',
        label: 'To Hall',
        direction: 'east',
        target: roomRoomRef('hall'),
        condition: { kind: 'always' },
        transition: null,
      },
    ];
    const hallData = defaultRoomData('Hall');
    hallData.exits = [
      {
        id: 'to-foyer',
        label: 'To Foyer',
        direction: 'west',
        target: roomRoomRef('foyer'),
        condition: { kind: 'always' },
        transition: null,
      },
    ];
    expect(
      useCommandStore.getState().executeCommand({
        type: 'room.replaceData',
        label: 'Add foyer exit',
        payload: { roomId: 'foyer', data: foyerData },
        originSaveUnitId: 'record:rooms:foyer',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    expect(
      useCommandStore.getState().executeCommand({
        type: 'room.replaceData',
        label: 'Add reciprocal hall exit',
        payload: { roomId: 'hall', data: hallData },
        originSaveUnitId: 'record:rooms:hall',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);

    const result = await saveActiveSaveUnit('record:rooms:foyer');

    expect(result.success).toBe(true);
    expect(result.status).toBe('partially-saved');
    const recovery = buildEditorProjectStateSnapshot().recovery;
    expect(recovery.saveUnitsById['record:rooms:foyer']).toBeUndefined();
    expect(recovery.saveUnitsById['record:rooms:hall']?.externalConflict).toBeUndefined();
    expect(recovery.saveUnitsById['record:rooms:hall']?.affectedPaths).toContain(
      '/rooms/hall/data',
    );
  });

  it('force deletes a newly created Room even when its own unsaved exit still references another Room', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      savedDocument: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    expect(
      useCommandStore.getState().executeCommand({
        type: 'entity.createRecord',
        label: 'Create hall',
        payload: { collection: 'rooms', entityId: 'hall', label: 'Hall' },
        originSaveUnitId: 'workflow:new-entity',
        persistencePolicy: 'auto-commit',
      }).ok,
    ).toBe(true);
    await flushStructuralCommandPersistence();

    const hall = defaultRoomData('Hall');
    hall.exits = [
      {
        id: 'to-foyer',
        label: 'Foyer',
        direction: 'south',
        target: roomRoomRef('foyer'),
        condition: { kind: 'always' },
        transition: null,
      },
    ];
    expect(
      useCommandStore.getState().executeCommand({
        type: 'room.replaceData',
        label: 'Link Hall to Foyer',
        payload: { roomId: 'hall', data: hall },
        originSaveUnitId: 'record:rooms:hall',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    const foyer = defaultRoomData('Foyer');
    foyer.exits = [
      {
        id: 'to-hall',
        label: 'Hall',
        direction: 'north',
        target: roomRoomRef('hall'),
        condition: { kind: 'always' },
        transition: null,
      },
    ];
    expect(
      useCommandStore.getState().executeCommand({
        type: 'room.replaceData',
        label: 'Link Foyer to Hall',
        payload: { roomId: 'foyer', data: foyer },
        originSaveUnitId: 'record:rooms:foyer',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    const savedFoyer = await saveActiveSaveUnit('record:rooms:foyer');
    expect(savedFoyer.success).toBe(true);
    expect(savedFoyer.savedSaveUnitIds).toContain('record:rooms:foyer');
    await publishCurrentGraph();

    expect(
      useCommandStore.getState().executeCommand({
        type: 'entity.deleteRecord',
        label: 'Force delete hall',
        payload: { collection: 'rooms', entityId: 'hall', force: true },
        originSaveUnitId: 'structure:rooms',
        persistencePolicy: 'auto-commit',
      }).ok,
    ).toBe(true);
    await flushStructuralCommandPersistence();

    expect(useProjectStore.getState().document).not.toHaveProperty('rooms.hall');
    expect(useProjectStore.getState().savedDocument).not.toHaveProperty('rooms.hall');
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: {
        foyer: {
          data: {
            exits: [expect.objectContaining({ target: roomRoomRef('hall') })],
          },
        },
      },
    });
  });

  it('deletes a newly created Room after reciprocal exits are removed without reopening', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      savedDocument: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    expect(
      useCommandStore.getState().executeCommand({
        type: 'entity.createRecord',
        label: 'Create hall',
        payload: { collection: 'rooms', entityId: 'hall', label: 'Hall' },
        originSaveUnitId: 'workflow:new-entity',
        persistencePolicy: 'auto-commit',
      }).ok,
    ).toBe(true);
    await flushStructuralCommandPersistence();

    const hallLinked = defaultRoomData('Hall');
    hallLinked.exits = [
      {
        id: 'to-foyer',
        label: 'Foyer',
        direction: 'south',
        target: roomRoomRef('foyer'),
        condition: { kind: 'always' },
        transition: null,
      },
    ];
    expect(
      useCommandStore.getState().executeCommand({
        type: 'room.replaceData',
        label: 'Link Hall to Foyer',
        payload: { roomId: 'hall', data: hallLinked },
        originSaveUnitId: 'record:rooms:hall',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    const foyerLinked = defaultRoomData('Foyer');
    foyerLinked.exits = [
      {
        id: 'to-hall',
        label: 'Hall',
        direction: 'north',
        target: roomRoomRef('hall'),
        condition: { kind: 'always' },
        transition: null,
      },
    ];
    expect(
      useCommandStore.getState().executeCommand({
        type: 'room.replaceData',
        label: 'Link Foyer to Hall',
        payload: { roomId: 'foyer', data: foyerLinked },
        originSaveUnitId: 'record:rooms:foyer',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);

    expect(
      useCommandStore.getState().executeCommand({
        type: 'room.replaceData',
        label: 'Remove Hall exit',
        payload: { roomId: 'hall', data: defaultRoomData('Hall') },
        originSaveUnitId: 'record:rooms:hall',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    expect(
      useCommandStore.getState().executeCommand({
        type: 'room.replaceData',
        label: 'Remove Foyer exit',
        payload: { roomId: 'foyer', data: defaultRoomData('Foyer') },
        originSaveUnitId: 'record:rooms:foyer',
        persistencePolicy: 'manual-save',
      }).ok,
    ).toBe(true);
    await publishCurrentGraph();

    expect(
      useCommandStore.getState().executeCommand({
        type: 'entity.deleteRecord',
        label: 'Delete hall',
        payload: { collection: 'rooms', entityId: 'hall', force: false },
        originSaveUnitId: 'structure:rooms',
        persistencePolicy: 'auto-commit',
      }).ok,
    ).toBe(true);
    await flushStructuralCommandPersistence();

    expect(useProjectStore.getState().document).not.toHaveProperty('rooms.hall');
    expect(useProjectStore.getState().savedDocument).not.toHaveProperty('rooms.hall');
  });

  it('persists a newly created Interactable before its sprite is configured', async () => {
    const project = createAuthoringProject();
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      savedDocument: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    const created = useCommandStore.getState().executeCommand({
      type: 'entity.createRecord',
      label: 'Create girl',
      payload: { collection: 'interactables', entityId: 'girl', label: 'Girl' },
      originSaveUnitId: 'workflow:new-entity',
      persistencePolicy: 'auto-commit',
    });
    expect(created.ok).toBe(true);

    const tab = {
      id: 'tab:interactable-detail:interactables:girl',
      title: 'Girl',
      editorType: 'interactable-detail',
      resource: {
        kind: 'record' as const,
        stableId: 'record:interactables:girl',
        collection: 'interactables',
        entityId: 'girl',
      },
    };
    useWorkbenchStore.getState().openTab(tab);
    const savedWhilePending = await saveActiveSaveUnit('record:interactables:girl');
    expect(savedWhilePending.status).toBe('nothing-to-save');

    await flushStructuralCommandPersistence();

    const projectState = useProjectStore.getState();
    expect(projectState.savedDocument).toMatchObject({
      interactables: { girl: { id: 'girl', label: 'Girl' } },
    });
    expect(getTabDirtyState(tab, projectState.document, projectState.savedDocument, {}).dirty).toBe(
      false,
    );
  });

  it('persists structural forward, Undo, and Redo to the saved baseline', async () => {
    const project = projectWithRoom();
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    const executed = useCommandStore.getState().executeCommand({
      type: 'entity.renameId',
      label: 'Rename foyer to hall',
      payload: { collection: 'rooms', fromId: 'foyer', toId: 'hall' },
      originSaveUnitId: 'structure:rooms',
      persistencePolicy: 'auto-commit',
    });
    expect(executed.ok).toBe(true);
    await flushStructuralCommandPersistence();
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { hall: { id: 'hall' } },
    });
    expect(useProjectStore.getState().savedDocument).not.toMatchObject({
      rooms: { foyer: expect.anything() },
    });

    const undone = useCommandStore.getState().undo();
    expect(undone.ok).toBe(true);
    await flushStructuralCommandPersistence();
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { foyer: { id: 'foyer' } },
    });

    const redone = useCommandStore.getState().redo();
    expect(redone.ok).toBe(true);
    await flushStructuralCommandPersistence();
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { hall: { id: 'hall' } },
    });
    expect(window.noveltea.saveProjectContent).toHaveBeenCalledTimes(3);
  });

  it('does not let an open asset-library tab block asset-import auto-commit', async () => {
    const project = createAuthoringProject();
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      savedDocument: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useWorkbenchStore.getState().openTab({
      id: 'tab:asset-library',
      title: 'Assets',
      editorType: 'asset-library',
      resource: { kind: 'tool', stableId: 'asset-library' },
    });

    const executed = useCommandStore.getState().executeCommand({
      type: 'asset.importFiles',
      label: 'Import logo',
      payload: { assets: [importedImage()], fileOrigin: 'copied-by-import' },
      originSaveUnitId: 'workflow:asset-import',
      persistencePolicy: 'auto-commit',
    });
    expect(executed.ok).toBe(true);

    await flushStructuralCommandPersistence();

    expect(window.noveltea.saveProjectContent).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      assets: { logo: { id: 'logo' } },
    });
  });

  it('does not delete pre-existing or generated files when imported asset content is undone', async () => {
    const project = createAuthoringProject();
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    const executed = useCommandStore.getState().executeCommand({
      type: 'asset.importFiles',
      label: 'Register generated cover',
      payload: { assets: [importedImage()], fileOrigin: 'generated-project-file' },
      originSaveUnitId: 'workflow:image-generation-assets',
      persistencePolicy: 'auto-commit',
    });
    expect(executed.historyEntry?.autoCommitPlan?.filesystemOperations).toEqual([
      {
        kind: 'preexisting-project-assets',
        projectRelativePaths: ['assets/images/logo.png'],
        reason: 'generated-project-file',
      },
    ]);
    await flushStructuralCommandPersistence();

    useCommandStore.getState().undo();
    await flushStructuralCommandPersistence();
    useCommandStore.getState().redo();
    await flushStructuralCommandPersistence();

    expect(window.noveltea.trashProjectAssetFiles).not.toHaveBeenCalled();
    expect(window.noveltea.restoreProjectAssetFiles).not.toHaveBeenCalled();
  });

  it('persists a structural command while preserving unrelated dirty recovery', async () => {
    const saved = projectWithTwoRooms();
    const working = projectWithTwoRooms();
    working.rooms.kitchen!.label = 'Dirty Kitchen';
    await loadProjectDocumentWithGraph({
      document: toJsonValue(saved),
      savedDocument: toJsonValue(saved),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    await publishCurrentGraph();
    const originalEditorRevision = `sha256:${'1'.repeat(64)}` as const;
    const advancedEditorRevision = `sha256:${'2'.repeat(64)}` as const;
    const localEditorState = {
      ...emptyEditorProjectState(),
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'record:rooms:kitchen': {
            sequence: 1,
            patches: [
              { op: 'replace' as const, path: '/rooms/kitchen/label', value: 'Dirty Kitchen' },
            ],
            affectedPaths: ['/rooms/kitchen'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
            baselineFileRevisions: { 'editor.json': originalEditorRevision },
          },
        },
      },
    };
    setLoadedEditorProjectState(localEditorState);
    vi.mocked(window.noveltea.saveProjectContent).mockImplementationOnce(
      async (_projectSessionId, _request, editorState) => ({
        ok: true,
        success: true,
        projectPath: '/mock/project',
        projectFilePath: '/mock/project/game.json',
        diagnostics: [],
        fileRevisions: { 'editor.json': advancedEditorRevision },
        editorState: {
          ...editorState,
          recovery: {
            ...editorState.recovery,
            saveUnitsById: {
              ...editorState.recovery.saveUnitsById,
              'record:rooms:kitchen': {
                ...editorState.recovery.saveUnitsById['record:rooms:kitchen']!,
                baselineFileRevisions: { 'editor.json': advancedEditorRevision },
              },
            },
          },
        },
      }),
    );

    const result = useCommandStore.getState().executeCommand({
      type: 'entity.renameId',
      label: 'Rename foyer to hall',
      payload: { collection: 'rooms', fromId: 'foyer', toId: 'hall' },
      originSaveUnitId: 'structure:rooms',
      persistencePolicy: 'auto-commit',
    });
    expect(result.ok).toBe(true);
    await flushStructuralCommandPersistence();

    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: {
        hall: { id: 'hall' },
        kitchen: { label: 'Kitchen' },
      },
    });
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: {
        hall: { id: 'hall' },
        kitchen: { label: 'Dirty Kitchen' },
      },
    });
    const persistedEditor = vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[2];
    expect(persistedEditor?.recovery.saveUnitsById).toHaveProperty('record:rooms:kitchen');
    expect(
      buildEditorProjectStateSnapshot().recovery.saveUnitsById['record:rooms:kitchen']
        ?.baselineFileRevisions?.['editor.json'],
    ).toBe(advancedEditorRevision);
  });

  it('converts a declared convert-to-manual command when no saved baseline exists', () => {
    const project = projectWithRoom();
    useProjectStore.getState().loadUnsavedProjectDocument(toJsonValue(project));

    const result = useCommandStore.getState().executeCommand({
      type: 'entity.duplicateRecord',
      label: 'Duplicate foyer',
      payload: {
        collection: 'rooms',
        sourceId: 'foyer',
        targetId: 'hall',
      },
      originSaveUnitId: 'structure:rooms',
      persistencePolicy: 'auto-commit',
    });

    expect(result.ok).toBe(true);
    expect(result.historyEntry).toMatchObject({ persistencePolicy: 'manual-save' });
    expect(result.historyEntry?.autoCommitPlan).toBeUndefined();
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    expect(useProjectStore.getState().document).toMatchObject({ rooms: { hall: { id: 'hall' } } });
  });

  it('consumes the deleted record own dirty recovery instead of rolling the deletion back', async () => {
    const saved = projectWithRoom();
    const working = projectWithRoom();
    working.rooms.foyer!.label = 'Dirty Foyer';
    await loadProjectDocumentWithGraph({
      document: toJsonValue(saved),
      savedDocument: toJsonValue(saved),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    await publishCurrentGraph();
    setLoadedEditorProjectState({
      ...emptyEditorProjectState(),
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'record:rooms:foyer': {
            sequence: 1,
            patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Dirty Foyer' }],
            affectedPaths: ['/rooms/foyer'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        },
      },
    });

    const result = useCommandStore.getState().executeCommand({
      type: 'entity.deleteRecord',
      label: 'Delete foyer',
      payload: { collection: 'rooms', entityId: 'foyer', force: true },
      originSaveUnitId: 'structure:rooms',
      persistencePolicy: 'auto-commit',
    });
    expect(result.ok).toBe(true);
    await flushStructuralCommandPersistence();

    expect(useProjectStore.getState().document).not.toHaveProperty('rooms.foyer');
    expect(useProjectStore.getState().savedDocument).not.toHaveProperty('rooms.foyer');
    expect(window.noveltea.saveProjectContent).toHaveBeenCalledTimes(1);
  });

  it('coordinates copied asset import files across persisted forward, Undo, and Redo', async () => {
    const project = createAuthoringProject();
    const asset = importedImage();
    const move = {
      projectRelativePath: asset.projectRelativePath,
      trashRelativePath: '.noveltea/trash/assets/undo/assets/images/logo.png',
    };
    vi.mocked(window.noveltea.trashProjectAssetFiles).mockResolvedValueOnce({
      ok: true,
      success: true,
      moved: [move],
      diagnostics: [],
    });
    vi.mocked(window.noveltea.restoreProjectAssetFiles).mockResolvedValueOnce({
      ok: true,
      success: true,
      restored: [move],
      diagnostics: [],
    });
    vi.mocked(window.noveltea.saveProjectContent)
      .mockResolvedValueOnce({ ok: true, success: true, diagnostics: [] })
      .mockResolvedValueOnce({
        ok: true,
        success: true,
        diagnostics: [],
        assetTrashMoves: [move],
      })
      .mockResolvedValueOnce({ ok: true, success: true, diagnostics: [] });
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    const result = useCommandStore.getState().executeCommand({
      type: 'asset.importFiles',
      label: 'Import logo',
      payload: { assets: [asset], fileOrigin: 'copied-by-import' },
      originSaveUnitId: 'workflow:asset-import',
      persistencePolicy: 'auto-commit',
    });
    expect(result.ok).toBe(true);
    await flushStructuralCommandPersistence();
    expect(window.noveltea.trashProjectAssetFiles).not.toHaveBeenCalled();
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: { logo: {} } });

    useCommandStore.getState().undo();
    await flushStructuralCommandPersistence();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[1]?.[1]).toMatchObject({
      assetTransition: { kind: 'trash', projectRelativePaths: [asset.projectRelativePath] },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: {} });

    useCommandStore.getState().redo();
    await flushStructuralCommandPersistence();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[2]?.[1]).toMatchObject({
      assetTransition: { kind: 'restore', moves: [move] },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: { logo: {} } });
  });

  it('adopts unrelated authoritative disk changes returned by a successful structural commit', async () => {
    const project = projectWithRoom();
    const authoritative = projectWithRoom();
    authoritative.rooms.foyer!.label = 'External Foyer';
    authoritative.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    vi.mocked(window.noveltea.saveProjectContent).mockResolvedValueOnce({
      ok: true,
      success: true,
      diagnostics: [],
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
      fileRevisions: {
        'records/rooms/foyer.json': `sha256:${'e'.repeat(64)}`,
        'records/rooms/hall.json': `sha256:${'f'.repeat(64)}`,
      },
      externalValueByPath: {
        '/rooms/foyer/label': { exists: true, value: 'External Foyer' },
      },
      editorState: emptyEditorProjectState(),
      scriptSourcePaths: {},
    });
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      savedDocument: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    const result = useCommandStore.getState().executeCommand({
      type: 'entity.createRecord',
      label: 'Create hall',
      payload: { collection: 'rooms', entityId: 'hall', label: 'Hall' },
      originSaveUnitId: 'workflow:new-entity',
      persistencePolicy: 'auto-commit',
    });
    expect(result.ok).toBe(true);
    await flushStructuralCommandPersistence();

    const state = useProjectStore.getState();
    expect(state.document).toMatchObject({
      rooms: {
        foyer: { label: 'External Foyer' },
        hall: { label: 'Hall' },
      },
    });
    expect(state.savedDocument).toMatchObject({
      rooms: {
        foyer: { label: 'External Foyer' },
        hall: { label: 'Hall' },
      },
    });
  });

  it('moves copied import files to project trash when the content write fails', async () => {
    const project = createAuthoringProject();
    const asset = importedImage();
    const move = {
      projectRelativePath: asset.projectRelativePath,
      trashRelativePath: '.noveltea/trash/assets/failed/assets/images/logo.png',
    };
    vi.mocked(window.noveltea.saveProjectContent).mockResolvedValueOnce({
      ok: false,
      success: false,
      error: 'write failed',
      diagnostics: [],
    });
    vi.mocked(window.noveltea.trashProjectAssetFiles).mockResolvedValueOnce({
      ok: true,
      success: true,
      moved: [move],
      diagnostics: [],
    });
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    useCommandStore.getState().executeCommand({
      type: 'asset.importFiles',
      label: 'Import logo',
      payload: { assets: [asset], fileOrigin: 'copied-by-import' },
      originSaveUnitId: 'workflow:asset-import',
      persistencePolicy: 'auto-commit',
    });
    await flushStructuralCommandPersistence();

    expect(window.noveltea.trashProjectAssetFiles).toHaveBeenCalledWith('test-project-session', [
      asset.projectRelativePath,
    ]);
    expect(useProjectStore.getState().document).toMatchObject({ assets: {} });
    expect(useCommandStore.getState().history.entries).toEqual([]);
  });

  it('coordinates asset deletion files across persisted forward, Undo, and Redo', async () => {
    const project = createAuthoringProject();
    const asset = importedImage();
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: assetDataFromImportMetadata(asset),
    };
    const firstMove = {
      projectRelativePath: asset.projectRelativePath,
      trashRelativePath: '.noveltea/trash/assets/delete-1/assets/images/logo.png',
    };
    const secondMove = {
      projectRelativePath: asset.projectRelativePath,
      trashRelativePath: '.noveltea/trash/assets/delete-2/assets/images/logo.png',
    };
    vi.mocked(window.noveltea.trashProjectAssetFiles)
      .mockResolvedValueOnce({
        ok: true,
        success: true,
        moved: [firstMove],
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        success: true,
        moved: [secondMove],
        diagnostics: [],
      });
    vi.mocked(window.noveltea.restoreProjectAssetFiles).mockResolvedValueOnce({
      ok: true,
      success: true,
      restored: [firstMove],
      diagnostics: [],
    });
    vi.mocked(window.noveltea.saveProjectContent)
      .mockResolvedValueOnce({
        ok: true,
        success: true,
        diagnostics: [],
        assetTrashMoves: [firstMove],
      })
      .mockResolvedValueOnce({ ok: true, success: true, diagnostics: [] })
      .mockResolvedValueOnce({
        ok: true,
        success: true,
        diagnostics: [],
        assetTrashMoves: [secondMove],
      });
    await loadProjectDocumentWithGraph({
      document: toJsonValue(project),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    useCommandStore.getState().executeCommand({
      type: 'asset.deleteAsset',
      label: 'Delete logo',
      payload: { assetId: 'logo', force: true },
      originSaveUnitId: 'structure:assets',
      persistencePolicy: 'auto-commit',
    });
    await flushStructuralCommandPersistence();
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: {} });

    useCommandStore.getState().undo();
    await flushStructuralCommandPersistence();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[1]?.[1]).toMatchObject({
      assetTransition: { kind: 'restore', moves: [firstMove] },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: { logo: {} } });

    useCommandStore.getState().redo();
    await flushStructuralCommandPersistence();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[2]?.[1]).toMatchObject({
      assetTransition: { kind: 'trash', projectRelativePaths: [asset.projectRelativePath] },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: {} });
  });
});
