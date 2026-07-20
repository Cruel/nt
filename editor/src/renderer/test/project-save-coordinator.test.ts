import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  saveActiveSaveUnit,
  saveAllSaveUnits,
  saveProjectAsCopy,
} from '@/project/project-save-coordinator';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useCommandStore } from '@/commands/command-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import {
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
import { buildProjectSettingsTab } from '@/workbench/editor-registry';

const fingerprint = '0'.repeat(64);

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
    ...emptyEditorProjectState(fingerprint),
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
  setLoadedEditorProjectState(emptyEditorProjectState(fingerprint));
});

describe('project save coordinator', () => {
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
