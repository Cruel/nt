import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  buildAutoCommitPlan,
  remapRecoveryForAutoCommit,
  STRUCTURAL_AUTO_COMMIT_RULES,
  structuralRuleForTests,
} from '@/project/structural-command-persistence';
import { flushStructuralCommandPersistence, useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { setLoadedEditorProjectState } from '@/workbench/project-editor-state';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { toJsonValue } from '@/project/json-value';
import type { ImportedAssetMetadata } from '../../shared/asset-import';

const fingerprint = '0'.repeat(64);

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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.getState().clearProject();
  useWorkbenchStore.getState().resetWorkbench();
  useDraftDirtyStore.getState().resetDraftDirty();
  useCommandStore.getState().resetCommandHistory();
  setLoadedEditorProjectState(emptyEditorProjectState(fingerprint));
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

  it('persists structural forward, Undo, and Redo to the saved baseline', async () => {
    const project = projectWithRoom();
    useProjectStore.getState().loadProjectDocument({
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

  it('does not delete pre-existing or generated files when imported asset content is undone', async () => {
    const project = createAuthoringProject();
    useProjectStore.getState().loadProjectDocument({
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
    useProjectStore.getState().loadProjectDocument({
      document: toJsonValue(saved),
      savedDocument: toJsonValue(saved),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    setLoadedEditorProjectState({
      ...emptyEditorProjectState(fingerprint),
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'record:rooms:kitchen': {
            sequence: 1,
            patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'Dirty Kitchen' }],
            affectedPaths: ['/rooms/kitchen'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        },
      },
    });

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
    const persistedEditor = vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[3];
    expect(persistedEditor?.recovery.saveUnitsById).toHaveProperty('record:rooms:kitchen');
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

  it('rejects and rolls back a declared reject-command overlap with dirty recovery', async () => {
    const saved = projectWithRoom();
    const working = projectWithRoom();
    working.rooms.foyer!.label = 'Dirty Foyer';
    useProjectStore.getState().loadProjectDocument({
      document: toJsonValue(saved),
      savedDocument: toJsonValue(saved),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    setLoadedEditorProjectState({
      ...emptyEditorProjectState(fingerprint),
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

    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Dirty Foyer' } },
    });
    expect(useCommandStore.getState().history.entries).toEqual([]);
    expect(useCommandStore.getState().lastDiagnostics[0]?.message).toContain(
      'cannot be rebased safely',
    );
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
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
    useProjectStore.getState().loadProjectDocument({
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
    expect(window.noveltea.trashProjectAssetFiles).toHaveBeenCalledWith('/mock/project/game.json', [
      asset.projectRelativePath,
    ]);
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: {} });

    useCommandStore.getState().redo();
    await flushStructuralCommandPersistence();
    expect(window.noveltea.restoreProjectAssetFiles).toHaveBeenCalledWith(
      '/mock/project/game.json',
      [move],
    );
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: { logo: {} } });
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
    useProjectStore.getState().loadProjectDocument({
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

    expect(window.noveltea.trashProjectAssetFiles).toHaveBeenCalledWith('/mock/project/game.json', [
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
    useProjectStore.getState().loadProjectDocument({
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
    expect(window.noveltea.restoreProjectAssetFiles).toHaveBeenCalledWith(
      '/mock/project/game.json',
      [firstMove],
    );
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: { logo: {} } });

    useCommandStore.getState().redo();
    await flushStructuralCommandPersistence();
    expect(window.noveltea.trashProjectAssetFiles).toHaveBeenLastCalledWith(
      '/mock/project/game.json',
      [asset.projectRelativePath],
    );
    expect(useProjectStore.getState().savedDocument).toMatchObject({ assets: {} });
  });
});
