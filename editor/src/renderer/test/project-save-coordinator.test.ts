import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  resolveExternalConflictUseDisk,
  saveActiveSaveUnit,
  saveAllSaveUnits,
  saveConflictingSaveUnitKeepMine,
  saveProjectAsCopy,
} from '@/project/project-save-coordinator';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useCommandStore } from '@/commands/command-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import {
  buildEditorProjectStateSnapshot,
  setLoadedEditorProjectState,
  mergeEditorProjectState,
} from '@/workbench/project-editor-state';
import {
  emptyEditorProjectState,
  type EditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { toJsonValue } from '@/project/json-value';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import {
  buildPlatformExportProfilesTab,
  buildProjectSettingsTab,
} from '@/workbench/editor-registry';

const workspaceRevision = `sha256:${'a'.repeat(64)}` as const;
const roomFileRevision = `sha256:${'b'.repeat(64)}` as const;

function roomTab(roomId: string): WorkbenchTab {
  return {
    id: `tab:rooms:${roomId}`,
    title: roomId,
    editorType: 'room-detail',
    resource: {
      kind: 'record',
      stableId: `record:rooms:${roomId}`,
      collection: 'rooms',
      entityId: roomId,
    },
  };
}

function projectWithRooms() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  project.rooms.kitchen = {
    id: 'kitchen',
    label: 'Kitchen',
    data: defaultRoomData('Kitchen'),
  };
  return project;
}

function recoveryState(
  entries: EditorProjectState['recovery']['saveUnitsById'],
): EditorProjectState {
  return {
    ...emptyEditorProjectState(),
    recovery: { sequence: Object.keys(entries).length, saveUnitsById: entries },
  };
}

function loadProject(
  savedProject: ReturnType<typeof projectWithRooms>,
  workingProject: ReturnType<typeof projectWithRooms>,
  editorState: EditorProjectState,
) {
  const saved = mergeEditorProjectState(toJsonValue(savedProject), editorState);
  useProjectStore.getState().loadProjectDocument({
    document: saved,
    savedDocument: saved,
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/game.json',
    workspaceRevision,
    fileRevisions: { 'records/rooms/foyer.json': roomFileRevision },
  });
  useProjectStore
    .getState()
    .replaceDocumentFromCommand(
      mergeEditorProjectState(toJsonValue(workingProject), editorState),
      0,
    );
  setLoadedEditorProjectState(editorState);
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.getState().clearProject();
  useWorkbenchStore.getState().resetWorkbench();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  setLoadedEditorProjectState(emptyEditorProjectState());
});

describe('project save coordinator', () => {
  it('saves platform export profile edits from the Export Profiles tab', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    loadProject(saved, working, emptyEditorProjectState());

    const command = useCommandStore.getState().executeCommand({
      type: 'project.addAtPath',
      label: 'Add platform export profiles',
      payload: {
        path: '/settings/platformExport',
        value: { selectedProfileId: null, profiles: [] },
      },
      originSaveUnitId: 'project:platform-export-profiles',
      persistencePolicy: 'manual-save',
    });
    expect(command.ok).toBe(true);
    useWorkbenchStore.getState().openTab(buildPlatformExportProfilesTab());

    const result = await saveActiveSaveUnit();

    expect(result.success).toBe(true);
    expect(result.savedSaveUnitIds).toContain('project:platform-export-profiles');
    expect(window.noveltea.saveProjectContent).toHaveBeenCalledOnce();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[2]).toMatchObject({
      settings: { platformExport: { selectedProfileId: null, profiles: [] } },
    });
  });

  it('saves only the active unit and rebases the remaining recovery overlay', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'New Foyer';
    working.rooms.kitchen!.label = 'New Kitchen';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'New Kitchen' }],
        affectedPaths: ['/rooms/kitchen'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useWorkbenchStore.getState().openTab(roomTab('foyer'));

    const result = await saveActiveSaveUnit();

    expect(result).toMatchObject({
      success: true,
      status: 'partially-saved',
      savedSaveUnitIds: ['record:rooms:foyer'],
      remainingDirtySaveUnitIds: ['record:rooms:kitchen'],
    });
    expect(window.noveltea.saveProjectContent).toHaveBeenCalledOnce();
    const [, , candidate, persistedEditor] = vi.mocked(window.noveltea.saveProjectContent).mock
      .calls[0]!;
    expect(candidate).toMatchObject({
      rooms: {
        foyer: { label: 'New Foyer' },
        kitchen: { label: 'Kitchen' },
      },
    });
    expect(persistedEditor.recovery.saveUnitsById).toHaveProperty('record:rooms:kitchen');
    expect(persistedEditor.recovery.saveUnitsById).not.toHaveProperty('record:rooms:foyer');
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: {
        foyer: { label: 'New Foyer' },
        kitchen: { label: 'New Kitchen' },
      },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: {
        foyer: { label: 'New Foyer' },
        kitchen: { label: 'Kitchen' },
      },
    });
  });

  it('saves selected tracked editor.json content without marking unrelated tracked editor content saved', async () => {
    const saved = projectWithRooms();
    saved.editor.tags.records.story = { name: 'Story', color: 'tag-slate' };
    saved.editor.recordMetadata.rooms = { foyer: { tags: [], color: null } };
    const working = structuredClone(saved);
    working.editor.tags.records.story!.color = 'tag-blue';
    working.editor.recordMetadata.rooms!.foyer!.tags = ['dirty'];
    const recovery = recoveryState({
      'project:tags': {
        sequence: 1,
        patches: [
          {
            op: 'replace',
            path: '/editor/tags/records/story/color',
            value: 'tag-blue',
          },
        ],
        affectedPaths: ['/editor/tags/records/story/color'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:foyer': {
        sequence: 2,
        patches: [
          {
            op: 'replace',
            path: '/editor/recordMetadata/rooms/foyer/tags',
            value: ['dirty'],
          },
        ],
        affectedPaths: ['/editor/recordMetadata/rooms/foyer/tags'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    const savedEditor = {
      ...recovery,
      chapters: saved.editor.chapters,
      tags: saved.editor.tags,
      recordMetadata: saved.editor.recordMetadata,
    };
    const workingEditor = {
      ...recovery,
      chapters: working.editor.chapters,
      tags: working.editor.tags,
      recordMetadata: working.editor.recordMetadata,
    };
    const savedDocument = mergeEditorProjectState(toJsonValue(saved), savedEditor);
    const workingDocument = mergeEditorProjectState(toJsonValue(working), workingEditor);
    useProjectStore.getState().loadProjectDocument({
      document: savedDocument,
      savedDocument,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      workspaceRevision,
      fileRevisions: { 'editor.json': roomFileRevision },
    });
    useProjectStore.getState().replaceDocumentFromCommand(workingDocument, 0);
    setLoadedEditorProjectState(workingEditor);

    const result = await saveActiveSaveUnit('project:tags');

    expect(result.success).toBe(true);
    const state = useProjectStore.getState();
    expect((state.savedDocument as typeof working).editor.tags.records.story?.color).toBe(
      'tag-blue',
    );
    expect(
      (state.savedDocument as typeof working).editor.recordMetadata.rooms?.foyer?.tags,
    ).toEqual([]);
    expect((state.document as typeof working).editor.recordMetadata.rooms?.foyer?.tags).toEqual([
      'dirty',
    ]);
    expect(result.remainingDirtySaveUnitIds).toContain('record:rooms:foyer');
  });

  it('reconciles unrelated external changes returned by a successful scoped save before adopting its revisions', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Local Foyer';
    working.rooms.kitchen!.label = 'Local Kitchen';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Local Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'Local Kitchen' }],
        affectedPaths: ['/rooms/kitchen/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useWorkbenchStore.getState().openTab(roomTab('foyer'));
    const diskAfterSave = projectWithRooms();
    diskAfterSave.rooms.foyer!.label = 'Local Foyer';
    diskAfterSave.rooms.kitchen!.label = 'Disk Kitchen';
    const diskRevision = `sha256:${'d'.repeat(64)}` as const;
    vi.mocked(window.noveltea.saveProjectContent).mockResolvedValueOnce({
      ok: true,
      success: true,
      diagnostics: [],
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      workspaceRevision: diskRevision,
      fileRevisions: {
        'records/rooms/foyer.json': `sha256:${'e'.repeat(64)}`,
        'records/rooms/kitchen.json': `sha256:${'f'.repeat(64)}`,
      },
      contentProject: diskAfterSave,
      editorState: emptyEditorProjectState(),
      scriptSourcePaths: {},
    });

    const result = await saveActiveSaveUnit();

    expect(result).toMatchObject({
      success: true,
      status: 'partially-saved',
      savedSaveUnitIds: ['record:rooms:foyer'],
      remainingDirtySaveUnitIds: ['record:rooms:kitchen'],
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'editor.external-change.conflict', severity: 'error' }),
    );
    const state = useProjectStore.getState();
    expect(state.workspaceRevision).toBe(diskRevision);
    expect(state.document).toMatchObject({
      rooms: {
        foyer: { label: 'Local Foyer' },
        kitchen: { label: 'Local Kitchen' },
      },
    });
    expect(state.savedDocument).toMatchObject({
      rooms: {
        foyer: { label: 'Local Foyer' },
        kitchen: { label: 'Disk Kitchen' },
      },
    });
    expect(
      buildEditorProjectStateSnapshot().recovery.saveUnitsById['record:rooms:kitchen']
        ?.externalConflict,
    ).toMatchObject({
      conflictingPaths: ['/rooms/kitchen/label'],
      externalWorkspaceRevision: diskRevision,
    });
  });

  it('blocks a save unit with pending invalid raw input without writing', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'New Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {
          '/rooms/foyer/data/zoom': { value: 'not-a-number' },
        },
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useWorkbenchStore.getState().openTab(roomTab('foyer'));

    const result = await saveActiveSaveUnit();

    expect(result.status).toBe('blocked');
    expect(result.diagnostics[0]).toMatchObject({ code: 'editor.save.pending-input' });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
  });

  it('blocks ordinary Save for an external conflict and Keep Mine writes against the external revision', async () => {
    const saved = projectWithRooms();
    saved.rooms.foyer!.label = 'Disk Foyer';
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Local Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Local Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
        externalConflict: {
          baseValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Foyer' },
          },
          localValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Local Foyer' },
          },
          externalValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Disk Foyer' },
          },
          conflictingPaths: ['/rooms/foyer/label'],
          externalWorkspaceRevision: workspaceRevision,
          externalFileRevisions: { 'records/rooms/foyer.json': roomFileRevision },
        },
      },
    });
    loadProject(saved, working, editorState);
    useWorkbenchStore.getState().openTab(roomTab('foyer'));

    const blocked = await saveActiveSaveUnit();
    expect(blocked).toMatchObject({ success: false, status: 'blocked' });
    expect(blocked.diagnostics[0]).toMatchObject({ code: 'editor.external-change.conflict' });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();

    const resolved = await saveConflictingSaveUnitKeepMine('record:rooms:foyer');
    expect(resolved.success).toBe(true);
    expect(window.noveltea.saveProjectContent).toHaveBeenCalledOnce();
    const [projectFilePath, expectedRevision, candidate, , , commitOptions] = vi.mocked(
      window.noveltea.saveProjectContent,
    ).mock.calls[0]!;
    expect(projectFilePath).toBe('/mock/project/game.json');
    expect(expectedRevision).toBe(workspaceRevision);
    expect(candidate).toMatchObject({ rooms: { foyer: { label: 'Local Foyer' } } });
    expect(commitOptions?.expectedFileRevisions).toEqual({
      'records/rooms/foyer.json': roomFileRevision,
    });
  });

  it('keeps the unit conflicted when Keep Mine loses its expected-revision race', async () => {
    const saved = projectWithRooms();
    saved.rooms.foyer!.label = 'Disk Foyer';
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Local Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Local Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
        externalConflict: {
          baseValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Foyer' },
          },
          localValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Local Foyer' },
          },
          externalValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Disk Foyer' },
          },
          conflictingPaths: ['/rooms/foyer/label'],
          externalWorkspaceRevision: workspaceRevision,
          externalFileRevisions: { 'records/rooms/foyer.json': roomFileRevision },
        },
      },
    });
    loadProject(saved, working, editorState);
    vi.mocked(window.noveltea.saveProjectContent).mockResolvedValueOnce({
      ok: false,
      success: false,
      error: 'Project source changed on disk before this save could commit.',
      diagnostics: [
        {
          code: 'WORKSPACE_REVISION_CONFLICT',
          severity: 'error',
          path: '/records/rooms/foyer.json',
          message: 'Project source changed on disk before this save could commit.',
        },
      ],
    });

    const result = await saveConflictingSaveUnitKeepMine('record:rooms:foyer');

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Local Foyer' } },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { foyer: { label: 'Disk Foyer' } },
    });
    expect(
      useProjectStore.getState().document &&
        (useProjectStore.getState().document as { editor?: EditorProjectState }).editor?.recovery
          .saveUnitsById['record:rooms:foyer']?.externalConflict,
    ).toBeDefined();
  });

  it('Use Disk discards only the conflicted save unit and keeps the external baseline', () => {
    const saved = projectWithRooms();
    saved.rooms.foyer!.label = 'Disk Foyer';
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Local Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Local Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
        externalConflict: {
          baseValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Foyer' },
          },
          localValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Local Foyer' },
          },
          externalValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Disk Foyer' },
          },
          conflictingPaths: ['/rooms/foyer/label'],
          externalWorkspaceRevision: workspaceRevision,
          externalFileRevisions: { 'records/rooms/foyer.json': roomFileRevision },
        },
      },
    });
    loadProject(saved, working, editorState);

    expect(resolveExternalConflictUseDisk('record:rooms:foyer')).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Disk Foyer' } },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { foyer: { label: 'Disk Foyer' } },
    });
    expect(
      useProjectStore.getState().document &&
        (useProjectStore.getState().document as { editor?: EditorProjectState }).editor?.recovery
          .saveUnitsById,
    ).not.toHaveProperty('record:rooms:foyer');
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
  });

  it('ignores unchanged baseline authoring errors owned by an unrelated save unit', async () => {
    const saved = projectWithRooms();
    saved.rooms.kitchen!.label = '';
    const working = projectWithRooms();
    working.rooms.kitchen!.label = '';
    working.rooms.foyer!.label = 'New Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useWorkbenchStore.getState().openTab(roomTab('foyer'));

    const result = await saveActiveSaveUnit();

    expect(result.status).toBe('saved');
    expect(window.noveltea.saveProjectContent).toHaveBeenCalledOnce();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[2]).toMatchObject({
      rooms: {
        foyer: { label: 'New Foyer' },
        kitchen: { label: '' },
      },
    });
  });

  it('blocks active Save when its candidate requires an independently dirty dependency', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.entrypoint = { kind: 'room', id: 'hall' };
    working.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    const editorState = recoveryState({
      'project:settings': {
        sequence: 1,
        patches: [{ op: 'add', path: '/entrypoint', value: { kind: 'room', id: 'hall' } }],
        affectedPaths: ['/entrypoint'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:hall': {
        sequence: 2,
        patches: [
          {
            op: 'add',
            path: '/rooms/hall',
            value: toJsonValue(working.rooms.hall),
          },
        ],
        affectedPaths: ['/rooms/hall'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useWorkbenchStore.getState().openTab(buildProjectSettingsTab());

    const result = await saveActiveSaveUnit();

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      dependencySaveUnitIds: ['record:rooms:hall'],
    });
    expect(result.diagnostics[0]).toMatchObject({
      code: 'editor.save.dependency-dirty',
      ownerPaths: ['/rooms/hall'],
    });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
  });

  it('commits every member of the active atomic transaction group together', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'New Foyer';
    working.rooms.kitchen!.label = 'New Kitchen';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: ['atomic:shared'],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'New Kitchen' }],
        affectedPaths: ['/rooms/kitchen'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: ['atomic:shared'],
      },
    });
    loadProject(saved, working, editorState);
    useWorkbenchStore.getState().openTab(roomTab('foyer'));

    const result = await saveActiveSaveUnit();

    expect(result).toMatchObject({
      success: true,
      status: 'saved',
      savedSaveUnitIds: ['record:rooms:foyer', 'record:rooms:kitchen'],
    });
    expect(window.noveltea.saveProjectContent).toHaveBeenCalledOnce();
  });

  it('saves the maximal valid Save All subset in one write', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'New Foyer';
    working.rooms.kitchen!.label = 'New Kitchen';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'New Kitchen' }],
        affectedPaths: ['/rooms/kitchen'],
        pendingRawInputByPath: {
          '/rooms/kitchen/data/zoom': { value: 'invalid' },
        },
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);

    const result = await saveAllSaveUnits();

    expect(result).toMatchObject({
      success: true,
      status: 'partially-saved',
      savedSaveUnitIds: ['record:rooms:foyer'],
      remainingDirtySaveUnitIds: ['record:rooms:kitchen'],
    });
    expect(window.noveltea.saveProjectContent).toHaveBeenCalledOnce();
  });

  it('combines dirty dependency components during Save All', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.entrypoint = { kind: 'room', id: 'hall' };
    working.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    const editorState = recoveryState({
      'project:settings': {
        sequence: 1,
        patches: [{ op: 'add', path: '/entrypoint', value: { kind: 'room', id: 'hall' } }],
        affectedPaths: ['/entrypoint'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:hall': {
        sequence: 2,
        patches: [
          {
            op: 'add',
            path: '/rooms/hall',
            value: toJsonValue(working.rooms.hall),
          },
        ],
        affectedPaths: ['/rooms/hall'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);

    const result = await saveAllSaveUnits();

    expect(result).toMatchObject({
      success: true,
      status: 'saved',
      savedSaveUnitIds: ['project:settings', 'record:rooms:hall'],
      remainingDirtySaveUnitIds: [],
    });
    expect(window.noveltea.saveProjectContent).toHaveBeenCalledOnce();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[2]).toMatchObject({
      entrypoint: { kind: 'room', id: 'hall' },
      rooms: { hall: { id: 'hall' } },
    });
  });

  it('Save As copies the saved baseline plus complete recovery without changing identity', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Dirty Foyer';
    working.assets.cover = {
      id: 'cover',
      label: 'Cover',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/cover.png' },
        aliases: [],
        extension: '.png',
        imageMetadata: { width: 1280, height: 720, hasAlpha: true, orientation: 1 },
      },
    };
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Dirty Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:assets:cover': {
        sequence: 2,
        patches: [
          {
            op: 'add',
            path: '/assets/cover',
            value: toJsonValue(working.assets.cover),
          },
        ],
        affectedPaths: ['/assets/cover'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);

    const result = await saveProjectAsCopy();

    expect(result.success).toBe(true);
    const [copy, defaultPath, currentPath, workingAssetPaths] = vi.mocked(
      window.noveltea.saveProjectCopyAs,
    ).mock.calls[0]!;
    expect(copy).toMatchObject({
      rooms: { foyer: { label: 'Foyer' } },
      editor: {
        recovery: { saveUnitsById: { 'record:rooms:foyer': expect.any(Object) } },
      },
    });
    expect(defaultPath).toBe('/mock/project/game.json');
    expect(currentPath).toBe('/mock/project/game.json');
    expect(workingAssetPaths).toEqual(['assets/images/cover.png']);
    expect(useProjectStore.getState().projectFilePath).toBe('/mock/project/game.json');
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Dirty Foyer' } },
    });
  });
});
